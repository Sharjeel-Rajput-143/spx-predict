/**
 * Indicators are pure functions over plain arrays - no chart, no React, no
 * clock. `NaN` marks a warm-up index that has no valid value yet, so output
 * arrays are always the same length as their input.
 */

/** Minimal OHLCV shape. `t` (epoch ms) is only used by vwap's session reset. */
export interface OHLCV {
  t?: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}
