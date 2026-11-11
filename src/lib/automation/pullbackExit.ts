import "server-only";
import { withBotLock } from "./botLock";
import { BTC_BOT_ID, botDisplayName, getBotStaticConfig } from "./bots";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import type { BybitExecutor } from "./bybitExecutor";
import { isDryRun } from "./config";
import { logDecision } from "./decisions";
import { closePosition, processSignal, receiveAndSaveSignal } from "./engine";
import { resolveHookPrice } from "./hookPrice";
import { bybitExecutor, liveBybitExecutor, sharedExecutor } from "./sharedExecutor";
import { botsStore, positionsStore, signalsStore } from "./store";
import type { BrokerExecutor, CloseReason, Position } from "./types";
import { CLOSE_CONFIRM_TIMEOUT_SECONDS, ORDER_POLL_INTERVAL_MS } from "./config";

/**
 * THE PULLBACK EXIT (way A) AND THE CHAIN MODE, for BOTH Bybit bots: the demo bot and the live bot, with the SAME code and the same defaults. Each bot has its OWN saved values (bot.pullback),
 * its own peak, its own chain and its own lock, and each is read from and closed on its OWN account (the demo bot on the demo account, the live bot on the live account). Nothing is shared
 * but the code. The live bot's own limits apply to everything it does here, chain trades included (0.001 BTC, one position, the trades-a-day count, the daily loss limit, the live switch).
 *
 * PULLBACK EXIT. While a trade is open and in profit, its best profit so far (the peak, in dollars on Bybit's mark price) is saved on the trade record, so a restart does not forget
 * it. When the profit has fallen PULLBACK_FALL_USD (default $0.03) below that peak, the trade is closed with a reduce-only market order (close reason "pullback_exit"). The trade's
 * stop loss and take profit stay at Bybit until that close fills; if this code, the app or the Mac is down, nothing is lost: Bybit's own stop is still there. A minimum peak can be
 * set (default $0.12; a saved 0 means none). Everything is done in dollars of profit on the open position (0.001 BTC, so $0.03 is a $30 move of the BTC price).
 *
 * CHAIN MODE (its own switch, OFF by default). When a trade the bot opened for an alert is closed by the pullback exit, the next trade is opened at once in the OPPOSITE direction.
 * A chain trade is protected at its entry exactly like any other (the executor's own stop loss and take profit), is watched by the same pullback exit, and has a tight "chain stop":
 * it is closed when its loss reaches CHAIN_STOP_USD (default $0.03). THAT STOP IS KEPT BY THIS APP (a reduce-only market close), NOT BY BYBIT: a stop that close to the entry cannot be
 * put at Bybit without changing the executor's stop-safety rules (see the report). The executor's normal stop stays at Bybit under it, as the real protection.
 * When a chain trade closes (pullback exit, its chain stop, its stop or its take profit) the next trade opens opposite to it. Anything else ends the chain: a real alert (the bot then
 * follows the alert through the normal flip logic), the cap per alert (default 10), the kill switch, the daily loss limit, any other way the trade closed, a bot that is off.
 *
 * Everything here runs under the bot's lock, so it never runs at the same moment as the breakeven step (which is inside the risk check, also under that lock) or an alert.
 */

export const PULLBACK_TICK_MS = 2_000;
export const DEFAULT_FALL_USD = 0.03;
export const DEFAULT_CHAIN_STOP_USD = 0.03;
export const DEFAULT_CHAIN_MAX = 10;
const RETRY_AFTER_FAILURE_MS = 8_000;

/** The smallest peak the pullback exit may fire from, for a bot with nothing saved. A value somebody saved (0 included: "no minimum") is never replaced by it. */
export const DEFAULT_MIN_PEAK_USD = 0.12;

export interface PullbackSettings {
  enabled: boolean;
  fallUsd: number;
  minPeakUsd: number;
  chainEnabled: boolean;
  chainStopUsd: number;
  chainMax: number;
}
const OFF: PullbackSettings = { enabled: false, fallUsd: DEFAULT_FALL_USD, minPeakUsd: 0, chainEnabled: false, chainStopUsd: DEFAULT_CHAIN_STOP_USD, chainMax: DEFAULT_CHAIN_MAX };

/** The settings in force for one of the two Bybit bots: the pullback exit ON unless switched off, the chain OFF unless switched on, each bot with its own saved values. Everything is OFF for any other bot. */
export function pullbackSettings(botId: string): PullbackSettings {
  if (botId !== BTC_BOT_ID && botId !== LIVE_BOT_ID) return OFF; // only the two Bybit bots; any other bot gets nothing, whatever is stored for it
  const p = botsStore.get(botId)?.pullback ?? {};
  const pos = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  return {
    enabled: p.enabled !== false,
    fallUsd: pos(p.fallUsd, DEFAULT_FALL_USD),
    // A saved number (0 = "no minimum" included) is used as saved; only nothing saved, or something unusable, gets the default.
    minPeakUsd: typeof p.minPeakUsd === "number" && Number.isFinite(p.minPeakUsd) && p.minPeakUsd >= 0 ? p.minPeakUsd : DEFAULT_MIN_PEAK_USD,
    chainEnabled: p.chainEnabled === true,
    chainStopUsd: pos(p.chainStopUsd, DEFAULT_CHAIN_STOP_USD),
    chainMax: typeof p.chainMax === "number" && Number.isInteger(p.chainMax) && p.chainMax >= 1 ? p.chainMax : DEFAULT_CHAIN_MAX,
  };
}

// ---------- the arithmetic, in whole micro-dollars so "exactly $0.03" is exact ----------
const micro = (x: number): number => Math.round(x * 1e6);

/** Profit of the open position in dollars on the mark price: positive when the mark is on the profit side of the average fill. */
export function profitUsd(held: { side: "Buy" | "Sell" | null; size: number; avgPrice: number | null; markPrice: number | null }): number | null {
  if (held.side === null || held.avgPrice === null || held.markPrice === null || !(held.size > 0)) return null;
  const move = held.side === "Buy" ? held.markPrice - held.avgPrice : held.avgPrice - held.markPrice;
  return move * held.size;
}

/** The peak after this read: never lower, and only a profit counts. */
export function nextPeak(stored: number | undefined, profit: number): number {
  const prev = typeof stored === "number" && stored > 0 ? stored : 0;
  return profit > 0 && micro(profit) > micro(prev) ? profit : prev;
}

/** Does the pullback exit fire? Only with a real peak (above zero and at least the minimum), and once the profit is `fallUsd` or more below it (exactly that counts). */
export function pullbackFires(a: { peak: number; profit: number; fallUsd: number; minPeakUsd: number }): boolean {
  if (!(micro(a.peak) > 0) || micro(a.peak) < micro(a.minPeakUsd)) return false;
  return micro(a.peak) - micro(a.profit) >= micro(a.fallUsd);
}

/** Does the chain stop fire? When the loss reaches `stopUsd` (exactly that counts). */
export function chainStopFires(a: { profit: number; stopUsd: number }): boolean {
  return micro(a.profit) <= -micro(a.stopUsd);
}

const usd = (x: number) => `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`;
const isLong = (p: Pick<Position, "type">) => p.type === "short_put_spread";

/** The ways a chain trade can end that carry the chain on. */
const CONTINUES = new Set<string>(["pullback_exit", "chain_stop", "stop_loss", "take_profit", "breakeven_stop"]);
/** A signal the bot made for itself (the chain's, or an entry retry): not an alert. */
const isSelfMade = (s: { raw?: unknown }) => {
  const o = (s.raw as { origin?: unknown } | null)?.origin;
  return o === "chain";
};

export interface PullbackDeps {
  /** The Bybit executor (account reader) of this bot: the demo one for the demo bot, the live one for the live bot, or null when it has none (no key). */
  bybit: (botId: string) => BybitExecutor | null;
  executor: BrokerExecutor;
  /** A fresh live price for the underlying, or null. */
  price: (underlying: string) => Promise<number | null>;
  closeConfirmTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Passed to processSignal for the chain's opens (tests use short waits). */
  process?: { closeConfirmTimeoutMs?: number; orderFillTimeoutMs?: number; pollIntervalMs?: number; ladderStepMs?: number };
}

const defaultDeps = (): PullbackDeps => ({ bybit: (botId) => (botId === LIVE_BOT_ID ? liveBybitExecutor() : bybitExecutor()), executor: sharedExecutor, price: (u) => resolveHookPrice(u, Date.now(), 3_000) });

const lastFailure = new Map<string, number>();
export function __resetPullbackForTests(): void {
  lastFailure.clear();
  running.clear();
}
/** The bots whose tick is in progress: one at a time per bot, and the two bots never wait for each other. */
const running = new Set<string>();

/** One look at both Bybit bots (each on its own account, each with its own saved values). Returns how many things it did (closes and chain opens). Quiet and free when nothing is open and no chain runs. Never throws. */
export async function pullbackTick(now: number = Date.now(), deps: PullbackDeps = defaultDeps()): Promise<number> {
  if (isDryRun()) return 0;
  const done = await Promise.all([BTC_BOT_ID, LIVE_BOT_ID].map((botId) => tickOne(botId, now, deps)));
  return done.reduce((a, b) => a + b, 0);
}

async function tickOne(botId: string, now: number, deps: PullbackDeps): Promise<number> {
  if (running.has(botId)) return 0;
  const s = pullbackSettings(botId);
  if (!s.enabled && !s.chainEnabled) return 0;
  running.add(botId);
  try {
    return await step(botId, s, now, deps);
  } catch (err) {
    console.error(`[pullback] tick failed for ${botId}`, err);
    return 0;
  } finally {
    running.delete(botId);
  }
}

const openRecord = (botId: string) => positionsStore.query((p) => p.botId === botId && p.venue === "bybit" && p.status === "open")[0] ?? null;

async function step(botId: string, s: PullbackSettings, now: number, deps: PullbackDeps): Promise<number> {
  const bybit = deps.bybit(botId);
  if (!bybit) return 0;
  const record = openRecord(botId);
  if (!record) {
    // Nothing open. A running chain whose last trade has closed is carried on (or ended) here, under the lock.
    if (!s.chainEnabled || !botsStore.get(botId)?.chainState) return 0;
    return withBotLock(botId, async () => chainContinue(botId, now, deps));
  }
  // Read the account WITHOUT the lock (an alert is never kept waiting for this look); the lock is taken only to act, and everything is looked at again then.
  let held: Awaited<ReturnType<BybitExecutor["getAccountPosition"]>>;
  try {
    held = await bybit.getAccountPosition({ retries: 0 });
  } catch {
    return 0; // Bybit could not be read just now: the watchdog says so; the stop at Bybit is still there
  }
  if (held.side === null) return 0; // the position is already gone
  if ((held.side === "Buy") !== isLong(record)) return 0; // what Bybit holds is not this record's trade: not ours to judge
  const profit = profitUsd(held);
  if (profit === null) return 0;
  const peak = nextPeak(record.peakProfitUsd, profit);
  if (peak !== (record.peakProfitUsd ?? 0) && peak > 0) positionsStore.update(record.id, { peakProfitUsd: peak, peakAt: now });
  const st = botsStore.get(botId)?.chainState;
  const inChain = !!record.chain && s.chainEnabled && st?.lastPositionId === record.id;
  let reason: CloseReason | null = null;
  if (inChain && chainStopFires({ profit, stopUsd: s.chainStopUsd })) reason = "chain_stop";
  else if (s.enabled && pullbackFires({ peak, profit, fallUsd: s.fallUsd, minPeakUsd: s.minPeakUsd })) reason = "pullback_exit";
  if (!reason) return 0;
  if (now - (lastFailure.get(record.id) ?? -Infinity) < RETRY_AFTER_FAILURE_MS) return 0;
  return withBotLock(botId, async () => {
    // Again, under the lock: the trade must still be open and still be this one, the account must still hold it, and the rule must still fire (the breakeven step, an alert or the risk
    // check may have acted while this waited). No action if the position is already gone.
    const again = positionsStore.get(record.id);
    if (!again || again.status !== "open") return 0;
    let now2: Awaited<ReturnType<BybitExecutor["getAccountPosition"]>>;
    try {
      now2 = await bybit.getAccountPosition({ retries: 0 });
    } catch {
      return 0;
    }
    if (now2.side === null || (now2.side === "Buy") !== isLong(again)) return 0;
    const profit2 = profitUsd(now2);
    if (profit2 === null) return 0;
    const peak2 = nextPeak(again.peakProfitUsd, profit2);
    const fires = reason === "chain_stop" ? chainStopFires({ profit: profit2, stopUsd: s.chainStopUsd }) : pullbackFires({ peak: peak2, profit: profit2, fallUsd: s.fallUsd, minPeakUsd: s.minPeakUsd });
    if (!fires) return 0;
    const text =
      reason === "chain_stop"
        ? `Chain stop: this chain trade's loss reached $${s.chainStopUsd.toFixed(2)} (now ${usd(profit2)}): closing at market, reduce only.`
        : `Pullback exit: the profit fell to ${usd(profit2)}, $${(peak2 - profit2).toFixed(2)} below its peak of ${usd(peak2)} (the rule is $${s.fallUsd.toFixed(2)}): closing at market, reduce only. The stop loss and take profit stay at Bybit until the close fills.`;
    logDecision({ signalId: null, botId, outcome: reason === "chain_stop" ? "chain_stop" : "pullback_exit", reason: text, detail: { positionId: again.id, peak: peak2, profit: profit2, fall: s.fallUsd, closeReason: reason }, now });
    const result = await closePosition(again, null, deps.executor, deps.closeConfirmTimeoutMs ?? CLOSE_CONFIRM_TIMEOUT_SECONDS * 1000, deps.pollIntervalMs ?? ORDER_POLL_INTERVAL_MS, now, undefined, undefined, { reason });
    if (!result.ok) {
      lastFailure.set(again.id, now);
      logDecision({ signalId: null, botId, outcome: result.outcome, reason: `${reason === "chain_stop" ? "Chain stop" : "Pullback exit"} close did not complete: ${result.reason}. The trade keeps its stop loss and take profit at Bybit.`, detail: { positionId: again.id, closeReason: reason }, now });
      return 0;
    }
    let did = 1;
    // The chain: a main trade closed by the pullback exit starts one; a chain trade closed by its chain stop or the pullback exit carries it on.
    const closed = positionsStore.get(again.id);
    // A trade opened by the Open UP / Open DOWN buttons is not an alert's trade: it never starts a chain.
    const manualRoot = !!closed && (signalsStore.get(closed.openSignalId ?? "")?.raw as { manualOpen?: unknown } | null)?.manualOpen === true;
    if (s.chainEnabled && closed && !manualRoot && (closed.chain || reason === "pullback_exit")) {
      if (!closed.chain) {
        const root = signalsStore.get(closed.openSignalId ?? "");
        botsStore.update(botId, { chainState: { rootSignalId: closed.openSignalId ?? closed.id, count: 0, lastPositionId: closed.id, startedAt: root?.receivedAt ?? closed.openedAt ?? now } });
      }
      did += await chainContinue(botId, now, deps);
    }
    return did;
  });
}

/** Ends the chain with a reason (logged once). */
function endChain(botId: string, why: string, now: number): 0 {
  const st = botsStore.get(botId)?.chainState;
  botsStore.update(botId, { chainState: undefined });
  logDecision({ signalId: null, botId, outcome: "chain_ended", reason: `Chain ended: ${why}.`, detail: { chain: true, ...(st ? { rootSignalId: st.rootSignalId, trades: st.count } : {}) }, now });
  return 0;
}

/**
 * Carries the running chain on, or ends it. Must run inside the bot's lock. Looks at the chain's last trade: while it is still open or closing nothing happens; once it has closed in a
 * way that carries the chain on, the next trade is opened opposite to it, through the engine (processSignal) with a signal of the bot's own (origin "chain"), so the executor protects
 * it at the entry like any other trade and the ledger judges it like any other.
 */
export async function chainContinue(botId: string, now: number, deps: PullbackDeps): Promise<number> {
  const st = botsStore.get(botId)?.chainState;
  if (!st) return 0;
  const s = pullbackSettings(botId);
  const last = positionsStore.get(st.lastPositionId);
  if (!last) return endChain(botId, "its last trade is gone from the records", now);
  if (last.status !== "closed") return 0; // still open, opening or closing: the chain waits
  // A trade Bybit closed by itself is first noted as "closed at the broker" and given its real reason (stop loss, take profit...) a moment later: wait for that, up to 30 s.
  if (last.closeReason === "closed_at_broker" && last.closePrice == null && now - (last.closedAt ?? now) < 30_000) return 0;
  if (!s.chainEnabled) return endChain(botId, "the chain switch is off", now);
  // A real alert (or the retry of one) arrived after the chain began: the chain stops and the alert is followed by the normal flip logic.
  const alert = signalsStore.query((x) => x.botId === botId && x.status === "accepted" && !isSelfMade(x) && x.receivedAt > st.startedAt && x.id !== st.rootSignalId)[0];
  if (alert) return endChain(botId, `a real alert arrived (${alert.signal}), the bot follows it through the normal flip logic`, now);
  if (!last.closeReason || !CONTINUES.has(last.closeReason)) return endChain(botId, `the last trade ended as "${last.closeReason ?? "unknown"}", which does not carry the chain on`, now);
  if (st.count >= s.chainMax) return endChain(botId, `the cap of ${s.chainMax} chain trades for this alert is reached`, now);
  const bot = botsStore.get(botId);
  if (!bot?.enabled) return endChain(botId, "the bot is off", now);
  if (bot.killSwitch) return endChain(botId, "the kill switch is on", now);
  if (bot.needsAttention) return endChain(botId, "the bot needs attention", now);
  const blocked = await deps.executor.entryBlock?.(botId, now).catch(() => null);
  if (blocked) return endChain(botId, blocked.reason, now);
  if (openRecord(botId)) return endChain(botId, "another position is open (one position at a time)", now);
  let underlying: string;
  try {
    underlying = getBotStaticConfig(botId).underlying;
  } catch {
    return endChain(botId, "the bot is not set up", now);
  }
  const price = await deps.price(underlying);
  if (price === null || !Number.isFinite(price) || price <= 0) return endChain(botId, "no live price", now);
  const direction = isLong(last) ? "bearish" : "bullish";
  const index = st.count + 1;
  const rootSignal = signalsStore.get(st.rootSignalId);
  const signal = receiveAndSaveSignal({
    botId,
    signal: direction,
    price,
    barTime: `chain-${st.rootSignalId}-${index}`,
    interval: rootSignal?.interval ?? "",
    raw: { origin: "chain", chainOf: st.rootSignalId, index, symbol: underlying },
    now,
  });
  try {
    await processSignal(signal, { executor: deps.executor, now, ...deps.process });
  } catch (err) {
    return endChain(botId, `opening the ${direction} chain trade failed (${err instanceof Error ? err.message : String(err)})`, now);
  }
  const opened = positionsStore.query((p) => p.openSignalId === signal.id && p.status !== "rejected")[0];
  if (!opened) return endChain(botId, `the ${direction} chain trade was not opened (see the Log line before this one)`, now);
  positionsStore.update(opened.id, { chain: { rootSignalId: st.rootSignalId, index } });
  botsStore.update(botId, { chainState: { ...st, count: index, lastPositionId: opened.id } });
  logDecision({ signalId: signal.id, botId, outcome: "chain_open", reason: `${botDisplayName(botId)}: chain trade ${index} of at most ${s.chainMax}: opened ${direction === "bullish" ? "long" : "short"} after the last trade closed (${last.closeReason}).`, detail: { chain: true, index, closeReason: last.closeReason, rootSignalId: st.rootSignalId }, now });
  return 1;
}
