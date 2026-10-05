import { describe, expect, it } from "vitest";
import { niceTicks } from "./chartScale";

describe("niceTicks", () => {
  it("uses round steps that bracket the data", () => {
    expect(niceTicks(0, 5000)).toEqual([0, 2000, 4000, 6000]);
    expect(niceTicks(-300, 420)).toEqual([-400, -200, 0, 200, 400, 600]);
    expect(niceTicks(0, 100)).toEqual([0, 25, 50, 75, 100]);
  });

  it("never repeats a label for a small count range (the bug: 2, 2, 1, 0, 0)", () => {
    const ticks = niceTicks(0, 2, true);
    expect(ticks).toEqual([0, 1, 2]);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(ticks.every(Number.isInteger)).toBe(true);
  });

  it("keeps integer steps for counts even when the data would suggest a fraction", () => {
    expect(niceTicks(0, 3, true).every(Number.isInteger)).toBe(true);
    expect(niceTicks(0, 1, true)).toEqual([0, 1]);
  });

  it("copes with a flat line", () => {
    const ticks = niceTicks(0, 0);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0]).toBe(0);
  });

  it("sorted ascending and evenly spaced", () => {
    const t = niceTicks(-1234, 8765);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
    const steps = new Set(t.slice(1).map((v, i) => Math.round((v - t[i]) * 1e6)));
    expect(steps.size).toBe(1);
  });
});
