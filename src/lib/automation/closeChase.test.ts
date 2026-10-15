import { afterEach, describe, expect, it, vi } from "vitest";
import { CHASE_FALLBACK_STEP, chaseRungs } from "./closeChase";
import { closeChaseMax } from "./config";

describe("the rehearsal close chase: the prices after a ladder's top price", () => {
  const ladder = [3.65, 4.2, 4.75, 5.3]; // the 29700/29650 spread: mid 3.65, worst price 5.30, steps of 0.55

  it("continues in the same step size above the worst price, up to the worst price plus the maximum", () => {
    const r = chaseRungs({ prices: ladder, worst: 5.3, max: 3, width: 50 });
    expect(r).toEqual({ ok: true, prices: [5.85, 6.4, 6.95, 7.5, 8.05], limit: 8.3, step: 0.55 });
  });

  it("never goes past the worst price plus the maximum", () => {
    const r = chaseRungs({ prices: ladder, worst: 5.3, max: 1, width: 50 });
    expect(r.ok && r.prices).toEqual([5.85]);
    expect(r.ok && Math.max(...r.prices)).toBeLessThanOrEqual(6.3);
  });

  it("is never at or above the spread's width, however large the maximum", () => {
    const r = chaseRungs({ prices: [3.3, 3.5, 3.7, 3.9], worst: 3.9, max: 50, width: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.limit).toBe(9.95);
      expect(r.prices.every((p) => p < 10)).toBe(true);
      expect(Math.max(...r.prices)).toBeLessThanOrEqual(9.95);
      expect(r.prices[0]).toBeGreaterThan(3.9);
    }
  });

  it("says why when nothing fits under the width", () => {
    const r = chaseRungs({ prices: [8.5, 9.0, 9.5, 9.9], worst: 9.9, max: 3, width: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fits under 9\.95.*width is 10/);
  });

  it("is off with a zero or negative maximum, and leaves a ladder that stopped short of the worst price alone", () => {
    expect(chaseRungs({ prices: ladder, worst: 5.3, max: 0, width: 50 })).toMatchObject({ ok: false });
    expect(chaseRungs({ prices: ladder, worst: 5.3, max: -1, width: 50 })).toMatchObject({ ok: false });
    const short = chaseRungs({ prices: [3.65, 4.2, 4.75], worst: 5.3, max: 3, width: 50 });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.reason).toMatch(/below the quote's worst price/);
  });

  it("uses a fixed step when the ladder has a single price", () => {
    const r = chaseRungs({ prices: [5.3], worst: 5.3, max: 1.5, width: 50 });
    expect(r.ok && r.step).toBe(CHASE_FALLBACK_STEP);
    expect(r.ok && r.prices).toEqual([5.8, 6.3, 6.8]);
  });

  it("every price is on the 0.05 tick and strictly rising", () => {
    const r = chaseRungs({ prices: [3.3, 3.53, 3.77, 4.0], worst: 4.0, max: 2, width: 50 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      for (const p of r.prices) expect(Math.abs(p * 20 - Math.round(p * 20))).toBeLessThan(1e-6);
      expect([...r.prices].sort((a, b) => a - b)).toEqual(r.prices);
      expect(new Set(r.prices).size).toBe(r.prices.length);
    }
  });
});

describe("CLOSE_CHASE_MAX", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is off by default and for anything that is not a number above 0", () => {
    expect(closeChaseMax()).toBe(0);
    for (const v of ["", "0", "-2", "abc"]) {
      vi.stubEnv("CLOSE_CHASE_MAX", v);
      expect(closeChaseMax()).toBe(0);
    }
    vi.stubEnv("CLOSE_CHASE_MAX", "3");
    expect(closeChaseMax()).toBe(3);
  });
});
