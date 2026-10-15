import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ABOVE_MARKET, MAX_REPRICES, highestBuy, lowestSell, repriceAfterBand, tickAt } from "./priceBand";

// IBKR's price band: the edge is EXCLUSIVE ("at or more aggressive than X": X itself is refused), the tick is 0.05 under 3.00 and 0.10 from there.

describe("the tick and the exclusive edge", () => {
  it("0.05 under 3.00, 0.10 from 3.00 up", () => {
    expect([tickAt(0.05), tickAt(2.95), tickAt(3), tickAt(3.1), tickAt(30)]).toEqual([0.05, 0.05, 0.1, 0.1, 0.1]);
  });

  it("a BUY goes at least one tick BELOW the edge, never on it", () => {
    expect(highestBuy(1.6)).toBe(1.55);
    expect(highestBuy(1.55)).toBe(1.5);
    expect(highestBuy(3)).toBe(2.95);
    expect(highestBuy(3.1)).toBe(3);
    expect(highestBuy(4.35)).toBe(4.3); // the highest valid tick under an edge that is not itself on a tick
    for (const edge of [0.3, 1.6, 2.02, 2.99, 3, 3.05, 3.1, 7.77]) expect(highestBuy(edge), String(edge)).toBeLessThan(edge);
  });

  it("a SELL goes at least one tick ABOVE the edge, never on it", () => {
    expect(lowestSell(0.6)).toBe(0.65);
    expect(lowestSell(0.65)).toBe(0.7);
    expect(lowestSell(3)).toBe(3.1);
    expect(lowestSell(2.95)).toBe(3);
    expect(lowestSell(3.1)).toBe(3.2);
    for (const edge of [0.3, 1.6, 2.02, 2.99, 3, 3.05, 3.1, 7.77]) expect(lowestSell(edge), String(edge)).toBeGreaterThan(edge);
  });

  it("the default cap above market is a dollar, and a ladder is re-priced twice at most", () => {
    expect(DEFAULT_MAX_ABOVE_MARKET).toBe(1);
    expect(MAX_REPRICES).toBe(2);
  });
});

const ok = (r: ReturnType<typeof repriceAfterBand>) => {
  if (!r.ok) throw new Error(`expected prices, got: ${r.reason}`);
  return r;
};

describe("re-pricing a refused BUY (a close)", () => {
  // The rehearsal: a BUY at 4.35 refused on a spread worth about 1.10.
  const refused = 4.35;

  it("starts at the broker's market price and steps toward the edge, never reaching it", () => {
    const r = ok(repriceAfterBand({ side: "debit", band: { edge: 1.6, marketPrice: 1.1 }, refused, finalPrice: 9.3, rungs: 4, width: 10 }));
    expect(r.prices).toEqual([1.1, 1.25, 1.4, 1.55]);
    expect(Math.max(...r.prices)).toBeLessThan(1.6); // the edge itself is refused
    expect(r.note).toBe("the market is 1.10, it will not take 1.60 or more: re-priced to 1.10, 1.25, 1.40, 1.55");
  });

  it("is never priced more than a dollar above the broker's market, even when the edge would allow more", () => {
    const r = ok(repriceAfterBand({ side: "debit", band: { edge: 5, marketPrice: 1.1 }, refused, finalPrice: 9.3, rungs: 4 }));
    expect(Math.max(...r.prices)).toBe(2.1);
    expect(r.prices[0]).toBe(1.1);
    const tight = ok(repriceAfterBand({ side: "debit", band: { edge: 5, marketPrice: 1.1 }, refused, finalPrice: 9.3, rungs: 4, maxAboveMarket: 0.25 }));
    expect(Math.max(...tight.prices)).toBe(1.35);
  });

  it("never goes past the bot's own final price", () => {
    const r = ok(repriceAfterBand({ side: "debit", band: { edge: 1.6, marketPrice: 1.1 }, refused, finalPrice: 1.3, rungs: 4 }));
    expect(Math.max(...r.prices)).toBe(1.3);
  });

  it("with only the edge it sends one price just under it; with only the market it walks market to market + the cap", () => {
    expect(ok(repriceAfterBand({ side: "debit", band: { edge: 1.6 }, refused, finalPrice: 9.3, rungs: 4 })).prices).toEqual([1.55]);
    const m = ok(repriceAfterBand({ side: "debit", band: { marketPrice: 1.1 }, refused, finalPrice: 9.3, rungs: 3 }));
    expect([m.prices[0], m.prices.at(-1)]).toEqual([1.1, 2.1]);
  });

  it("is never more than the spread can be worth", () => {
    const r = ok(repriceAfterBand({ side: "debit", band: { marketPrice: 9.9 }, refused: 11, finalPrice: 20, rungs: 4, maxAboveMarket: 5, width: 10 }));
    expect(Math.max(...r.prices)).toBeLessThanOrEqual(9.95);
  });

  it("gives up, with the reason, when the broker gave nothing to go on or nothing sensible is left", () => {
    expect(repriceAfterBand({ side: "debit", band: {}, refused, finalPrice: 9.3, rungs: 4 })).toEqual({ ok: false, reason: "the broker gave no price to go on" });
    const none = repriceAfterBand({ side: "debit", band: { edge: 0.05 }, refused, finalPrice: 9.3, rungs: 4 });
    expect(none.ok).toBe(false);
    const same = repriceAfterBand({ side: "debit", band: { marketPrice: 1.1 }, refused: 1.1, finalPrice: 1.1, rungs: 1 });
    expect(same).toMatchObject({ ok: false });
  });

  it("every price is a tick the bridge accepts", () => {
    const r = ok(repriceAfterBand({ side: "debit", band: { edge: 3.4, marketPrice: 2.2 }, refused: 5, finalPrice: 9, rungs: 5 }));
    for (const p of r.prices) expect(Math.round((p / tickAt(p)) * 1e6) / 1e6 % 1, String(p)).toBe(0);
  });
});

describe("re-pricing a refused SELL (an open)", () => {
  it("starts at the market and steps toward the lowest price the broker takes, never under it, the bot's own final price, or the minimum credit", () => {
    const r = ok(repriceAfterBand({ side: "credit", band: { edge: 0.6, marketPrice: 1.1 }, refused: 0.05, finalPrice: 0.95, rungs: 3, minCredit: 0.9 }));
    expect(r.prices[0]).toBe(1.1);
    expect(Math.min(...r.prices)).toBeGreaterThanOrEqual(0.95);
    expect(Math.min(...r.prices)).toBeGreaterThan(0.6);
    expect([...r.prices].sort((a, b) => b - a)).toEqual(r.prices); // falling, as a credit ladder does
  });

  it("the minimum credit wins over a lower edge", () => {
    const r = ok(repriceAfterBand({ side: "credit", band: { edge: 0.6, marketPrice: 1.0 }, refused: 0.05, finalPrice: 0.3, rungs: 3, minCredit: 0.9 }));
    expect(Math.min(...r.prices)).toBeGreaterThanOrEqual(0.9);
  });

  it("an edge above the bot's own final price is respected (the SELL has to be above it)", () => {
    const r = ok(repriceAfterBand({ side: "credit", band: { edge: 2, marketPrice: 2.2 }, refused: 0.05, finalPrice: 1.5, rungs: 3 }));
    expect(Math.min(...r.prices)).toBeGreaterThan(2);
  });

  it("the very price just refused is never sent again, and nothing above the width is sent", () => {
    const again = repriceAfterBand({ side: "credit", band: { edge: 2 }, refused: 2.05, finalPrice: 1, rungs: 3 });
    expect(again.ok).toBe(false);
    const capped = ok(repriceAfterBand({ side: "credit", band: { marketPrice: 14 }, refused: 1, finalPrice: 0.5, rungs: 3, width: 10 }));
    expect(Math.max(...capped.prices)).toBeLessThanOrEqual(9.95);
  });
});
