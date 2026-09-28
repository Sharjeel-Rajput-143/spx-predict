import { sma } from "./sma";
import type { OHLCV } from "./types";

export interface StochasticResult {
  k: number[];
  d: number[];
}

/**
 * Stochastic Oscillator, defaults %K length 14, %K smoothing 3, %D length 3 -
 * matches TradingView's built-in Stochastic:
 *   rawK[i] = 100 * (close[i] - lowestLow(kLength)) / (highestHigh(kLength) - lowestLow(kLength))
 *   k = sma(rawK, kSmooth)      (the displayed, smoothed %K)
 *   d = sma(k, dLength)
 * rawK is 50 when the range is flat (highest === lowest) to avoid a 0/0 split.
 */
export function stochastic(bars: OHLCV[], kLength = 14, kSmooth = 3, dLength = 3): StochasticResult {
  const rawK = new Array<number>(bars.length).fill(NaN);
  for (let i = kLength - 1; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = 0; j < kLength; j++) {
      hi = Math.max(hi, bars[i - j].h);
      lo = Math.min(lo, bars[i - j].l);
    }
    const range = hi - lo;
    rawK[i] = range === 0 ? 50 : (100 * (bars[i].c - lo)) / range;
  }

  // sma() can't see NaN prefixes, so run it on a zero-filled copy and mask
  // the result back to NaN wherever the real window isn't fully valid yet.
  const validKStart = kLength - 1 + (kSmooth - 1);
  const k = sma(
    rawK.map((v) => (Number.isNaN(v) ? 0 : v)),
    kSmooth,
  ).map((v, i) => (i < validKStart ? NaN : v));

  const validDStart = validKStart + (dLength - 1);
  const d = sma(
    k.map((v) => (Number.isNaN(v) ? 0 : v)),
    dLength,
  ).map((v, i) => (i < validDStart ? NaN : v));

  return { k, d };
}
