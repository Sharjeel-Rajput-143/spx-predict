import { describe, expect, it } from "vitest";
import { wma } from "./wma";

describe("wma", () => {
  it("weights the most recent value highest (length=3)", () => {
    // weights sum = 1+2+3 = 6; wma = (3*9 + 2*6 + 1*3) / 6 = (27+12+3)/6 = 7
    const out = wma([3, 6, 9], 3);
    expect(out).toEqual([NaN, NaN, 7]);
  });

  it("slides across a longer series", () => {
    // next bar 12 appended: window [6,9,12] -> (3*12+2*9+1*6)/6 = (36+18+6)/6 = 10
    const out = wma([3, 6, 9, 12], 3);
    expect(out[3]).toBe(10);
  });
});
