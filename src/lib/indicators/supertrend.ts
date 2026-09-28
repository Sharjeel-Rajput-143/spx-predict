import { atr } from "./atr";
import type { OHLCV } from "./types";

export interface SupertrendPoint {
  value: number;
  /** 1 = uptrend (line sits below price), -1 = downtrend (line sits above price). */
  direction: 1 | -1;
}

/**
 * Supertrend, defaults length 10, multiplier 3 (on a Wilder/RMA ATR, same as
 * TradingView's built-in Supertrend):
 *   mid = (h+l)/2
 *   basicUpper = mid + multiplier*atr;  basicLower = mid - multiplier*atr
 *   finalUpper[i] = (basicUpper[i] < finalUpper[i-1] || close[i-1] > finalUpper[i-1])
 *                     ? basicUpper[i] : finalUpper[i-1]
 *   finalLower[i] = (basicLower[i] > finalLower[i-1] || close[i-1] < finalLower[i-1])
 *                     ? basicLower[i] : finalLower[i-1]
 *   direction flips to up when close crosses above finalUpper, down when it
 *   crosses below finalLower, and otherwise holds; the plotted line is
 *   finalLower while up, finalUpper while down.
 */
export function supertrend(bars: OHLCV[], length = 10, multiplier = 3): (SupertrendPoint | null)[] {
  const atrValues = atr(bars, length);
  const out: (SupertrendPoint | null)[] = new Array(bars.length).fill(null);

  let finalUpper = NaN;
  let finalLower = NaN;
  let direction: 1 | -1 = 1;

  for (let i = 0; i < bars.length; i++) {
    const a = atrValues[i];
    if (Number.isNaN(a)) continue;

    const mid = (bars[i].h + bars[i].l) / 2;
    const basicUpper = mid + multiplier * a;
    const basicLower = mid - multiplier * a;
    const prevClose = i > 0 ? bars[i - 1].c : bars[i].c;

    if (Number.isNaN(finalUpper)) {
      finalUpper = basicUpper;
      finalLower = basicLower;
    } else {
      finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
    }

    if (bars[i].c > finalUpper) direction = 1;
    else if (bars[i].c < finalLower) direction = -1;
    // else: direction unchanged (hold previous trend)

    out[i] = { value: direction === 1 ? finalLower : finalUpper, direction };
  }

  return out;
}
