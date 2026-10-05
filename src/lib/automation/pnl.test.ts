import { describe, expect, it } from "vitest";
import { computeStats, positionPL, positionPremium, positionRisk } from "./pnl";
import { buildPosition } from "./testSupport";

const closed = (credit: number, closePrice: number | null, closedAt: number) =>
  buildPosition({ type: "short_put_spread", status: "closed", credit, closePrice, closedAt });

describe("positionPL", () => {
  it("is (credit - close debit) x 100 x quantity for a priced closed position", () => {
    expect(positionPL(closed(2.2, 1.8, 1))).toBeCloseTo(120); // 0.40 x 100 x 3
    expect(positionPL(closed(2.2, 3.2, 1))).toBeCloseTo(-300);
  });

  it("is null - never guessed - without a close price, or when not closed", () => {
    expect(positionPL(closed(2.2, null, 1))).toBeNull();
    expect(positionPL(buildPosition({ type: "short_put_spread", status: "expired", credit: 2.2 }))).toBeNull();
    expect(positionPL(buildPosition({ type: "short_put_spread", status: "open", credit: 2.2 }))).toBeNull();
  });
});

describe("risk and premium", () => {
  it("matches the spec's worked example: width 5, qty 3, credit 2.20", () => {
    const p = buildPosition({ type: "short_put_spread", status: "open", shortStrike: 7700, longStrike: 7695, credit: 2.2 });
    expect(positionRisk(p)).toBeCloseTo(840);
    expect(positionPremium(p)).toBeCloseTo(660);
  });
});

describe("computeStats", () => {
  it("returns empty stats when nothing is priced", () => {
    const s = computeStats([closed(2.2, null, 1)]);
    expect(s.priced).toBe(0);
    expect(s.closedPL).toBeNull();
    expect(s.curve).toEqual([]);
  });

  it("derives wins, losses, win rate, averages, profit factor, drawdown, streak and curve", () => {
    // P/L in order: +120, +300, -300, +60, +90
    const stats = computeStats([
      closed(2.2, 1.8, 1),
      closed(2.5, 1.5, 2),
      closed(2.2, 3.2, 3),
      closed(2.2, 2.0, 4),
      closed(2.2, 1.9, 5),
    ]);
    expect(stats.priced).toBe(5);
    expect(stats.closedPL).toBeCloseTo(270);
    expect(stats.wins).toBe(4);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBeCloseTo(0.8);
    expect(stats.avgPL).toBeCloseTo(54);
    expect(stats.avgWin).toBeCloseTo(142.5);
    expect(stats.avgLoss).toBeCloseTo(-300);
    expect(stats.profitFactor).toBeCloseTo(570 / 300);
    expect(stats.maxDrawdown).toBeCloseTo(300);
    expect(stats.streak).toEqual({ kind: "win", count: 2 });
    expect(stats.curve.map((c) => Math.round(c.value))).toEqual([120, 420, 120, 180, 270]);
  });

  it("has no profit factor when there are no losses", () => {
    expect(computeStats([closed(2.2, 1.8, 1)]).profitFactor).toBeNull();
  });
});
