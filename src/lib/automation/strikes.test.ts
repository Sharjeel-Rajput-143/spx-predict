import { describe, expect, it } from "vitest";
import { computeStrikes, maxRisk, validateStrikes } from "./strikes";
import type { StrikeConfig } from "./strikes";

const config: StrikeConfig = { putShortOffset: -20, callShortOffset: 20, widthPoints: 5, strikeIncrement: 5 };

describe("computeStrikes", () => {
  it("derives a put spread's strikes from price + offset, long from short", () => {
    const strikes = computeStrikes("short_put_spread", 7720, config);
    expect(strikes).toEqual({ shortStrike: 7700, longStrike: 7695 });
  });

  it("derives a call spread's strikes from price + offset, long from short", () => {
    const strikes = computeStrikes("short_call_spread", 7720, config);
    expect(strikes).toEqual({ shortStrike: 7740, longStrike: 7745 });
  });

  it("rounds to the nearest increment", () => {
    const strikes = computeStrikes("short_put_spread", 7722.6, config);
    expect(strikes.shortStrike % config.strikeIncrement).toBe(0);
  });
});

describe("validateStrikes", () => {
  it("accepts a valid put spread", () => {
    expect(validateStrikes("short_put_spread", { shortStrike: 7700, longStrike: 7695 }, config).ok).toBe(true);
  });

  it("accepts a valid call spread", () => {
    expect(validateStrikes("short_call_spread", { shortStrike: 7740, longStrike: 7745 }, config).ok).toBe(true);
  });

  it("rejects equal strikes - the exact Option Alpha 7715/7715 bug", () => {
    const result = validateStrikes("short_call_spread", { shortStrike: 7715, longStrike: 7715 }, config);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/equal/);
  });

  it("rejects a reversed put spread (short <= long)", () => {
    const result = validateStrikes("short_put_spread", { shortStrike: 7695, longStrike: 7700 }, config);
    expect(result.ok).toBe(false);
  });

  it("rejects a reversed call spread (short >= long)", () => {
    const result = validateStrikes("short_call_spread", { shortStrike: 7745, longStrike: 7740 }, config);
    expect(result.ok).toBe(false);
  });

  it("rejects strikes that aren't multiples of the increment", () => {
    const result = validateStrikes("short_put_spread", { shortStrike: 7702, longStrike: 7697 }, config);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/increment/);
  });

  it("rejects a gap that doesn't match the configured width", () => {
    const result = validateStrikes("short_put_spread", { shortStrike: 7700, longStrike: 7690 }, config);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/width/);
  });
});

describe("maxRisk", () => {
  it("matches the spec's worked example: width 5, qty 3, credit 2.20 -> 840", () => {
    expect(maxRisk(5, 3, 2.2)).toBeCloseTo(840, 5);
  });
});

import { describePlan, planStrikes, roundToStrike } from "./strikes";

// The live Option Alpha bot puts the short strike 0.01 beyond the price; the NDX bot mirrors that.
const live: StrikeConfig = { putShortOffset: -0.01, callShortOffset: 0.01, widthPoints: 10, strikeIncrement: 5 };

describe("rounding mode: out of the money (default) vs nearest", () => {
  it("the short put rounds DOWN and the short call rounds UP to the increment", () => {
    expect(roundToStrike(20_973.7, 5, "put", "outward")).toBe(20_970);
    expect(roundToStrike(21_033.7, 5, "call", "outward")).toBe(21_035);
    // Even when the closest strike is on the other side:
    expect(roundToStrike(20_974.9, 5, "put", "outward")).toBe(20_970);
    expect(roundToStrike(21_030.1, 5, "call", "outward")).toBe(21_035);
  });

  it("nearest picks the closest strike, ties up", () => {
    expect(roundToStrike(20_973.7, 5, "put", "nearest")).toBe(20_975);
    expect(roundToStrike(21_031.0, 5, "call", "nearest")).toBe(21_030);
    expect(roundToStrike(21_032.5, 5, "call", "nearest")).toBe(21_035);
  });

  it("a target already on a strike stays on it", () => {
    expect(roundToStrike(21_000, 5, "put", "outward")).toBe(21_000);
    expect(roundToStrike(21_000, 5, "call", "outward")).toBe(21_000);
  });

  it("is outward when the mode is left unset", () => {
    expect(planStrikes("short_put_spread", 20_973.7, { ...live, putShortOffset: 0 }).shortStrike).toBe(20_970);
  });
});

describe("decimal offsets: the live bot's -0.01 / +0.01", () => {
  it("lands the short strike on the first strike at or beyond the price", () => {
    // price 21,003.7: put target 21,003.69 -> down to 21,000; call target 21,003.71 -> up to 21,005
    expect(computeStrikes("short_put_spread", 21_003.7, live)).toEqual({ shortStrike: 21_000, longStrike: 20_990 });
    expect(computeStrikes("short_call_spread", 21_003.7, live)).toEqual({ shortStrike: 21_005, longStrike: 21_015 });
  });

  it("a price exactly on a strike still moves one strike out, because of the 0.01", () => {
    expect(computeStrikes("short_put_spread", 21_000, live).shortStrike).toBe(20_995);
    expect(computeStrikes("short_call_spread", 21_000, live).shortStrike).toBe(21_005);
  });

  it("float noise can't push a strike a whole increment the wrong way", () => {
    // 21,005.01 - 0.01 is 21,005 on paper but 21004.999999999996 in floating point.
    expect(computeStrikes("short_put_spread", 21_005.01, live).shortStrike).toBe(21_005);
    expect(computeStrikes("short_call_spread", 20_994.99, live).shortStrike).toBe(20_995);
  });

  it("a fractional strike increment works (0.5 grid)", () => {
    const half: StrikeConfig = { ...live, strikeIncrement: 0.5, widthPoints: 5 };
    expect(computeStrikes("short_put_spread", 7720.3, half)).toEqual({ shortStrike: 7720, longStrike: 7715 });
    expect(validateStrikes("short_put_spread", { shortStrike: 7720, longStrike: 7715 }, half).ok).toBe(true);
    expect(validateStrikes("short_put_spread", { shortStrike: 7720.25, longStrike: 7715.25 }, half).ok).toBe(false);
  });
});

describe("the plan kept on every decision", () => {
  it("records the price, offset, target, rounding mode, and chosen strikes", () => {
    const plan = planStrikes("short_put_spread", 21_003.7, live);
    expect(plan).toMatchObject({ price: 21_003.7, offset: -0.01, target: 21_003.69, rounding: "outward", increment: 5, shortStrike: 21_000, longStrike: 20_990 });
  });

  it("reads as a sentence", () => {
    expect(describePlan(planStrikes("short_put_spread", 21_003.7, live))).toBe("Target 21,003.69 (21,003.7 - 0.01), rounded down to 5 -> short 21,000, long 20,990");
    expect(describePlan(planStrikes("short_call_spread", 21_003.7, live))).toBe("Target 21,003.71 (21,003.7 + 0.01), rounded up to 5 -> short 21,005, long 21,015");
    expect(describePlan(planStrikes("short_call_spread", 21_003.7, { ...live, strikeRounding: "nearest" }))).toBe("Target 21,003.71 (21,003.7 + 0.01), rounded to the nearest 5 -> short 21,005, long 21,015");
  });

  it("the long strike is always the short strike plus or minus the width, and never equals it", () => {
    for (const price of [21_000, 21_001.2, 21_002.5, 21_004.99]) {
      for (const type of ["short_put_spread", "short_call_spread"] as const) {
        const { shortStrike, longStrike } = planStrikes(type, price, live);
        expect(Math.abs(longStrike - shortStrike)).toBe(10);
        expect(validateStrikes(type, { shortStrike, longStrike }, live).ok).toBe(true);
      }
    }
  });
});
