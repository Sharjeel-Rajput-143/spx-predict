import type { OHLCV } from "./types";

/**
 * Average True Range using Wilder smoothing (RMA), default length 14 -
 * matches TradingView's built-in ATR:
 *   TR[i] = max(h-l, |h-prevClose|, |l-prevClose|); TR[0] = h[0]-l[0]
 *   ATR[length-1] = mean(TR[0..length-1])
 *   ATR[i] = (ATR[i-1]*(length-1) + TR[i]) / length   for i >= length
 */
export function atr(bars: OHLCV[], length = 14): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  if (bars.length === 0) return out;

  const tr = new Array<number>(bars.length);
  tr[0] = bars[0].h - bars[0].l;
  for (let i = 1; i < bars.length; i++) {
    const { h, l } = bars[i];
    const prevClose = bars[i - 1].c;
    tr[i] = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
  }

  if (bars.length < length) return out;

  let sum = 0;
  for (let i = 0; i < length; i++) sum += tr[i];
  let prevAtr = sum / length;
  out[length - 1] = prevAtr;

  for (let i = length; i < bars.length; i++) {
    prevAtr = (prevAtr * (length - 1) + tr[i]) / length;
    out[i] = prevAtr;
  }

  return out;
}
