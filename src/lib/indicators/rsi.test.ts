import { describe, expect, it } from "vitest";
import { rsi } from "./rsi";

describe("rsi", () => {
  it("is 100 when every move in the lookback is a gain (avgLoss=0)", () => {
    const out = rsi([1, 2, 3, 4, 5, 6, 7], 3);
    expect(out[3]).toBe(100);
    expect(out[6]).toBe(100);
  });

  it("applies Wilder (RMA) smoothing on an alternating series, length=3", () => {
    // Hand-computed: avgGain/avgLoss seeded from the mean of the first
    // `length` deltas, then recursively smoothed with weight (length-1)/length.
    const out = rsi([1, 2, 1, 2, 1, 2, 1], 3);
    expect(out[3]).toBeCloseTo(66.667, 2);
    expect(out[4]).toBeCloseTo(44.444, 2);
  });

  it("is NaN before the lookback is filled", () => {
    const out = rsi([1, 2], 3);
    expect(out.every(Number.isNaN)).toBe(true);
  });
});
