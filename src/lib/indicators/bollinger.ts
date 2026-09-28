import { sma } from "./sma";

export interface BollingerBands {
  middle: number[];
  upper: number[];
  lower: number[];
}

/**
 * Bollinger Bands: SMA middle band, +/- `mult` population standard
 * deviations (divide by N, not N-1 - matches TradingView's built-in BB,
 * default length 20, mult 2).
 */
export function bollinger(values: number[], length = 20, mult = 2): BollingerBands {
  const middle = sma(values, length);
  const upper = new Array<number>(values.length).fill(NaN);
  const lower = new Array<number>(values.length).fill(NaN);

  for (let i = length - 1; i < values.length; i++) {
    const mean = middle[i];
    let variance = 0;
    for (let j = 0; j < length; j++) {
      const d = values[i - j] - mean;
      variance += d * d;
    }
    variance /= length; // population variance
    const stdDev = Math.sqrt(variance);
    upper[i] = mean + mult * stdDev;
    lower[i] = mean - mult * stdDev;
  }

  return { middle, upper, lower };
}
