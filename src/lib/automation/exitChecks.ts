import "server-only";
import { getLastTick } from "@/lib/marketData/tickStore";
import { botsStore, ordersStore, positionsStore } from "./store";
import { withBotLock } from "./botLock";
import { botDisplayName, getBotStaticConfig, listBotIds } from "./bots";
import { CLOSE_CONFIRM_TIMEOUT_SECONDS, isDryRun } from "./config";
import { logDecision } from "./decisions";
import { recordError } from "./errors";
import { applyClosePricing, closePosition, closeTitle, pricingFor, spreadOf } from "./engine";
import type { ExitOptions } from "./openSettings";
import { RunRecorder, describeLegs } from "./runTrace";
import type { ClosePricing } from "./closePricing";
import { nyseCalendarDay } from "@/lib/nyseCalendar";
import { activePositionsForBot } from "./safeguards";
import { sharedExecutor } from "./sharedExecutor";
import { spreadMarket } from "./smartPricing";
import { easternDateKey, easternMinutesOfDay, hoursConfigFor, isWithinTradingHours } from "./tradingHours";
import type { BrokerExecutor, Position } from "./types";

/**
 * Exit Options, as Option Alpha's Open step has them: once a position is open, the bot looks at it every minute and closes it when
 * profit taking, stop loss or touch is met. Each position keeps the exit options it was opened with.
 *
 *  - From 9:31am to one minute before the market closes (the NYSE early-close days included), weekdays, never on a holiday.
 *  - Profit and loss are worked out from the spread's mid price (what it would cost to buy back at the middle). Without a quote
 *    for the spread (the mock executor has none) those can't be judged and are not acted on; touch uses the live underlying price.
 *  - It only acts on an `open` position the bot opened itself, with no close already working: one close per position, never a second.
 *  - The kill switch stops it. The bot being off does not: a stop loss must still work.
 *  - Closing uses the bot's own close pricing; a failed close is an error, flags the bot, and stops there. Dry run only says what it would do.
 */

const WINDOW = { start: "09:31", end: "15:59" };
const PRICE_MAX_AGE_MS = 5 * 60_000;

export type ExitReason = { kind: "profit_percent" | "profit_dollars" | "stop_percent" | "stop_loss_dollars" | "touch" | "expiration"; text: string };

export interface ExitReading {
  /** The spread's mid price to buy it back at, when there is a quote. */
  debit: number | null;
  /** The underlying's price, when there is a fresh one. */
  underlying: number | null;
  /** Minutes until the market closes, when the position expires today; null otherwise (it doesn't expire today, or the clock isn't known). */
  minutesToClose?: number | null;
}

/** Minutes from `now` to the close of the market that day (1:00pm on an early-close day, else 4:00pm), New York time. */
export function minutesToMarketClose(now: number): number {
  const close = nyseCalendarDay(now).status === "early-close" ? 13 * 60 : 16 * 60;
  return close - easternMinutesOfDay(now);
}

/** Which exit option (if any) is met by this reading. Pure: the same inputs always give the same answer. */
export function exitMet(position: Pick<Position, "type" | "shortStrike" | "credit" | "filledQuantity" | "requestedQuantity">, options: ExitOptions, reading: ExitReading): ExitReason | null {
  const credit = position.credit;
  const quantity = position.filledQuantity || position.requestedQuantity;
  if (credit != null && credit > 0 && reading.debit != null && Number.isFinite(reading.debit)) {
    const perSpread = credit - reading.debit; // positive = profit
    const percent = (perSpread / credit) * 100;
    const dollars = perSpread * 100 * quantity;
    if (options.profitPercent !== undefined && percent >= options.profitPercent) return { kind: "profit_percent", text: `Profit ${round(percent)}% of the credit, at or above the ${options.profitPercent}% profit target` };
    if (options.profitDollars !== undefined && dollars >= options.profitDollars) return { kind: "profit_dollars", text: `Profit $${round(dollars)}, at or above the $${options.profitDollars} profit target` };
    if (options.stopPercent !== undefined && -percent >= options.stopPercent) return { kind: "stop_percent", text: `Loss ${round(-percent)}% of the credit, at or above the ${options.stopPercent}% stop loss` };
    if (options.stopDollars !== undefined && -dollars >= options.stopDollars) return { kind: "stop_loss_dollars", text: `Loss $${round(-dollars)}, at or above the $${options.stopDollars} stop loss` };
  }
  if (options.touchPoints !== undefined && reading.underlying != null && Number.isFinite(reading.underlying)) {
    const distance = position.type === "short_put_spread" ? reading.underlying - position.shortStrike : position.shortStrike - reading.underlying;
    if (distance <= options.touchPoints) return { kind: "touch", text: `The underlying (${reading.underlying}) is ${round(distance)} points from the short strike ${position.shortStrike}, within the ${options.touchPoints} touch distance` };
  }
  if (options.expirationMinutes !== undefined && reading.minutesToClose != null && Number.isFinite(reading.minutesToClose) && reading.minutesToClose <= options.expirationMinutes) {
    return { kind: "expiration", text: `The market closes in ${Math.max(0, Math.round(reading.minutesToClose))} minute${Math.round(reading.minutesToClose) === 1 ? "" : "s"}, within the ${options.expirationMinutes}-minute expiration exit` };
  }
  return null;
}

const round = (n: number) => Math.round(n * 100) / 100;

export interface ExitCheckResult {
  botId: string;
  skipped?: "kill_switch" | "not_set_up" | "outside_hours" | "nothing_to_check";
  closed: number;
  wouldClose: number;
  failed: number;
}

export interface ExitCheckOptions {
  executor?: BrokerExecutor;
  dryRun?: boolean;
  closeConfirmTimeoutMs?: number;
  pollIntervalMs?: number;
  ladderStepMs?: number;
}

/** One look at one bot's positions. Quiet when there is nothing to do: it writes a log row and a run only when it acts. */
export function runExitChecks(botId: string, now: number = Date.now(), options: ExitCheckOptions = {}): Promise<ExitCheckResult> {
  return withBotLock(botId, async () => {
    const result: ExitCheckResult = { botId, closed: 0, wouldClose: 0, failed: 0 };
    const bot = botsStore.get(botId);
    if (!bot) return { ...result, skipped: "nothing_to_check" };
    if (bot.killSwitch) return { ...result, skipped: "kill_switch" };
    let config;
    try {
      config = getBotStaticConfig(botId);
    } catch {
      return { ...result, skipped: "not_set_up" };
    }
    if (!isWithinTradingHours(now, hoursConfigFor(WINDOW))) return { ...result, skipped: "outside_hours" };

    const candidates = activePositionsForBot(botId).filter(
      (p) => p.status === "open" && !p.manual && p.exitOptions && Object.keys(p.exitOptions).length > 0 && ordersStore.query((o) => o.positionId === p.id && o.kind === "close" && (o.status === "working" || o.status === "partially_filled")).length === 0,
    );
    if (candidates.length === 0) return { ...result, skipped: "nothing_to_check" };

    const executor = options.executor ?? sharedExecutor;
    const dryRun = options.dryRun ?? isDryRun();
    const closeTimeoutMs = options.closeConfirmTimeoutMs ?? CLOSE_CONFIRM_TIMEOUT_SECONDS * 1000;

    for (const position of candidates) {
      const exit = position.exitOptions!;
      const reading: ExitReading = { debit: null, underlying: null, minutesToClose: position.expiry === easternDateKey(now) ? minutesToMarketClose(now) : null };
      const needsQuote = exit.profitPercent !== undefined || exit.profitDollars !== undefined || exit.stopPercent !== undefined || exit.stopDollars !== undefined;
      if (needsQuote && executor.getSpreadQuote) {
        try {
          const legs = await executor.getSpreadQuote(spreadOf(position));
          const market = legs ? spreadMarket("debit", legs) : null;
          reading.debit = market ? market.mid : null;
        } catch {
          reading.debit = null; // a quote that fails is not a reason to close
        }
      }
      if (exit.touchPoints !== undefined) {
        const tick = getLastTick(position.underlying);
        if (tick && now - tick.t <= PRICE_MAX_AGE_MS && Number.isFinite(tick.price)) reading.underlying = tick.price;
      }
      const met = exitMet(position, exit, reading);
      if (!met) continue;

      const rec = new RunRecorder({ botId, signalId: null, source: "monitor", automation: "Exit options", trigger: "Exit options", startedAt: now });
      const log = (outcome: "exit_closed" | "executor_error" | "close_rejected" | "close_timeout" | "close_partial_fill" | "dry_run", reason: string) =>
        logDecision({ signalId: null, botId, outcome, reason, detail: { exit: met.kind, positionId: position.id }, now });
      try {
        rec.decision(`An exit option is met on ${describeLegs(position)}`, true, met.text);
        if (dryRun) {
          result.wouldClose++;
          rec.action({ action: "close", title: closeTitle(position), position, params: [{ label: "Why", value: met.text }], outcome: "dry_run", reason: "Dry run: would close; nothing sent." });
          log("dry_run", `Dry run: exit options would close ${describeLegs(position)}: ${met.text}.`);
          continue;
        }
        // The expiration exit is the last chance before the close: it goes at market, whatever the bot's usual close pricing is.
        const ownPricing: ClosePricing | undefined = met.kind === "expiration" ? { speed: "market" } : bot.closeSettings?.[position.type === "short_put_spread" ? "bearish" : "bullish"]?.pricing;
        const pricing = applyClosePricing(pricingFor(config, "close", options.ladderStepMs), ownPricing);
        const closed = await closePosition(position, { id: null, price: reading.underlying }, executor, closeTimeoutMs, options.pollIntervalMs ?? 1000, now, pricing, undefined, { chase: true });
        rec.action({ action: "close", title: closeTitle(position), position: positionsStore.get(position.id) ?? position, params: [{ label: "Why", value: met.text }], steps: closed.steps, outcome: closed.outcome, reason: closed.reason });
        if (closed.ok) {
          result.closed++;
          log("exit_closed", `Exit options closed ${describeLegs(position)}: ${met.text}.`);
        } else {
          result.failed++;
          recordError(botId, "close_failed", { positionId: position.id, reason: closed.reason, exit: met.kind }, now);
          botsStore.update(botId, { needsAttention: true, needsAttentionReason: `Exit options: ${closed.reason}` });
          log(closed.outcome as "executor_error", `Exit options: ${closed.reason}`);
        }
      } finally {
        rec.save();
      }
    }
    return result;
  });
}

/** Every bot, once. Called each minute by the scheduler. */
export async function runDueExitChecks(now: number = Date.now(), options: ExitCheckOptions = {}): Promise<ExitCheckResult[]> {
  const results: ExitCheckResult[] = [];
  for (const botId of listBotIds()) {
    try {
      results.push(await runExitChecks(botId, now, options));
    } catch (err) {
      console.error(`[automation] exit options failed for ${botDisplayName(botId)}`, err);
    }
  }
  return results;
}
