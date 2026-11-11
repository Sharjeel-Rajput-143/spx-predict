import "server-only";
import { botsStore, positionsStore } from "./store";
import { withBotLock } from "./botLock";
import { dayStatus, tripDailyLimit } from "./bybitDay";
import type { BybitExecutor, BybitHeld } from "./bybitExecutor";
import { CLOSE_CONFIRM_TIMEOUT_SECONDS, ORDER_POLL_INTERVAL_MS } from "./config";
import { logDecision } from "./decisions";
import { closePosition, syncBrokerPositions } from "./engine";
import { recordError } from "./errors";
import type { BrokerExecutor, CloseReason, Position } from "./types";

/**
 * The Bybit risk monitor. It runs every few seconds while a Bybit position is open (see eodSweep.ts), and does three things for a bot, inside its lock so it never overlaps a signal:
 *   1. asks Bybit what became of the open positions: one the account no longer holds was closed at Bybit by its stop loss or take profit, and is marked closed;
 *   2. when the daily loss limit (DAILY_MAX_LOSS_USD) is reached - the day's realized result plus the open loss, as Bybit reports it - closes every open position
 *      and remembers it, so new entries are blocked until the next day;
 *   3. when the kill switch is on (the bot's own, or BYBIT_KILL_SWITCH) closes every open position. The kill switch also stops every new order, see entryBlock.
 * Closing is a reduce-only market order sent as a person's own Close position is: it is never held to the trading window, so a safety close can always go out.
 */

export const isKilled = (botId: string): boolean => /^(true|1|yes|on)$/i.test((process.env.BYBIT_KILL_SWITCH ?? "").trim()) || botsStore.get(botId)?.killSwitch === true;

const shared = globalThis as typeof globalThis & { __bybitWatching?: Map<string, string> };
const watching = (shared.__bybitWatching ??= new Map<string, string>());

/**
 * Says, once and again only when it changes, what the monitor is watching: the open position and whether its stop loss and take profit are in place at Bybit. A position
 * with a stop missing is said LOUDLY. Quiet while nothing is open and while nothing changes (the monitor looks every 10 seconds).
 */
export function watchLine(botId: string, held: { side: "Buy" | "Sell" | null; size: number; stopLoss: number | null; takeProfit: number | null }, limit: number): void {
  const signature = held.side === null ? "flat" : `${held.side}:${held.size}:${held.stopLoss}:${held.takeProfit}`;
  const before = watching.get(botId);
  if (before === signature) return;
  watching.set(botId, signature);
  if (held.side === null) {
    if (before !== undefined) console.info(`[bybit] risk monitor: the account is flat (daily loss limit $${limit})`);
    return;
  }
  const what = `${held.side === "Buy" ? "long" : "short"} ${held.size}, stop loss ${held.stopLoss ?? "NONE"}, take profit ${held.takeProfit ?? "NONE"}, daily loss limit $${limit}`;
  if (held.stopLoss === null || held.takeProfit === null) console.error(`[bybit] risk monitor: WATCHING A POSITION WITHOUT ITS STOPS AT BYBIT: ${what}`);
  else console.info(`[bybit] risk monitor: watching the open position: ${what}`);
}

/**
 * The breakeven stop (BREAKEVEN_TRIGGER_PERCENT / BREAKEVEN_LOCK_PERCENT): once per trade, when it is far enough in profit, the stop loss is moved at Bybit to just past the
 * entry (see BybitExecutor.moveStopToBreakeven), and the move is written on the trade so it is never repeated and the page can say so. If the price is already beyond the new
 * stop, the trade is closed with a reduce-only market order instead. Runs only when neither the kill switch nor the daily loss limit is closing the trade. A failure to
 * move the stop is said and tried again on the next pass; it never touches the take profit.
 */
async function breakevenStep(botId: string, executor: BrokerExecutor, bybit: BybitExecutor, open: Position[], held: BybitHeld, say: (line: string) => void, options: { closeConfirmTimeoutMs?: number; pollIntervalMs?: number }, now: number): Promise<void> {
  if (held.side === null) return;
  const position = open.find((p) => (p.type === "short_put_spread" ? "Buy" : "Sell") === held.side);
  if (!position || position.breakevenStop) return; // not our trade, or already moved: once per trade
  let result;
  try {
    result = await bybit.moveStopToBreakeven(held);
  } catch (err) {
    const line = `Could not move the stop loss to breakeven (will try again): ${err instanceof Error ? err.message : String(err)}`;
    say(line);
    console.error(`[bybit] ${line}`);
    return;
  }
  if (result.status === "moved" || result.status === "already_set") {
    positionsStore.update(position.id, { breakevenStop: { price: result.stopLoss, at: now } });
    if (result.status === "already_set") return;
    const line = `Breakeven: the trade is in profit, so its stop loss was moved at Bybit from ${result.previous ?? "none"} to ${result.stopLoss} (take profit unchanged).`;
    say(line);
    logDecision({ signalId: null, botId, outcome: "breakeven_stop", reason: line, detail: { positionId: position.id, from: result.previous, to: result.stopLoss }, now });
    return;
  }
  if (result.status !== "too_late") return; // off, not in profit enough yet, or the stop is already tighter
  const line = `Breakeven: the trade is in profit, but ${result.reason}, so Bybit could not take the new stop. Closing the trade instead (reduce only).`;
  say(line);
  logDecision({ signalId: null, botId, outcome: "breakeven_stop", reason: line, detail: { positionId: position.id, newStop: result.newStop, closing: true }, now });
  const closed = await closePosition(position, null, executor, options.closeConfirmTimeoutMs ?? CLOSE_CONFIRM_TIMEOUT_SECONDS * 1000, options.pollIntervalMs ?? ORDER_POLL_INTERVAL_MS, now, undefined, undefined, { manual: true, reason: "breakeven_close" });
  const done = `Breakeven close: ${closed.reason}`;
  say(done);
  logDecision({ signalId: null, botId, outcome: closed.outcome, reason: done, detail: { risk: "breakeven_close", positionId: position.id, ...(closed.steps ? { steps: closed.steps } : {}) }, now });
  if (!closed.ok) {
    recordError(botId, "close_failed", { positionId: position.id, reason: closed.reason, risk: "breakeven_close" }, now);
    botsStore.update(botId, { needsAttention: true, needsAttentionReason: `breakeven_close: ${closed.reason}` });
  }
}

export interface RiskRun {
  botId: string;
  /** What the check did, one line each (also written to the Log). */
  actions: string[];
}

export function runBybitRiskCheck(botId: string, executor: BrokerExecutor, bybit: BybitExecutor, now: number = Date.now(), options: { closeConfirmTimeoutMs?: number; pollIntervalMs?: number } = {}): Promise<RiskRun> {
  return withBotLock(botId, async () => {
    const actions: string[] = [];
    const say = (line: string) => actions.push(line);
    await syncBrokerPositions(botId, executor, now);
    const open = positionsStore.query((p) => p.botId === botId && p.venue === "bybit" && p.status === "open");
    if (open.length === 0) return { botId, actions };

    let openPnl: number | null = null;
    let held: BybitHeld | null = null;
    try {
      held = await bybit.getAccountPosition();
      openPnl = held.unrealisedPnl;
      watchLine(botId, held, bybit.dailyMaxLossUsd);
    } catch (err) {
      say(`Could not read the open profit or loss from Bybit: ${err instanceof Error ? err.message : String(err)}`);
    }
    const status = dayStatus(botId, bybit.dailyMaxLossUsd, now, openPnl, bybit.positionSize);
    let why: CloseReason | null = null;
    let text = "";
    if (isKilled(botId)) {
      why = "kill_switch";
      text = "The kill switch is on: closing the open position.";
    } else if (status.reached) {
      why = "daily_limit";
      text = `The daily loss limit of $${bybit.dailyMaxLossUsd.toFixed(2)} is reached (the day's result is ${status.dayLoss < 0 ? "-" : "+"}$${Math.abs(status.dayLoss).toFixed(2)}): closing every open position. No new entries until the next day.`;
      if (!status.tripped) {
        tripDailyLimit(botId, now, text);
        botsStore.update(botId, { needsAttention: true, needsAttentionReason: `daily_loss_limit_reached: ${text}` });
      }
    }
    if (!why) {
      if (held) await breakevenStep(botId, executor, bybit, open, held, say, options, now);
      return { botId, actions };
    }

    say(text);
    logDecision({ signalId: null, botId, outcome: why === "kill_switch" ? "kill_switch" : "daily_loss_limit_reached", reason: text, detail: { risk: why, openPositions: open.length, dayLoss: status.dayLoss }, now });
    for (const position of open) {
      const result = await closePosition(position, null, executor, options.closeConfirmTimeoutMs ?? CLOSE_CONFIRM_TIMEOUT_SECONDS * 1000, options.pollIntervalMs ?? ORDER_POLL_INTERVAL_MS, now, undefined, undefined, { manual: true, reason: why });
      const line = `${why === "kill_switch" ? "Kill switch" : "Daily loss limit"} close: ${result.reason}`;
      say(line);
      logDecision({ signalId: null, botId, outcome: result.outcome, reason: line, detail: { risk: why, positionId: position.id, ...(result.steps ? { steps: result.steps } : {}) }, now });
      if (!result.ok) {
        recordError(botId, "close_failed", { positionId: position.id, reason: result.reason, risk: why }, now);
        botsStore.update(botId, { needsAttention: true, needsAttentionReason: `${why}: ${result.reason}` });
      }
    }
    return { botId, actions };
  });
}
