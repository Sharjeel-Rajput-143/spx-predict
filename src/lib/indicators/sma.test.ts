import { describe, expect, it } from "vitest";
import { sma } from "./sma";

describe("sma", () => {
  it("matches hand-computed 3-period average", () => {
    // [1,2,3,4,5,6] length 3 -> (1+2+3)/3=2, (2+3+4)/3=3, (3+4+5)/3=4, (4+5+6)/3=5
    const out = sma([1, 2, 3, 4, 5, 6], 3);
    expect(out.slice(0, 2)).toEqual([NaN, NaN]);
    expect(out.slice(2)).toEqual([2, 3, 4, 5]);
  });

  it("slides correctly with a non-trivial series", () => {
    const out = sma([10, 20, 30, 40], 2);
    expect(out).toEqual([NaN, 15, 25, 35]);
  });
});
