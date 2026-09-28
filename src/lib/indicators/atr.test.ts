import { describe, expect, it } from "vitest";
import { atr } from "./atr";
import type { OHLCV } from "./types";

describe("atr", () => {
  it("equals the constant true range when every bar's range is the same", () => {
    const bars: OHLCV[] = [
      { o: 9, h: 10, l: 8, c: 9 },
      { o: 10, h: 11, l: 9, c: 10 },
      { o: 11, h: 12, l: 10, c: 11 },
      { o: 12, h: 13, l: 11, c: 12 },
    ];
    expect(atr(bars, 3)).toEqual([NaN, NaN, 2, 2]);
  });

  it("applies Wilder (RMA) smoothing to a changing true range, length=2", () => {
    // TR sequence by construction: [4, 2, 2, 2]
    const bars: OHLCV[] = [
      { o: 8, h: 10, l: 6, c: 8 },
      { o: 8, h: 9, l: 7, c: 8 },
      { o: 8, h: 9, l: 7, c: 8 },
      { o: 8, h: 9, l: 7, c: 8 },
    ];
    // seed = mean(4,2) = 3; then (3*1+2)/2 = 2.5; then (2.5*1+2)/2 = 2.25
    const out = atr(bars, 2);
    expect(out[1]).toBe(3);
    expect(out[2]).toBe(2.5);
    expect(out[3]).toBe(2.25);
  });
});
