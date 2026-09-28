import { describe, expect, it } from "vitest";
import { supertrend } from "./supertrend";
import type { OHLCV } from "./types";

describe("supertrend", () => {
  it("trails price in an uptrend and flips direction on a sharp drop below the lower band", () => {
    const bars: OHLCV[] = [
      { o: 9, h: 10, l: 8, c: 9 },
      { o: 10, h: 11, l: 9, c: 10 },
      { o: 11, h: 12, l: 10, c: 11 },
      { o: 12, h: 13, l: 11, c: 12 },
      { o: 13, h: 14, l: 12, c: 13 },
      { o: 3, h: 4, l: 2, c: 3 }, // sharp drop
    ];
    // ATR(length=2) is a constant 2 through bar 4 (every bar's true range is
    // 2), so the lower band ratchets up 1-for-1 with the rising mid price.
    const out = supertrend(bars, 2, 1);
    expect(out[1]).toEqual({ value: 8, direction: 1 });
    expect(out[2]).toEqual({ value: 9, direction: 1 });
    expect(out[3]).toEqual({ value: 10, direction: 1 });
    expect(out[4]).toEqual({ value: 11, direction: 1 });
    // Bar 5's true range jumps to 11 (|4-13|), ATR -> (2*1+11)/2 = 6.5,
    // upper band -> mid(3)+6.5 = 9.5, and close(3) < the held lower band(11)
    // flips the trend down onto the upper band.
    expect(out[5]).toEqual({ value: 9.5, direction: -1 });
  });

  it("is null until ATR has warmed up", () => {
    const bars: OHLCV[] = [
      { o: 9, h: 10, l: 8, c: 9 },
      { o: 10, h: 11, l: 9, c: 10 },
    ];
    expect(supertrend(bars, 5)[0]).toBeNull();
    expect(supertrend(bars, 5)[1]).toBeNull();
  });
});
