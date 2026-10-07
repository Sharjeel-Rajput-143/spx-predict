import "server-only";
import { botsStore, decisionsStore, ordersStore, positionsStore, signalsStore } from "./store";
import { withBotLock } from "./botLock";
import { botDisplayName, getBotStaticConfig, listBotIds } from "./bots";
import { CLOSE_CONFIRM_TIMEOUT_SECONDS, ORDER_POLL_INTERVAL_MS, isDryRun } from "./config";
import { logDecision } from "./decisions";
import { recordError } from "./errors";
import { closePosition, closeTitle, pricingFor } from "./engine";
import { activePositionsForBot } from "./safeguards";
import { RunRecorder, describeLegs, typeName } from "./runTrace";
import { sharedExecutor } from "./sharedExecutor";
import { describeTradingTime, describeWindow, hoursConfigFor, isWithinTradingHours } from "./tradingHours";
import type { BrokerExecutor, DecisionOutcome, MonitorKey, Position, PositionType, Signal, SignalDirection } from "./types";

/**
 * Close Monitors, modelled on Option Alpha's "BullishSpx Close Monitor": a sweep that closes a position sitting on the
 * wrong side of the signal. Option Alpha's own version runs every scan and closes ANY position of that type, which is why
 * it is switched off there: next to the flip it would close the position a signal has just opened. This one is built to
 * never do that:
 *
 *  - OFF by default, per bot and per direction;
 *  - it only acts on a position of the wrong type when the LATEST CONFIRMED signal says so (a short call spread, with the
 *    latest confirmed signal bullish) - so it can never close the side the latest signal wants;
 *  - only on an `open` position the bot opened itself: never one that is opening or already closing (one close per
 *    position, never a second, never retried), and never one a person placed by hand;
 *  - it needs the bot on, the kill switch off, the trading window, and runs inside the bot's lock so it never overlaps a signal;
 *  - a failed close is an error (counts toward the 10-error failsafe), flags the bot, and stops there;
 *  - dry run logs "would close" and sends nothing.
 *
 * The end-of-day sweep and Close position are separate and never depend on a monitor.
 */

export const MONITORS: Record<MonitorKey, { signal: SignalDirection; wrongType: PositionType; name: string }> = {
  bullishClose: { signal: "bullish", wrongType: "short_call_spread", name: "Bullish Close Monitor" },
  bearishClose: { signal: "bearish", wrongType: "short_put_spread", name: "Bearish Close Monitor" },
};

/** A signal that was received but not acted on (outside the window, a duplicate, the wrong symbol, a trigger or the bot off...)
 * is not "confirmed": it says nothing about which side the bot should hold. */
const NOT_CONFIRMED: readonly DecisionOutcome[] = ["duplicate_signal", "symbol_mismatch", "price_out_of_range", "outside_hours", "kill_switch", "trigger_disabled", "automations_off", "config_error"];

/** The latest signal the engine really acted on (or tried to), or null. */
export function latestConfirmedSignal(botId: string): Signal | null {
  const signals = signalsStore.query((s) => s.botId === botId && s.status === "accepted").sort((a, b) => b.receivedAt - a.receivedAt);
  for (const signal of signals) {
    const outcomes = decisionsStore.query((d) => d.signalId === signal.id).map((d) => d.outcome);
    if (outcomes.length === 0) continue; // not processed yet: unknown
    if (outcomes.some((o) => NOT_CONFIRMED.includes(o))) continue;
    return signal;
  }
  return null;
}

export type MonitorSkip = "off" | "not_set_up" | "kill_switch" | "bot_off" | "outside_hours" | "nothing_to_check" | "no_confirmed_signal" | "correct_side";

export interface MonitorResult {
  key: MonitorKey;
  skipped?: MonitorSkip;
  closed: number;
  wouldClose: number;
  failed: number;
}

export interface MonitorOptions {
  executor?: BrokerExecutor;
  dryRun?: boolean;
  closeConfirmTimeoutMs?: number;
  pollIntervalMs?: number;
  ladderStepMs?: number;
}

const skip = (key: MonitorKey, why: MonitorSkip): MonitorResult => ({ key, skipped: why, closed: 0, wouldClose: 0, failed: 0 });
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

/** One look of one monitor. Quiet when there is nothing to do: it only writes a log row and a run when it acts. */
export function runCloseMonitor(botId: string, key: MonitorKey, now: number = Date.now(), options: MonitorOptions = {}): Promise<MonitorResult> {
  return withBotLock(botId, async () => {
    const def = MONITORS[key];
    const bot = botsStore.get(botId);
    const settings = bot?.monitors?.[key];
    if (!bot || !settings?.enabled) return skip(key, "off");
    let config;
    try {
      config = getBotStaticConfig(botId);
    } catch {
      return skip(key, "not_set_up");
    }
    if (bot.killSwitch) return skip(key, "kill_switch");
    if (!bot.enabled) return skip(key, "bot_off");
    const hours = hoursConfigFor(config.hours);
    if (!isWithinTradingHours(now, hours)) return skip(key, "outside_hours");

    const wrongSide = activePositionsForBot(botId, def.wrongType);
    if (wrongSide.length === 0) return skip(key, "nothing_to_check");
    const confirmed = latestConfirmedSignal(botId);
    if (!confirmed) return skip(key, "no_confirmed_signal");
    if (confirmed.signal !== def.signal) return skip(key, "correct_side");

    // Only a position the bot opened itself, still `open`, with no close already working: one close per position, never a second.
    const candidates = wrongSide.filter(
      (p) => p.status === "open" && !p.manual && ordersStore.query((o) => o.positionId === p.id && o.kind === "close" && (o.status === "working" || o.status === "partially_filled")).length === 0,
    );
    if (candidates.length === 0) return skip(key, "nothing_to_check");

    const executor = options.executor ?? sharedExecutor;
    const dryRun = options.dryRun ?? isDryRun();
    const closeTimeoutMs = options.closeConfirmTimeoutMs ?? CLOSE_CONFIRM_TIMEOUT_SECONDS * 1000;
    const result: MonitorResult = { key, closed: 0, wouldClose: 0, failed: 0 };
    const rec = new RunRecorder({ botId, signalId: null, source: "monitor", automation: def.name, trigger: "Monitor", startedAt: now });
    const log = (outcome: DecisionOutcome, reason: string, detail: Record<string, unknown> = {}) =>
      logDecision({ signalId: null, botId, outcome, reason, detail: { monitor: key, latestSignalId: confirmed.id, ...detail }, now });

    try {
      rec.decision("Bot is switched on", true, "Bot is on");
      rec.decision(`Current market time is between ${describeWindow(hours)}`, true, describeTradingTime(now, hours));
      rec.decision(`The latest confirmed signal is ${def.signal}`, true, `${def.signal[0].toUpperCase()}${def.signal.slice(1)} signal at ${timeOf(confirmed.receivedAt)}, price ${confirmed.price.toLocaleString("en-US")}`);
      rec.decision(
        `Bot has exactly or more than 1 position with ${typeName(def.wrongType)} type and any status`,
        true,
        `${wrongSide.length} position${wrongSide.length === 1 ? "" : "s"}`,
      );

      for (const position of candidates) {
        const params = [
          { label: "Price", value: `Final price ${config.closePricePercent ?? 100}% of the way across the bid/ask (SmartPricing ${config.smartPricing ?? "normal"})` },
          { label: "Quantity", value: "100% of position" },
          ...(settings.memo ? [{ label: "Memo", value: settings.memo }] : []),
          ...(settings.tags?.length ? [{ label: "Tags", value: settings.tags.join(", ") }] : []),
        ];
        const fresh = (p: Position): Position => positionsStore.get(p.id) ?? p;

        if (dryRun) {
          result.wouldClose++;
          rec.action({ action: "close", title: closeTitle(position), position, params, outcome: "dry_run", reason: "Dry run: would close; nothing sent." });
          log("dry_run", `Dry run: ${def.name} would close ${describeLegs(position)}; nothing sent.`, { positionId: position.id, wouldClose: true });
          continue;
        }

        const closed = await closePosition(position, { id: confirmed.id, price: null }, executor, closeTimeoutMs, options.pollIntervalMs ?? ORDER_POLL_INTERVAL_MS, now, pricingFor(config, "close", options.ladderStepMs));
        const tags = settings.tags?.length ? [...new Set([...(fresh(position).tags ?? []), ...settings.tags])] : undefined;
        if (settings.memo || tags) {
          positionsStore.update(position.id, {
            ...(settings.memo ? { notes: [fresh(position).notes, settings.memo].filter(Boolean).join("\n") } : {}),
            ...(tags ? { tags } : {}),
          });
        }
        rec.action({ action: "close", title: closeTitle(position), position: fresh(position), params, steps: closed.steps, outcome: closed.outcome, reason: closed.reason });

        if (closed.ok) {
          result.closed++;
          log("monitor_closed", `${def.name} closed ${describeLegs(position)}: it was against the latest confirmed signal (${def.signal}, ${timeOf(confirmed.receivedAt)}).`, { positionId: position.id });
        } else {
          result.failed++;
          recordError(botId, "close_failed", { positionId: position.id, reason: closed.reason, monitor: key }, now);
          botsStore.update(botId, { needsAttention: true, needsAttentionReason: `${def.name}: ${closed.reason}` });
          log(closed.outcome, `${def.name}: ${closed.reason}`, { positionId: position.id });
        }
      }
    } finally {
      rec.save();
    }
    return result;
  });
}

/** Every enabled monitor of every bot, once. Called each minute by the scheduler. Returns what each one did. */
export async function runDueMonitors(now: number = Date.now(), options: MonitorOptions = {}): Promise<MonitorResult[]> {
  const results: MonitorResult[] = [];
  for (const botId of listBotIds()) {
    const monitors = botsStore.get(botId)?.monitors;
    if (!monitors) continue;
    for (const key of ["bullishClose", "bearishClose"] as const) {
      if (!monitors[key]?.enabled) continue;
      try {
        results.push(await runCloseMonitor(botId, key, now, options));
      } catch (err) {
        console.error(`[automation] ${MONITORS[key].name} failed for ${botDisplayName(botId)}`, err);
      }
    }
  }
  return results;
}
