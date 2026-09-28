import type { OHLCV } from "./types";

/**
 * Volume Weighted Average Price, anchored at the start of `bars` (or reset
 * at each new session boundary when `isNewSession` is given - typically a
 * new exchange trading day):
 *   typicalPrice = (h + l + c) / 3
 *   vwap[i] = sum(typicalPrice * volume) / sum(volume)   since the last anchor
 *
 * Only meaningful for symbols that report volume (see Ticker.hasVolume).
 */
export function vwap(bars: OHLCV[], isNewSession?: (bar: OHLCV, index: number, bars: OHLCV[]) => boolean): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < bars.length; i++) {
    if (isNewSession?.(bars[i], i, bars)) {
      cumPV = 0;
      cumV = 0;
    }
    const bar = bars[i];
    const typical = (bar.h + bar.l + bar.c) / 3;
    const v = bar.v ?? 0;
    cumPV += typical * v;
    cumV += v;
    out[i] = cumV > 0 ? cumPV / cumV : NaN;
  }
  return out;
}
