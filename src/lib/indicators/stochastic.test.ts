import { describe, expect, it } from "vitest";
import { stochastic } from "./stochastic";
import type { OHLCV } from "./types";

describe("stochastic", () => {
  it("matches hand-computed %K/%D with no extra smoothing (kSmooth=1)", () => {
    const bars: OHLCV[] = [
      { o: 9, h: 10, l: 8, c: 9 },
      { o: 11, h: 12, l: 9, c: 11 },
      { o: 10.5, h: 11, l: 10, c: 10.5 },
      { o: 12, h: 13, l: 10, c: 12 },
    ];
    // kLength=2: window [0,1] hi=12 lo=8 range=4 -> rawK[1]=100*(11-8)/4=75
    //            window [1,2] hi=12 lo=9 range=3 -> rawK[2]=100*(10.5-9)/3=50
    //            window [2,3] hi=13 lo=10 range=3 -> rawK[3]=100*(12-10)/3=66.667
    const { k, d } = stochastic(bars, 2, 1, 2);
    expect(k[1]).toBeCloseTo(75, 6);
    expect(k[2]).toBeCloseTo(50, 6);
    expect(k[3]).toBeCloseTo(66.667, 2);
    // d[2] = mean(k[1],k[2]) = 62.5; d[3] = mean(k[2],k[3]) = 58.333
    expect(d[2]).toBeCloseTo(62.5, 6);
    expect(d[3]).toBeCloseTo(58.333, 2);
  });

  it("returns 50 for a flat (zero-range) window instead of dividing by zero", () => {
    const bars: OHLCV[] = [
      { o: 5, h: 5, l: 5, c: 5 },
      { o: 5, h: 5, l: 5, c: 5 },
    ];
    const { k } = stochastic(bars, 2, 1, 1);
    expect(k[1]).toBe(50);
  });
});
