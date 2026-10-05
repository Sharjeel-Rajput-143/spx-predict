import type { PositionType } from "./types";

/**
 * Expiry payoff of a short credit spread - pure arithmetic from the strikes,
 * the credit and the quantity, so none of it needs an option chain.
 * A put spread keeps the full credit while the underlying stays above the
 * short strike; a call spread while it stays below. Between the strikes the
 * loss grows one-for-one; beyond the long strike it is capped at the width.
 */
export interface Spread {
  type: PositionType;
  shortStrike: number;
  longStrike: number;
  /** Credit received per spread, in points. */
  credit: number;
  quantity: number;
}

export const width = (s: Spread) => Math.abs(s.shortStrike - s.longStrike);

/** Profit or loss in dollars if the underlying settles at `price`. */
export function payoffAt(s: Spread, price: number): number {
  const intrinsicLoss =
    s.type === "short_put_spread"
      ? Math.min(width(s), Math.max(0, s.shortStrike - price))
      : Math.min(width(s), Math.max(0, price - s.shortStrike));
  return (s.credit - intrinsicLoss) * 100 * s.quantity;
}

export const maxProfit = (s: Spread) => s.credit * 100 * s.quantity;
export const maxLoss = (s: Spread) => (width(s) - s.credit) * 100 * s.quantity;

/** Reward divided by risk: what you stand to keep per dollar you could lose. */
export const rewardRisk = (s: Spread): number | null => {
  const loss = maxLoss(s);
  return loss > 0 ? maxProfit(s) / loss : null;
};

export const breakeven = (s: Spread) => (s.type === "short_put_spread" ? s.shortStrike - s.credit : s.shortStrike + s.credit);

/** How far out of the money the short strike is, as a fraction of the
 * underlying. Negative means it is in the money. */
export function otmFraction(s: Pick<Spread, "type" | "shortStrike">, underlying: number): number {
  return s.type === "short_put_spread" ? (underlying - s.shortStrike) / underlying : (s.shortStrike - underlying) / underlying;
}

/** The underlying-price window to draw: a margin of 1.5x the width beyond the
 * strikes, widened to include the current price if it falls outside. */
export function priceRange(s: Spread, current?: number | null): { lo: number; hi: number } {
  const margin = width(s) * 1.5 || 5;
  let lo = Math.min(s.shortStrike, s.longStrike) - margin;
  let hi = Math.max(s.shortStrike, s.longStrike) + margin;
  if (current != null) {
    lo = Math.min(lo, current - margin / 2);
    hi = Math.max(hi, current + margin / 2);
  }
  return { lo, hi };
}
