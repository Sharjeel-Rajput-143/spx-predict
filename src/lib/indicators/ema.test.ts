import { describe, expect, it } from "vitest";
import { ema } from "./ema";

describe("ema", () => {
  it("seeds with SMA then applies the recursive smoothing (length=3, alpha=0.5)", () => {
    // seed = sma([1,2,3]) = 2; ema[3] = (4-2)*0.5+2 = 3; ema[4] = (5-3)*0.5+3 = 4
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out).toEqual([NaN, NaN, 2, 3, 4]);
  });

  it("returns all-NaN when there isn't enough data to seed", () => {
    expect(ema([1, 2], 3)).toEqual([NaN, NaN]);
  });
});
