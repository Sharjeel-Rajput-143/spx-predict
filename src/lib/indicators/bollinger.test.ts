import { describe, expect, it } from "vitest";
import { bollinger } from "./bollinger";

describe("bollinger", () => {
  it("uses population (not sample) standard deviation - classic mean=5, popStdDev=2 example", () => {
    // [2,4,4,4,5,5,7,9]: mean 5, population variance 4, population stddev 2.
    const { middle, upper, lower } = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    expect(middle[7]).toBe(5);
    expect(upper[7]).toBe(9); // 5 + 2*2
    expect(lower[7]).toBe(1); // 5 - 2*2
  });

  it("is NaN before the window fills", () => {
    const { middle, upper, lower } = bollinger([1, 2, 3], 5);
    expect(middle[2]).toBeNaN();
    expect(upper[2]).toBeNaN();
    expect(lower[2]).toBeNaN();
  });
});
