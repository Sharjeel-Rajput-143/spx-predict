import "server-only";
import { DEFAULT_EOD_SWEEP_MINUTES, CLOSE_CONFIRM_TIMEOUT_SECONDS, ORDER_POLL_INTERVAL_MS, envNumber, isDryRun, parseClockMinutes } from "./config";
import { botDisplayName, ensureBotRecord, getBotStaticConfig, listBotIds } from "./bots";
import { withBotLock } from "./botLock";
import { logDecision } from "./decisions";
import { recordError } from "./errors";
import { closePosition } from "./engine";
import { payoffAt } from "./payoff";
import { positionQuantity } from "./pnl";
import { runDueMonitors } from "./monitors";
import { recoverInFlightPositions } from "./recovery";
import { flagMismatches, reconcile } from "./reconcile";
import { executorStatus, sharedExecutor } from "./sharedExecutor";
import { botsStore, positionsStore } from "./store";
import { easternDateKey } from "./tradingHours";
import { ACTIVE_POSITION_STATUSES, type BrokerExecutor, type EodSweepMode, type Position } from "./types";
import { getLastTick } from "@/lib/marketData/tickStore";

const TICK_MS = 60_000;
/** A price older than this isn't "the underlying right now" for working out a result. */
const MAX_PRICE_AGE_MS = 30 * 60_000;
// On globalThis: the scheduler is started from instrumentation.ts and by the webhook route, which Next
// compiles as separate module graphs. One scheduler, one record of what was swept today.
const shared = globalThis as typeof globalThis & { __eodSweepState?: { started: boolean; ticking: boolean; lastReconcileAt: number; swept: Map<string, string> } };
const state = (shared.__eodSweepState ??= { started: false, ticking: false, lastReconcileAt: 0, swept: new Map() });
/** Per bot: each bot has its own sweep time, so each has its own "done today". */
const lastSweptTradingDate = state.swept;

function easternMinutesOfDay(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

/** When this bot's positions are swept (minutes after midnight ET): its own
 * setting, or 4:05pm. A bot whose inputs aren't complete holds no positions,
 * so it just gets the default rather than stopping the other bots' sweeps. */
export function sweepMinutesFor(botId: string): number {
  try {
    const time = getBotStaticConfig(botId).eodSweepTime;
    return time ? parseClockMinutes(time, "eodSweepTime") : DEFAULT_EOD_SWEEP_MINUTES;
  } catch {
    return DEFAULT_EOD_SWEEP_MINUTES;
  }
}

/** What the sweep does with this bot's positions: its own setting, or estimate. */
export function sweepModeFor(botId: string): EodSweepMode {
  try {
    return getBotStaticConfig(botId).eodSweepMode ?? "estimate";
  } catch {
    return "estimate";
  }
}

export interface SweepOptions {
  /** Where "close at market" sends its orders. Default: the shared executor. */
  executor?: BrokerExecutor;
  /** The underlying's latest price, or null when there isn't a fresh one. Default: the live quote feed. */
  underlyingPrice?: (symbol: string, now: number) => number | null;
  closeConfirmTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface SweepResult {
  botId: string;
  mode: EodSweepMode;
  /** Positions the sweep looked at. */
  swept: number;
  /** Marked expired with a P/L worked out from the underlying's price. */
  estimated: number;
  /** Closed with a market order. */
  closedAtMarket: number;
  /** Marked expired and waiting for a person to enter the P/L. */
  awaitingEntry: number;
  /** A market close that didn't go through: left for a person. */
  failed: number;
}

function defaultPrice(symbol: string, now: number): number | null {
  const tick = getLastTick(symbol);
  return tick && now - tick.t <= MAX_PRICE_AGE_MS && Number.isFinite(tick.price) && tick.price > 0 ? tick.price : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Marks a position expired. With a price its P/L is estimated from the payoff at that price. */
function expirePosition(p: Position, now: number, price: number | null, estimate: boolean): "estimated" | "awaiting" {
  const credit = p.credit;
  if (estimate && price !== null && credit != null && p.status === "open") {
    const spread = { type: p.type, shortStrike: p.shortStrike, longStrike: p.longStrike, credit, quantity: positionQuantity(p) };
    const pl = round2(payoffAt(spread, price));
    const settleValue = round2(credit - pl / (100 * spread.quantity));
    positionsStore.update(p.id, { status: "expired", closedAt: now, underlyingAtClose: price, settlement: { kind: "estimated", pl, underlyingPrice: price, settleValue, at: now } });
    return "estimated";
  }
  positionsStore.update(p.id, { status: "expired", closedAt: now, ...(price !== null ? { underlyingAtClose: price } : {}) });
  return "awaiting";
}

/**
 * The end-of-day sweep for one bot, in the mode its settings choose:
 *  - estimate (default): every position still held expires, and its P/L is estimated from the
 *    underlying's price (the spread's value at expiry, from its strikes and credit);
 *  - market: each open position gets a close order with no limit price (a market order on a broker);
 *  - manual: every position expires with no P/L, waiting for a person to enter it.
 * A position that can't be estimated (no fresh price, no credit, or not fully open) waits for a person too.
 * Runs inside the bot's lock, so it never overlaps a signal. Safe to call twice: nothing active, nothing done.
 */
export function sweepBot(botId: string, now: number = Date.now(), options: SweepOptions = {}): Promise<SweepResult> {
  return withBotLock(botId, async () => {
    const mode = sweepModeFor(botId);
    const result: SweepResult = { botId, mode, swept: 0, estimated: 0, closedAtMarket: 0, awaitingEntry: 0, failed: 0 };
    const active = positionsStore.query((p) => p.botId === botId && ACTIVE_POSITION_STATUSES.includes(p.status));
    result.swept = active.length;
    if (active.length === 0) return result;

    const priceOf = options.underlyingPrice ?? defaultPrice;
    const name = botDisplayName(botId);

    if (mode === "market") {
      if (isDryRun()) {
        logDecision({ signalId: null, botId, outcome: "dry_run", reason: `Dry run: the end-of-day sweep would close ${active.length} position${active.length === 1 ? "" : "s"} at market.`, detail: { sweep: true, mode }, now });
        return result;
      }
      const executor = options.executor ?? sharedExecutor;
      for (const position of active) {
        if (position.status !== "open") {
          // Opening or already closing: we can't tell what the broker holds, so a person has to look.
          expirePosition(position, now, null, false);
          result.awaitingEntry++;
          botsStore.update(botId, { needsAttention: true, needsAttentionReason: `end-of-day sweep: a ${position.status} position was left for you to check` });
          continue;
        }
        // No pricing given: no ladder, no limit price - the executor's own (market) order.
        const closed = await closePosition(
          position,
          { id: null, price: priceOf(position.underlying, now) },
          executor,
          options.closeConfirmTimeoutMs ?? CLOSE_CONFIRM_TIMEOUT_SECONDS * 1000,
          options.pollIntervalMs ?? ORDER_POLL_INTERVAL_MS,
          now,
        );
        logDecision({ signalId: null, botId, outcome: closed.outcome, reason: `End-of-day sweep: ${closed.reason}`, detail: { sweep: true, mode, positionId: position.id, ...(closed.steps ? { steps: closed.steps } : {}) }, now });
        if (closed.ok) {
          result.closedAtMarket++;
        } else {
          result.failed++;
          recordError(botId, "close_failed", { positionId: position.id, reason: closed.reason, sweep: true }, now);
          ensureBotRecord(botId);
          botsStore.update(botId, { needsAttention: true, needsAttentionReason: `end-of-day sweep: ${closed.reason}` });
        }
      }
      return result;
    }

    for (const position of active) {
      const price = mode === "estimate" ? priceOf(position.underlying, now) : null;
      const outcome = expirePosition(position, now, price, mode === "estimate");
      if (outcome === "estimated") result.estimated++;
      else result.awaitingEntry++;
    }

    const parts: string[] = [];
    if (result.estimated) parts.push(`${result.estimated} result${result.estimated === 1 ? "" : "s"} estimated from the underlying's price`);
    if (result.awaitingEntry) {
      parts.push(
        `${result.awaitingEntry} waiting for you to enter the P/L${mode === "estimate" ? " (no fresh price to estimate from, or the position wasn't fully open)" : ""}`,
      );
    }
    logDecision({
      signalId: null,
      botId,
      outcome: "eod_sweep",
      reason: `${name}: end-of-day sweep (${mode}) - ${result.swept} position${result.swept === 1 ? "" : "s"} expired; ${parts.join("; ")}.`,
      detail: { sweep: true, ...result },
      now,
    });
    return result;
  });
}

/** Sweeps every bot (or just one) now, whatever the time. Returns the number of positions it handled. */
export async function runEndOfDaySweep(nowMs: number = Date.now(), botId?: string, options: SweepOptions = {}): Promise<number> {
  const today = easternDateKey(nowMs);
  let total = 0;
  for (const id of botId ? [botId] : listBotIds()) {
    total += (await sweepBot(id, nowMs, options)).swept;
    lastSweptTradingDate.set(id, today);
  }
  return total;
}

/** Sweeps every bot whose own sweep time has passed and that hasn't been
 * swept today. Returns the bots it swept. */
export async function runDueSweeps(now: number, options: SweepOptions = {}): Promise<string[]> {
  const today = easternDateKey(now);
  const minutes = easternMinutesOfDay(now);
  const swept: string[] = [];
  for (const botId of listBotIds()) {
    if (lastSweptTradingDate.get(botId) === today) continue;
    if (minutes >= sweepMinutesFor(botId)) {
      lastSweptTradingDate.set(botId, today); // claimed before the work, so a slow sweep isn't started twice
      try {
        await sweepBot(botId, now, options);
        swept.push(botId);
      } catch (err) {
        lastSweptTradingDate.delete(botId); // try again on the next tick
        console.error(`[automation] end-of-day sweep failed for ${botId}`, err);
      }
    }
  }
  return swept;
}


/** Only a real broker executor, configured, with orders actually being sent, has anything to recover or compare. */
function brokerReady(): boolean {
  const s = executorStatus();
  return s.venue === "tradier" && !s.error && !isDryRun();
}

async function tick(): Promise<void> {
  if (state.ticking) return; // a market-close sweep can outlast a minute
  state.ticking = true;
  try {
    await runDueSweeps(Date.now());
    await runDueMonitors(Date.now()); // Close Monitors (off unless a person switched one on); quiet when there is nothing to do

    // Optional periodic check of our open positions against the broker's (RECONCILE_INTERVAL_MINUTES, off by default).
    const everyMinutes = envNumber("RECONCILE_INTERVAL_MINUTES", 0);
    if (everyMinutes > 0 && brokerReady() && Date.now() - state.lastReconcileAt >= everyMinutes * 60_000) {
      state.lastReconcileAt = Date.now();
      reconcile(sharedExecutor)
        .then(flagMismatches)
        .catch((err) => console.error("[automation] broker check failed", err));
    }
  } catch (err) {
    console.error("[automation] scheduler tick failed", err);
  } finally {
    state.ticking = false;
  }
}

/** On startup, settle any order a crash or restart left in flight (reads each back from the broker; sends nothing). */
function recoverOnStartup(): void {
  if (!brokerReady()) return;
  recoverInFlightPositions(sharedExecutor)
    .then((results) => results.length > 0 && console.warn(`[automation] recovery after restart: ${results.map((r) => `${r.was}->${r.action}`).join(", ")}`))
    .catch((err) => console.error("[automation] recovery after restart failed", err));
}

/** Started once when the server boots (src/instrumentation.ts), and again - harmlessly - by the first
 * webhook; kept alive for the life of the process. The per-signal stale-position check (expiry.ts's
 * expireStalePositions) is the safety net if this never gets started or a tick is missed. */
export function startEodScheduler(): void {
  if (state.started) return;
  state.started = true;
  recoverOnStartup();
  void tick();
  setInterval(() => void tick(), TICK_MS);
}

/** Test hook: forget which bots were already swept. */
export function __resetSweepState(): void {
  lastSweptTradingDate.clear();
}
