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
