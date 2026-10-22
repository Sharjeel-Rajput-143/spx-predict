import type { BrokerPosition } from "./types";
import { DEFAULT_PRICE_TICK } from "./smartPricing";

/**
 * REHEARSAL: the broker's own marks as a ceiling on a close. A paper account on delayed data can give leg quotes that are far from where
 * the broker itself values the spread (a stale quote near 15 to 19 against a mark of 3.79), and IBKR cancels a close BUY priced far above
 * its own price within about a second, with no reason. With CLOSE_USE_MARKS on, a close is never sent above
 * mark + CLOSE_MAX_ABOVE_MARKET (the chase and the price-band re-pricing included). Pure arithmetic: no I/O.
 */

const cents = (n: number) => Math.round(n * 100) / 100;
const floorTick = (p: number) => cents(Math.floor(p / DEFAULT_PRICE_TICK + 1e-9) * DEFAULT_PRICE_TICK);
const nearestTick = (p: number) => cents(Math.round(p / DEFAULT_PRICE_TICK) * DEFAULT_PRICE_TICK);

/**
 * The spread's mark from the account's own positions: the short leg's market price less the long leg's. Null unless the account holds the
 * whole spread in this size, both legs carry a market price above 0, and the result is above 0 - never a guess.
 */
export function spreadMarkOf(held: readonly BrokerPosition[], legs: { short: string; long: string }, quantity: number): number | null {
  const sum = (symbol: string) => held.filter((h) => h.symbol === symbol);
  const shortRows = sum(legs.short);
  const longRows = sum(legs.long);
  const shortQty = shortRows.reduce((s, h) => s + h.quantity, 0);
  const longQty = longRows.reduce((s, h) => s + h.quantity, 0);
  if (!(shortQty <= -quantity && longQty >= quantity)) return null;
  const price = (rows: BrokerPosition[]) => {
    const prices = rows.map((r) => r.marketPrice).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
    return prices.length === rows.length && prices.length > 0 ? prices[0] : null;
  };
  const s = price(shortRows);
  const l = price(longRows);
  if (s === null || l === null) return null;
  const mark = cents(s - l);
  return mark > 0 ? mark : null;
}

export interface MarkCeilingInput {
  /** The close ladder's prices (a debit: rising). */
  prices: readonly number[];
  /** The ladder's first price (the quote's mid). */
  mid: number;
  /** The broker's mark for the spread. */
  mark: number;
  /** CLOSE_MAX_ABOVE_MARKET. */
  maxAbove: number;
  /** The spread's width: never at or above it. */
  width?: number;
}

export type MarkCeilingResult =
  | { ok: true; kind: "within" | "clamped" | "rebuilt"; prices: number[]; ceiling: number; note: string }
  | { ok: false; reason: string };

export function applyMarkCeiling(input: MarkCeilingInput): MarkCeilingResult {
  const { prices, mid, mark, maxAbove, width } = input;
  if (!(mark > 0)) return { ok: false, reason: "the mark is not above 0" };
  if (prices.length === 0) return { ok: false, reason: "the close has no ladder" };
  const ceiling = Math.min(floorTick(mark + Math.max(0, maxAbove)), width !== undefined ? cents(width - DEFAULT_PRICE_TICK) : Infinity);
  if (!(ceiling >= DEFAULT_PRICE_TICK)) return { ok: false, reason: `no price above zero fits under ${ceiling.toFixed(2)}` };
  const where = `the broker's mark is ${mark.toFixed(2)}, so the ceiling is ${mark.toFixed(2)} + ${Math.max(0, maxAbove).toFixed(2)} = ${ceiling.toFixed(2)}`;
  if (prices.every((p) => p <= ceiling + 1e-9)) {
    return { ok: true, kind: "within", prices: [...prices], ceiling, note: `Broker marks checked: ${where}; the ladder is within it.` };
  }
  const n = prices.length;
  if (mid > ceiling + 1e-9) {
    const start = Math.max(DEFAULT_PRICE_TICK, Math.min(nearestTick(mark), ceiling));
    const raw = n === 1 ? [ceiling] : Array.from({ length: n }, (_, i) => start + ((ceiling - start) * i) / (n - 1));
    const out: number[] = [];
    for (const r of raw) {
      const p = Math.min(Math.max(nearestTick(r), DEFAULT_PRICE_TICK), ceiling);
      if (out.length === 0 || p > out[out.length - 1] + 1e-9) out.push(p);
    }
    return {
      ok: true,
      kind: "rebuilt",
      prices: out,
      ceiling,
      note: `The quote's mid ${mid.toFixed(2)} is above the broker's mark: ${where}. Priced from the marks instead: ${out.map((p) => p.toFixed(2)).join(", ")}.`,
    };
  }
  const out: number[] = [];
  for (const p of prices) {
    const c = Math.min(p, ceiling);
    if (out.length === 0 || c > out[out.length - 1] + 1e-9) out.push(c);
  }
  return {
    ok: true,
    kind: "clamped",
    prices: out,
    ceiling,
    note: `Ladder prices above the ceiling were capped: ${where}. The ladder is now ${out.map((p) => p.toFixed(2)).join(", ")}.`,
  };
}
