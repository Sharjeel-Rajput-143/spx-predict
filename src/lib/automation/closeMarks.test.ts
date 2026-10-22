import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMarkCeiling, spreadMarkOf } from "./closeMarks";
import { closeUseMarks } from "./config";

describe("the spread's mark, from the account's own positions", () => {
  const legs = { short: "NDXP261016C29700000", long: "NDXP261016C29750000" };
  const held = (short: number | undefined, long: number | undefined, q = 1) => [
    { symbol: legs.long, quantity: q, ...(long !== undefined ? { marketPrice: long } : {}) },
    { symbol: legs.short, quantity: -q, ...(short !== undefined ? { marketPrice: short } : {}) },
  ];

  it("is the short leg's market price less the long leg's", () => {
    expect(spreadMarkOf(held(13.64, 8.74), legs, 1)).toBe(4.9);
    expect(spreadMarkOf(held(11.65, 7.87), legs, 1)).toBe(3.78);
  });

  it("is null, never a guess, when a leg has no mark, the account does not hold the whole spread, or the result is not above 0", () => {
    expect(spreadMarkOf(held(13.64, undefined), legs, 1)).toBeNull();
    expect(spreadMarkOf(held(undefined, 8.74), legs, 1)).toBeNull();
    expect(spreadMarkOf([], legs, 1)).toBeNull();
    expect(spreadMarkOf([{ symbol: legs.short, quantity: -1, marketPrice: 5 }], legs, 1)).toBeNull(); // only one leg
    expect(spreadMarkOf(held(5, 5), legs, 1)).toBeNull(); // zero
    expect(spreadMarkOf(held(4, 5), legs, 1)).toBeNull(); // negative
    expect(spreadMarkOf(held(13.64, 8.74, 1), legs, 2)).toBeNull(); // holds 1, needs 2
    expect(spreadMarkOf(held(0, 8.74), legs, 1)).toBeNull(); // a mark of 0 is no mark
  });
});

describe("the ceiling from the broker's mark", () => {
  const ladder = [17, 17.65, 18.35, 19];

  it("replaces a quote far above the mark with a ladder from the mark up to mark + the allowance", () => {
    const r = applyMarkCeiling({ prices: ladder, mid: 17, mark: 3.79, maxAbove: 1, width: 50 });
    expect(r).toMatchObject({ ok: true, kind: "rebuilt", ceiling: 4.75 });
    if (r.ok) {
      expect(r.prices).toEqual([3.8, 4.1, 4.45, 4.75]);
      expect(Math.max(...r.prices)).toBeLessThanOrEqual(r.ceiling);
      expect(r.note).toMatch(/The quote's mid 17\.00 is above the broker's mark: the broker's mark is 3\.79, so the ceiling is 3\.79 \+ 1\.00 = 4\.75\. Priced from the marks instead: 3\.80, 4\.10, 4\.45, 4\.75\./);
    }
  });

  it("caps a ladder whose mid fits but whose top does not", () => {
    const r = applyMarkCeiling({ prices: [3.3, 3.5, 3.7, 3.9], mid: 3.3, mark: 2.5, maxAbove: 1, width: 10 });
    expect(r).toMatchObject({ ok: true, kind: "clamped", prices: [3.3, 3.5], ceiling: 3.5 });
  });

  it("leaves a ladder within the ceiling alone", () => {
    const r = applyMarkCeiling({ prices: [3.3, 3.5, 3.7, 3.9], mid: 3.3, mark: 3.5, maxAbove: 1, width: 10 });
    expect(r).toMatchObject({ ok: true, kind: "within", prices: [3.3, 3.5, 3.7, 3.9], ceiling: 4.5 });
  });

  it("is never at or above the width, whatever the allowance", () => {
    const r = applyMarkCeiling({ prices: [3.3, 3.9], mid: 3.3, mark: 1.2, maxAbove: 50, width: 10 });
    expect(r.ok && r.ceiling).toBe(9.95);
  });

  it("an allowance of 0 or less means the mark itself is the ceiling", () => {
    expect(applyMarkCeiling({ prices: [17, 19], mid: 17, mark: 3.79, maxAbove: 0 })).toMatchObject({ ok: true, ceiling: 3.75 });
    expect(applyMarkCeiling({ prices: [17, 19], mid: 17, mark: 3.79, maxAbove: -4 })).toMatchObject({ ok: true, ceiling: 3.75 });
  });

  it("a single-price ladder becomes the ceiling", () => {
    expect(applyMarkCeiling({ prices: [19], mid: 19, mark: 3.79, maxAbove: 1 })).toMatchObject({ ok: true, kind: "rebuilt", prices: [4.75] });
  });

  it("every price is on the 0.05 tick, rising, and no price is repeated", () => {
    const r = applyMarkCeiling({ prices: [17, 17.65, 18.35, 19, 19.5, 20], mid: 17, mark: 0.2, maxAbove: 0.1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      for (const p of r.prices) expect(Math.abs(p * 20 - Math.round(p * 20))).toBeLessThan(1e-6);
      expect([...r.prices].sort((a, b) => a - b)).toEqual(r.prices);
      expect(new Set(r.prices).size).toBe(r.prices.length);
    }
  });

  it("gives up, saying why, on a mark that is not above 0 or a ceiling with no room", () => {
    expect(applyMarkCeiling({ prices: [17], mid: 17, mark: 0, maxAbove: 1 })).toMatchObject({ ok: false });
    expect(applyMarkCeiling({ prices: [], mid: 17, mark: 3, maxAbove: 1 })).toMatchObject({ ok: false });
    expect(applyMarkCeiling({ prices: [17], mid: 17, mark: 3, maxAbove: 1, width: 0.05 })).toMatchObject({ ok: false });
  });
});

describe("CLOSE_USE_MARKS", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is off unless exactly 1 or true", () => {
    expect(closeUseMarks()).toBe(false);
    for (const v of ["", "0", "yes", "2", "false"]) {
      vi.stubEnv("CLOSE_USE_MARKS", v);
      expect(closeUseMarks()).toBe(false);
    }
    for (const v of ["1", "true", " TRUE "]) {
      vi.stubEnv("CLOSE_USE_MARKS", v);
      expect(closeUseMarks()).toBe(true);
    }
  });
});
