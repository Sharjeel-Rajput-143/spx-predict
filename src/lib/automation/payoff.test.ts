import { describe, expect, it } from "vitest";
import { breakeven, maxLoss, maxProfit, otmFraction, payoffAt, priceRange, rewardRisk, type Spread } from "./payoff";

// The spec's worked example: width 5, quantity 3, credit 2.20 -> risk $840, premium $660.
const put: Spread = { type: "short_put_spread", shortStrike: 7730, longStrike: 7725, credit: 2.2, quantity: 3 };
const call: Spread = { type: "short_call_spread", shortStrike: 7740, longStrike: 7745, credit: 2.2, quantity: 3 };

describe("payoffAt - put spread", () => {
  it("keeps the whole credit at or above the short strike", () => {
    expect(payoffAt(put, 7800)).toBeCloseTo(660);
    expect(payoffAt(put, 7730)).toBeCloseTo(660);
  });

  it("loses the whole spread, capped at max loss, at or below the long strike", () => {
    expect(payoffAt(put, 7725)).toBeCloseTo(-840);
    expect(payoffAt(put, 7000)).toBeCloseTo(-840);
  });

  it("slides one-for-one between the strikes and is zero at breakeven", () => {
    expect(payoffAt(put, 7728)).toBeCloseTo((2.2 - 2) * 300); // 2 points inside the short strike
    expect(payoffAt(put, breakeven(put))).toBeCloseTo(0);
  });
});

describe("payoffAt - call spread", () => {
  it("mirrors it", () => {
    expect(payoffAt(call, 7000)).toBeCloseTo(660);
    expect(payoffAt(call, 7740)).toBeCloseTo(660);
    expect(payoffAt(call, 7745)).toBeCloseTo(-840);
    expect(payoffAt(call, 9000)).toBeCloseTo(-840);
    expect(payoffAt(call, breakeven(call))).toBeCloseTo(0);
  });
});

describe("summary numbers", () => {
  it("max profit, max loss, reward/risk and breakeven", () => {
    expect(maxProfit(put)).toBeCloseTo(660);
    expect(maxLoss(put)).toBeCloseTo(840);
    expect(rewardRisk(put)).toBeCloseTo(660 / 840);
    expect(breakeven(put)).toBeCloseTo(7727.8);
    expect(breakeven(call)).toBeCloseTo(7742.2);
  });

  it("has no reward/risk when nothing is at risk", () => {
    expect(rewardRisk({ ...put, credit: 5 })).toBeNull();
  });

  it("OTM fraction: positive out of the money, negative in the money", () => {
    expect(otmFraction(put, 7786.58)).toBeCloseTo((7786.58 - 7730) / 7786.58);
    expect(otmFraction(put, 7700)).toBeLessThan(0);
    expect(otmFraction(call, 7700)).toBeGreaterThan(0);
  });
});

describe("priceRange", () => {
  it("brackets the strikes with a margin", () => {
    const { lo, hi } = priceRange(put);
    expect(lo).toBeLessThan(7725);
    expect(hi).toBeGreaterThan(7730);
  });

  it("widens to include a current price far from the strikes", () => {
    expect(priceRange(put, 7786).hi).toBeGreaterThanOrEqual(7786);
    expect(priceRange(put, 7600).lo).toBeLessThanOrEqual(7600);
  });
});
