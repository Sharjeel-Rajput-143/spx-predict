import { easternMinutesOfDay } from "./tradingHours";
import { payoffAt } from "./payoff";
import { positionPL, positionQuantity } from "./pnl";
import { easternDateKey } from "./tradingHours";
import type { Position } from "./types";

/**
 * Option Alpha's Hindsight Report: what would have happened if the positions that were closed early had been held to expiration.
 * For each position closed before its expiry, the held result is the spread's value at that day's official closing price (the same
 * way an expired position is settled), from its strikes, credit and size. Only a day whose close is final is used; a position without
 * a known credit, or on a day with no price, is counted apart and never guessed.
 */

export type CloseLookup = (symbol: string, dateKey: string) => Promise<number | null>;

export interface HindsightRow {
  id: string;
  /** What it actually made. */
  actual: number;
  /** What holding to expiry would have made, or null when that can't be worked out. */
  held: number | null;
}

export interface HindsightReport {
  rows: HindsightRow[];
  /** Positions with both numbers. */
  compared: number;
  /** Closed early but not comparable yet: no price for that day, or no credit. */
  unknown: number;
  actualTotal: number;
  heldTotal: number;
  /** Held minus actual: positive means holding would have made more. */
  difference: number;
  /** How many would have done better held, and how many worse. */
  betterHeld: number;
  worseHeld: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Most days looked up in one report, newest first, so a report is never held up for long. */
export const MAX_DAYS = 30;

export async function hindsight(positions: Position[], now: number, lookup: CloseLookup): Promise<HindsightReport> {
  const today = easternDateKey(now);
  const closeIsFinal = easternMinutesOfDay(now) >= 16 * 60 + 30;
  // Closed by a close order (not expired) with a result of its own, and the expiry's close is final.
  const early = positions.filter((p) => p.status === "closed" && positionPL(p) !== null);
  const usable = (p: Position) => p.credit != null && (p.expiry < today || (p.expiry === today && closeIsFinal));

  const days = [...new Set(early.filter(usable).map((p) => `${p.underlying}|${p.expiry}`))].sort((a, b) => b.split("|")[1].localeCompare(a.split("|")[1])).slice(0, MAX_DAYS);
  const closes = new Map<string, number | null>();
  await Promise.all(
    days.map(async (key) => {
      const [symbol, dateKey] = key.split("|");
      const close = await lookup(symbol, dateKey).catch(() => null);
      closes.set(key, close !== null && Number.isFinite(close) && close > 0 ? close : null);
    }),
  );

  const rows: HindsightRow[] = early.map((p) => {
    const actual = positionPL(p)!;
    const close = usable(p) ? closes.get(`${p.underlying}|${p.expiry}`) ?? null : null;
    const held = close === null ? null : round2(payoffAt({ type: p.type, shortStrike: p.shortStrike, longStrike: p.longStrike, credit: p.credit!, quantity: positionQuantity(p) }, close));
    return { id: p.id, actual: round2(actual), held };
  });
  const both = rows.filter((r): r is HindsightRow & { held: number } => r.held !== null);
  const actualTotal = round2(both.reduce((s, r) => s + r.actual, 0));
  const heldTotal = round2(both.reduce((s, r) => s + r.held, 0));
  return {
    rows,
    compared: both.length,
    unknown: rows.length - both.length,
    actualTotal,
    heldTotal,
    difference: round2(heldTotal - actualTotal),
    betterHeld: both.filter((r) => r.held > r.actual).length,
    worseHeld: both.filter((r) => r.held < r.actual).length,
  };
}
