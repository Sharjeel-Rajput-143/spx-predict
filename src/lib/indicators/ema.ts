import { sma } from "./sma";

/**
 * Exponential Moving Average, seeded with the SMA of the first `length`
 * values (matches TradingView's built-in EMA, not a naive first-value seed):
 *   alpha = 2 / (length + 1)
 *   ema[length-1] = sma(values[0..length-1])
 *   ema[i] = (values[i] - ema[i-1]) * alpha + ema[i-1]   for i >= length
 */
export function ema(values: number[], length: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < length) return out;
  const alpha = 2 / (length + 1);
  const seed = sma(values, length)[length - 1];
  out[length - 1] = seed;
  let prev = seed;
  for (let i = length; i < values.length; i++) {
    prev = (values[i] - prev) * alpha + prev;
    out[i] = prev;
  }
  return out;
}
