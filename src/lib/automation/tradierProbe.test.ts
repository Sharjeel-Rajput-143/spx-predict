import { describe, expect, it } from "vitest";
import { asList, nearMoneyPuts, ourSymbol, parseOcc, pickExpiry, rootsOf, strikeIncrementNear } from "./tradierProbe";
import { occSymbol } from "./tradierExecutor";

describe("option symbols", () => {
  it("parses a symbol into its parts", () => {
    expect(parseOcc("NDXP261007P20970000")).toEqual({ root: "NDXP", expiry: "2026-10-07", right: "put", strike: 20_970 });
    expect(parseOcc("SPXW261007C07720000")).toEqual({ root: "SPXW", expiry: "2026-10-07", right: "call", strike: 7720 });
    expect(parseOcc("AAPL")).toBeNull();
  });

  it("the probe's idea of a symbol is the executor's, so a mismatch it finds is a real finding", () => {
    expect(ourSymbol("NDXP", "2026-10-07", "put", 20_970)).toBe(occSymbol("NDXP", "2026-10-07", "put", 20_970));
    expect(ourSymbol("SPXW", "2026-10-07", "call", 7720)).toBe(occSymbol("SPXW", "2026-10-07", "call", 7720));
  });
});

describe("strike spacing", () => {
  it("reads the spacing near the price, not the whole chain's", () => {
    // 5-point strikes near the money, 25-point strikes far away
    const strikes = [...Array.from({ length: 30 }, (_, i) => 20_900 + i * 5), 19_000, 19_025, 22_000, 22_025];
    expect(strikeIncrementNear(strikes, 21_003)).toEqual({ increment: 5, gaps: [5] });
  });

  it("reports mixed spacing and picks the most common", () => {
    const r = strikeIncrementNear([20_950, 20_975, 21_000, 21_005, 21_010, 21_015, 21_020], 21_005, 7);
    expect(r.increment).toBe(5);
    expect(r.gaps).toEqual([5, 25]);
  });

  it("is null with nothing to compare", () => {
    expect(strikeIncrementNear([], 21_000).increment).toBeNull();
    expect(strikeIncrementNear([21_000], 21_000).increment).toBeNull();
  });
});

describe("Tradier's one-object-or-list answers", () => {
  it("always gives a list", () => {
    expect(asList(null)).toEqual([]);
    expect(asList("null")).toEqual([]);
    expect(asList({ a: 1 })).toEqual([{ a: 1 }]);
    expect(asList([1, 2])).toEqual([1, 2]);
  });
});

describe("what a lookup and a chain say", () => {
  it("counts contracts per root", () => {
    expect(rootsOf({ symbols: [{ rootSymbol: "NDX", options: ["a", "b"] }, { rootSymbol: "NDXP", options: ["c"] }] })).toEqual([{ root: "NDX", contracts: 2 }, { root: "NDXP", contracts: 1 }]);
    expect(rootsOf(null)).toEqual([]);
    expect(rootsOf({ symbols: { rootSymbol: "NDXP", options: "x" } })).toEqual([{ root: "NDXP", contracts: 1 }]);
  });

  it("picks the puts nearest below the price", () => {
    const chain = [
      { symbol: "NDXP261007P21000000", strike: 21_000, option_type: "put" },
      { symbol: "NDXP261007P20995000", strike: 20_995, option_type: "put" },
      { symbol: "NDXP261007C21005000", strike: 21_005, option_type: "call" },
      { symbol: "NDXP261007P21010000", strike: 21_010, option_type: "put" },
    ];
    expect(nearMoneyPuts(chain, 21_003).map((o) => o.strike)).toEqual([21_000, 20_995]);
  });

  it("picks today's expiry when there is a 0DTE, else the next", () => {
    expect(pickExpiry(["2026-10-07", "2026-10-08"], "2026-10-07")).toEqual({ expiry: "2026-10-07", zeroDte: true });
    expect(pickExpiry(["2026-10-08", "2026-10-09"], "2026-10-07")).toEqual({ expiry: "2026-10-08", zeroDte: false });
    expect(pickExpiry(["2026-10-01"], "2026-10-07")).toEqual({ expiry: null, zeroDte: false });
  });
});
