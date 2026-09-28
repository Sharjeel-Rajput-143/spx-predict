import { describe, expect, it } from "vitest";
import { vwap } from "./vwap";
import type { OHLCV } from "./types";

function bar(c: number, v: number): OHLCV {
  return { o: c, h: c, l: c, c, v }; // flat bar so typical price = close
}

describe("vwap", () => {
  it("is the cumulative volume-weighted average price", () => {
    const bars = [bar(10, 100), bar(20, 100), bar(30, 200)];
    // vwap[0] = 10
    // vwap[1] = (10*100 + 20*100) / 200 = 15
    // vwap[2] = (3000 + 30*200) / 400 = 22.5
    expect(vwap(bars)).toEqual([10, 15, 22.5]);
  });

  it("resets at a new session", () => {
    const bars = [bar(10, 100), bar(20, 100), bar(30, 200)];
    const out = vwap(bars, (_b, i) => i === 2);
    expect(out[2]).toBe(30);
  });

  it("is NaN with zero cumulative volume", () => {
    expect(vwap([bar(10, 0)])[0]).toBeNaN();
  });
});
