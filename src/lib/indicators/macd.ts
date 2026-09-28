import { ema } from "./ema";

export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

/**
 * MACD, defaults 12/26/9 (all EMA) - matches TradingView's built-in MACD:
 *   macd = ema(values, fast) - ema(values, slow)
 *   signal = ema(macd, signalLength)   (the EMA-of-EMA is itself SMA-seeded
 *            over the first valid `signalLength` macd values)
 *   histogram = macd - signal
 */
export function macd(values: number[], fast = 12, slow = 26, signalLength = 9): MACDResult {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const macdLine = values.map((_, i) => fastEma[i] - slowEma[i]);

  // ema() expects a dense array with no leading NaNs, so seed the signal
  // line only from the point macdLine first becomes valid (index slow-1).
  const firstValid = slow - 1;
  const validMacd = macdLine.slice(firstValid);
  const signalOnValid = ema(validMacd, signalLength);

  const signal = new Array<number>(values.length).fill(NaN);
  for (let i = 0; i < signalOnValid.length; i++) signal[firstValid + i] = signalOnValid[i];

  const histogram = macdLine.map((m, i) => m - signal[i]);
  return { macd: macdLine, signal, histogram };
}
