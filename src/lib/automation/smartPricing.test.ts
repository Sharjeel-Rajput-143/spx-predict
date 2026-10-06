import { describe, expect, it } from "vitest";
import { SMART_PRICING_PRESETS, buildLadder, describeLadder, spreadMarket, type LegQuotes } from "./smartPricing";

// A 10-wide NDX put spread: short 20,990 put 12.00 x 12.60, long 20,980 put 8.70 x 9.30.
const legs: LegQuotes = { short: { bid: 12.0, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } };

describe("the spread's market", () => {
  it("selling (a credit): the worst price hits the short's bid and lifts the long's ask", () => {
    const m = spreadMarket("credit", legs)!;
    expect(m.natural).toBeCloseTo(2.7); // 12.00 - 9.30
    expect(m.best).toBeCloseTo(3.9); // 12.60 - 8.70
    expect(m.mid).toBeCloseTo(3.3);
  });

  it("buying it back (a debit): the most you'd pay is the short's ask less the long's bid", () => {
    const m = spreadMarket("debit", legs)!;
    expect(m.natural).toBeCloseTo(3.9);
    expect(m.best).toBeCloseTo(2.7);
    expect(m.mid).toBeCloseTo(3.3);
  });

  it("is not a market when a quote is missing or crossed", () => {
    expect(spreadMarket("credit", { ...legs, short: { bid: NaN, ask: 1 } })).toBeNull();
    expect(spreadMarket("credit", { ...legs, long: { bid: 9.5, ask: 9.3 } })).toBeNull();
  });
});

describe("the ladder", () => {
  it("Normal: up to four prices from the mid down to the final price, 10 seconds each", () => {
    const r = buildLadder({ side: "credit", legs, mode: "normal", finalPercent: 100 });
    expect(r.ok && r.ladder).toMatchObject({ mid: 3.3, final: 2.7, secondsEach: 10 });
    expect(r.ok && r.ladder.prices).toEqual([3.3, 3.1, 2.9, 2.7]);
  });

  it("starts at the mid and ends at the final price, never beyond it", () => {
    for (const mode of ["normal", "fast", "patient"] as const) {
      const r = buildLadder({ side: "credit", legs, mode, finalPercent: 100 });
      if (!r.ok) throw new Error(r.reason);
      expect(r.ladder.prices[0]).toBe(3.3);
      expect(r.ladder.prices.at(-1)).toBe(2.7);
      expect(r.ladder.prices.length).toBeLessThanOrEqual(SMART_PRICING_PRESETS[mode].prices);
      expect([...r.ladder.prices].sort((a, b) => b - a)).toEqual(r.ladder.prices); // only ever worse for the seller
    }
  });

  it("Fast and Patient have their own count and timing", () => {
    const fast = buildLadder({ side: "credit", legs, mode: "fast", finalPercent: 100 });
    const patient = buildLadder({ side: "credit", legs, mode: "patient", finalPercent: 100 });
    expect(fast.ok && [fast.ladder.prices.length, fast.ladder.secondsEach]).toEqual([3, 5]);
    expect(patient.ok && [patient.ladder.prices.length, patient.ladder.secondsEach]).toEqual([5, 20]);
  });

  it("Off: one limit order at the final price", () => {
    const r = buildLadder({ side: "credit", legs, mode: "off", finalPercent: 100 });
    expect(r.ok && r.ladder.prices).toEqual([2.7]);
  });

  it("a final price under 100% stops short of the bid/ask", () => {
    const r = buildLadder({ side: "credit", legs, mode: "normal", finalPercent: 50 });
    expect(r.ok && r.ladder.prices).toEqual([3.3, 3.2, 3.1, 3.0]); // final = 3.3 - 0.5 x 0.6 = 3.0
    const off = buildLadder({ side: "credit", legs, mode: "off", finalPercent: 50 });
    expect(off.ok && off.ladder.prices).toEqual([3.0]);
  });

  it("buying back walks the other way: up from the mid toward the ask-side price", () => {
    const r = buildLadder({ side: "debit", legs, mode: "normal", finalPercent: 100 });
    expect(r.ok && r.ladder.prices).toEqual([3.3, 3.5, 3.7, 3.9]);
  });

  it("a tight spread has fewer distinct prices than the preset allows", () => {
    const tight: LegQuotes = { short: { bid: 12.0, ask: 12.1 }, long: { bid: 8.7, ask: 8.8 } };
    const r = buildLadder({ side: "credit", legs: tight, mode: "normal", finalPercent: 100 });
    expect(r.ok && r.ladder.prices.length).toBeLessThan(4);
    expect(r.ok && r.ladder.prices.at(-1)).toBe(3.2); // 12.00 - 8.80
  });

  it("every price is on the tick, and a credit never reaches the width", () => {
    const r = buildLadder({ side: "credit", legs: { short: { bid: 20, ask: 20.4 }, long: { bid: 9.7, ask: 10.1 } }, mode: "normal", finalPercent: 100, width: 10 });
    if (!r.ok) throw new Error(r.reason);
    for (const p of r.ladder.prices) {
      expect(Math.abs(p / 0.05 - Math.round(p / 0.05))).toBeLessThan(1e-9);
      expect(p).toBeLessThan(10);
    }
  });

  it("refuses a spread with nothing to sell at: a zero or negative mid, or no market", () => {
    const dead: LegQuotes = { short: { bid: 0, ask: 0.05 }, long: { bid: 0, ask: 0.05 } };
    expect(buildLadder({ side: "credit", legs: dead, mode: "normal", finalPercent: 100 })).toMatchObject({ ok: false });
    expect(buildLadder({ side: "credit", legs: { short: { bid: NaN, ask: 1 }, long: legs.long }, mode: "normal", finalPercent: 100 })).toMatchObject({ ok: false, reason: expect.stringMatching(/missing or crossed/) });
  });

  it("a price is never below one tick, even when the natural price is zero or worse", () => {
    const thin: LegQuotes = { short: { bid: 1.0, ask: 1.6 }, long: { bid: 0.9, ask: 1.5 } }; // natural credit = -0.5
    const r = buildLadder({ side: "credit", legs: thin, mode: "normal", finalPercent: 100 });
    expect(r.ok && Math.min(...r.ladder.prices)).toBeGreaterThanOrEqual(0.05);
  });

  it("reads as a sentence", () => {
    const r = buildLadder({ side: "credit", legs, mode: "normal", finalPercent: 100 });
    expect(r.ok && describeLadder(r.ladder, 100)).toBe("SmartPricing Normal: 3.30, 3.10, 2.90, 2.70 (10s each, mid 3.30, final 100% of bid/ask)");
    const off = buildLadder({ side: "credit", legs, mode: "off", finalPercent: 100 });
    expect(off.ok && describeLadder(off.ladder, 100)).toBe("Limit at 2.70 (100% of bid/ask, mid 3.30)");
  });
});
