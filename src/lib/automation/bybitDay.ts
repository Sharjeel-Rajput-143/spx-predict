import "server-only";
import { positionPL } from "./pnl";
import { botsStore, positionsStore } from "./store";
import { easternDateKey } from "./tradingHours";
import type { Position } from "./types";

/**
 * The Bybit day: today's profit and loss, the daily loss limit (DAILY_MAX_LOSS_USD), and what the results panel shows. Plain arithmetic over the bot's own
 * records, plus the one flag that remembers the limit was reached. "Today" is the New York calendar date, like every other daily count in the app.
 *
 * The day's loss is the realized result of the positions that closed today (wins and losses together) plus the open loss; an open profit offsets nothing,
 * the same rule as the daily loss limit for the other brokers. The limit is reached when that is at or below minus DAILY_MAX_LOSS_USD.
 */

/**
 * FEES. A trade's result counts AFTER fees, the way Bybit's own history does. Bybit's figure (settlement) is used as soon as Bybit lists the closed trade. Until then
 * (a minute or so) the result is the real fill prices less the fees those fills cost, estimated at Bybit's standard taker rate on both fills (a market order is a taker
 * order; the demo charged exactly this). It never counts a trade as better than its fills less fees, so the daily loss limit is never looser than the real result.
 */
export const BYBIT_TAKER_FEE_RATE = 0.00055;

export const isBybitPosition = (p: Pick<Position, "venue">): boolean => p.venue === "bybit";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The fees of a closed trade's two fills, estimated (null while an entry or exit price is unknown). `unit` is the coin size of one contract (POSITION_SIZE). */
export function estimatedFees(p: Position, unit: number): number | null {
  const entry = entryPriceOf(p, unit);
  const exit = exitPriceOf(p, unit);
  if (entry === null || exit === null) return null;
  return BYBIT_TAKER_FEE_RATE * (entry + exit) * (p.filledQuantity || p.requestedQuantity) * unit;
}

/** A closed Bybit trade's result AFTER fees: Bybit's own figure once it has one, else the fills less the estimated fees. Null while there is no exit price. */
export function bybitPL(p: Position, unit: number): number | null {
  const gross = positionPL(p);
  if (gross === null) return null;
  if (p.settlement?.kind === "broker") return gross; // Bybit's own figure: already net of fees
  const fees = estimatedFees(p, unit);
  return fees === null ? gross : gross - fees;
}

/** The realized result of the bot's Bybit trades that closed on the New York day of `now`, after fees (wins and losses together). */
export function sumBybitRealizedToday(positions: readonly Position[], now: number, unit: number): { realized: number; closedToday: number } {
  const today = easternDateKey(now);
  let realized = 0;
  let closedToday = 0;
  for (const p of positions) {
    if ((p.status !== "closed" && p.status !== "expired") || p.closedAt == null || easternDateKey(p.closedAt) !== today) continue;
    closedToday++;
    realized += bybitPL(p, unit) ?? 0; // a closed trade with no price has no result and counts as 0, as everywhere else
  }
  return { realized: round2(realized), closedToday };
}

export interface DayStatus {
  /** The New York date. */
  day: string;
  /** Result of the positions that closed today. */
  realized: number;
  closedToday: number;
  /** The open loss counted (zero or negative; an open profit is not counted). */
  openLoss: number;
  /** realized + openLoss: what the limit is measured against. */
  dayLoss: number;
  limit: number;
  /** How much more the day can lose before the limit: limit + dayLoss, never below 0. */
  room: number;
  /** The limit was reached today (the flag is set) or the numbers say so. */
  reached: boolean;
  /** The flag: the limit was reached today and new entries are blocked until the next day. */
  tripped: boolean;
  trippedAt: number | null;
}

/** Today's numbers for a bot. `openPnl` is the open trade's profit or loss as Bybit reports it (null when nothing is open or it is not known). */
export function dayStatus(botId: string, limit: number, now: number, openPnl: number | null, unit: number): DayStatus {
  const day = easternDateKey(now);
  const mine = positionsStore.query((p) => p.botId === botId && isBybitPosition(p));
  const today = sumBybitRealizedToday(mine, now, unit);
  const openLoss = openPnl !== null && Number.isFinite(openPnl) ? Math.min(0, openPnl) : 0;
  const dayLoss = round2(today.realized + openLoss);
  const trip = botsStore.get(botId)?.riskTrip;
  const tripped = trip?.day === day;
  return {
    day,
    realized: today.realized,
    closedToday: today.closedToday,
    openLoss: round2(openLoss),
    dayLoss,
    limit,
    room: Math.max(0, round2(limit + dayLoss)),
    reached: tripped || dayLoss <= -limit + 1e-9,
    tripped,
    trippedAt: tripped ? trip!.at : null,
  };
}

/** Remembers that the limit was reached today. New entries stay blocked until the date changes; nothing has to be cleared. */
export function tripDailyLimit(botId: string, now: number, reason: string): void {
  if (botsStore.get(botId)?.riskTrip?.day === easternDateKey(now)) return;
  botsStore.update(botId, { riskTrip: { day: easternDateKey(now), at: now, reason } });
}

const clock = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);

/** Why a NEW entry is refused right now for the daily loss limit, or null. Counts only what has closed (an entry is only ever made from flat). */
export function dailyLimitBlock(botId: string, limit: number, now: number, unit: number): string | null {
  const s = dayStatus(botId, limit, now, null, unit);
  if (!s.reached) return null;
  if (!s.tripped) tripDailyLimit(botId, now, `the day's result is ${s.dayLoss.toFixed(2)}`);
  const at = s.trippedAt ? ` at ${clock(s.trippedAt)}` : "";
  return `Skipped: the daily loss limit of $${limit.toFixed(2)} was reached today${at} (New York time; the day's result is ${s.dayLoss < 0 ? "-" : "+"}$${Math.abs(s.dayLoss).toFixed(2)}). No new entries until the next day.`;
}

// --- What the panel shows -----------------------------------------------------------------------------------------------------

/** The dollar price of one coin at the open of a position, from the credit it filled at (see UNITS in bybitExecutor.ts). Null while unknown. */
export const entryPriceOf = (p: Position, unit: number): number | null => (p.credit == null || !(unit > 0) ? null : round2((p.credit * 100) / unit));

/** The dollar price a closed position exited at, from its close price. A long's close price is (2 x entry - exit), a short's is the exit itself. */
export function exitPriceOf(p: Position, unit: number): number | null {
  if (p.closePrice == null || !(unit > 0)) return null;
  if (p.type === "short_put_spread") return p.credit == null ? null : round2(((2 * p.credit - p.closePrice) * 100) / unit);
  return round2((p.closePrice * 100) / unit);
}

export interface ClosedTradeRow {
  id: string;
  side: "Long" | "Short";
  size: number;
  entryPrice: number | null;
  exitPrice: number | null;
  /** signal_flip, stop_loss, take_profit, daily_limit, kill_switch, ... or null when it was not recorded. */
  closedBy: string | null;
  pl: number | null;
  /** Where the P/L came from: Bybit's own figure (after fees), or the real fill prices less estimated fees (until Bybit lists the trade). */
  plSource: "bybit" | "estimated" | null;
  resultUnknown: string | null;
  closedAt: number | null;
  openedAt: number | null;
}

export function closedTradeRow(p: Position, unit: number): ClosedTradeRow {
  const pl = bybitPL(p, unit);
  return {
    id: p.id,
    side: p.type === "short_put_spread" ? "Long" : "Short",
    size: Math.round((p.filledQuantity || p.requestedQuantity) * unit * 1e8) / 1e8,
    entryPrice: entryPriceOf(p, unit),
    exitPrice: exitPriceOf(p, unit),
    closedBy: p.closeReason ?? null,
    pl: pl === null ? null : round2(pl),
    plSource: pl === null ? null : p.settlement?.kind === "broker" ? "bybit" : "estimated",
    resultUnknown: pl === null ? (p.resultUnknown ?? null) : null,
    closedAt: p.closedAt,
    openedAt: p.openedAt,
  };
}

/** Every closed Bybit trade of a bot, newest first, and the running total of their results. */
export function closedTrades(botId: string, unit: number, limit = 100): { rows: ClosedTradeRow[]; runningTotal: number; count: number } {
  const all = positionsStore.query((p) => p.botId === botId && isBybitPosition(p) && p.status === "closed").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const runningTotal = round2(all.reduce((sum, p) => sum + (bybitPL(p, unit) ?? 0), 0));
  return { rows: all.slice(0, limit).map((p) => closedTradeRow(p, unit)), runningTotal, count: all.length };
}
