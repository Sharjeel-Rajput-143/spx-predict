import { DEFAULT_PRICE_TICK } from "./smartPricing";

/**
 * REHEARSAL close chase. A paper account without a data subscription quotes delayed prices, and a close priced from them can top out below
 * where the real market is: the ladder's last price (100% of the quote's worst price) never fills. With CLOSE_CHASE_MAX set, a close ladder
 * that has failed to fill at its top rung goes on in the same step size, above the quote's worst price, up to the worst price plus
 * CLOSE_CHASE_MAX, and never at or above the spread's width. Pure arithmetic: no I/O.
 *
 * It exists for rehearsing on a paper account only (the engine ignores the setting unless the bridge says the account is paper) and is
 * for closes only: an open is never chased.
 */

/** The step used when the ladder has only one price to take a step from. */
export const CHASE_FALLBACK_STEP = 0.5;

const cents = (n: number) => Math.round(n * 100) / 100;
const toTick = (p: number) => cents(Math.round(p / DEFAULT_PRICE_TICK) * DEFAULT_PRICE_TICK);

export interface ChaseInput {
  /** The close ladder's prices, in order (a debit: each one higher than the last). */
  prices: readonly number[];
  /** The quote's worst price for the close: the most it could cost (short leg's ask less the long leg's bid). */
  worst: number;
  /** CLOSE_CHASE_MAX, in dollars above the worst price. */
  max: number;
  /** The spread's width in points: a close is never priced at or above it. */
  width?: number;
  /** A price the chase never goes above (the broker's mark + CLOSE_MAX_ABOVE_MARKET, when CLOSE_USE_MARKS is in force). */
  ceiling?: number;
}

export type ChaseResult = { ok: true; prices: number[]; limit: number; step: number } | { ok: false; reason: string };

export function chaseRungs(input: ChaseInput): ChaseResult {
  const { prices, worst, max, width } = input;
  if (!(max > 0)) return { ok: false, reason: "CLOSE_CHASE_MAX is off" };
  if (prices.length === 0) return { ok: false, reason: "the close has no ladder to continue" };
  const top = prices[prices.length - 1];
  // Only a ladder that has really reached the quote's worst price is continued; one the bot stopped short of it on purpose is left alone.
  if (top < worst - 1e-9) return { ok: false, reason: `the ladder's top price ${top.toFixed(2)} is below the quote's worst price ${worst.toFixed(2)}` };
  const step = prices.length >= 2 ? cents(top - prices[prices.length - 2]) : CHASE_FALLBACK_STEP;
  if (!(step > 0)) return { ok: false, reason: "the ladder has no step to continue with" };
  const limit = Math.min(cents(worst + max), width !== undefined ? cents(width - DEFAULT_PRICE_TICK) : Infinity, input.ceiling ?? Infinity);
  const out: number[] = [];
  for (let k = 1; k < 1000; k++) {
    const p = toTick(top + k * step);
    if (p > limit + 1e-9) break;
    if (p <= top + 1e-9) continue;
    if (out.length === 0 || p > out[out.length - 1] + 1e-9) out.push(p);
  }
  if (out.length === 0) return { ok: false, reason: `no price above ${top.toFixed(2)} fits under ${limit.toFixed(2)}${width !== undefined ? ` (the spread's width is ${width})` : ""}` };
  return { ok: true, prices: out, limit, step };
}
