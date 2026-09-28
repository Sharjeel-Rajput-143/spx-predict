/**
 * Relative Strength Index using Wilder smoothing (RMA), default length 14 -
 * matches TradingView's built-in RSI:
 *   gain[i] = max(v[i]-v[i-1], 0); loss[i] = max(v[i-1]-v[i], 0)
 *   avgGain[length] = mean(gain[1..length]); avgLoss[length] = mean(loss[1..length])
 *   avgGain[i] = (avgGain[i-1]*(length-1) + gain[i]) / length   for i > length
 *   RS = avgGain / avgLoss;  RSI = 100 - 100/(1+RS)
 * RSI is 100 when avgLoss is 0 (all up moves in the lookback).
 */
export function rsi(values: number[], length = 14): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= length) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const delta = values[i] - values[i - 1];
    avgGain += Math.max(delta, 0);
    avgLoss += Math.max(-delta, 0);
  }
  avgGain /= length;
  avgLoss /= length;
  out[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = length + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    const gain = Math.max(delta, 0);
    const loss = Math.max(-delta, 0);
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return out;
}
