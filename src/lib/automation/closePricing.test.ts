import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord, updateBot } from "./bots";
import { applyTradeOp, contractsToClose, describeClosePricing, describeQuantity, validateCloseQuantity, validateClosePricing } from "./closePricing";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import { buildLadder, type LegQuotes } from "./smartPricing";
import { countTodayNewPositions } from "./safeguards";
import { botsStore, decisionsStore, positionsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";

setTestBotEnv();
setNdxTestEnv();

// Closing this spread costs 3.30 at the mid and 3.90 at the full spread (the ask side).
const quotes: LegQuotes = { short: { bid: 12.0, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } };
const timing = { closeConfirmTimeoutMs: 80, orderFillTimeoutMs: 80, pollIntervalMs: 4, ladderStepMs: 10 };
let executor: MockExecutor;

/** A bullish signal closes the short call spread the bot holds, then opens the put side. */
async function bullish(now = BASE_NOW) {
  const signal = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: "bullish", price: 21_003.7, barTime: `b-${now}`, interval: "5", raw: { symbol: "NDX" }, now });
  await processSignal(signal, { executor, now, ...timing });
}
const closes = () => executor.placedOrders.filter((o) => o.kind === "close");

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  executor = new MockExecutor();
  executor.setQuotes(quotes);
  positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_call_spread", status: "open", shortStrike: 21_035, longStrike: 21_045, requestedQuantity: 1, filledQuantity: 1, credit: 3.5 }));
});
afterEach(() => vi.unstubAllEnvs());

describe("choosing the final price", () => {
  const pct = (finals: Parameters<typeof buildLadder>[0]["finals"], mode: "off" | "normal" = "off") => {
    const r = buildLadder({ side: "debit", legs: quotes, mode, finalPercent: 100, finals });
    if (!r.ok) throw new Error(r.reason);
    return r.ladder.prices;
  };

  it("the best of several final prices wins: the lowest one to pay", () => {
    expect(pct({ percent: 100 })).toEqual([3.9]);
    expect(pct({ percent: 100, flat: 3.5 })).toEqual([3.5]);
    expect(pct({ percent: 100, slippage: 0.1, flat: 3.7 })).toEqual([3.4]);
    expect(pct({ percent: 100, tradePrice: 3.45 })).toEqual([3.45]);
  });

  it("slippage never goes past the full spread", () => {
    expect(pct({ slippage: 5 })).toEqual([3.9]);
  });

  it("the ladder still starts at the mid and ends at that final price", () => {
    expect(pct({ percent: 100, flat: 3.5 }, "normal")).toEqual([3.3, 3.35, 3.45, 3.5]);
  });
});

describe("a trigger's own Close Position pricing", () => {
  it("validates what it is given", () => {
    expect(validateClosePricing({ speed: "normal", percent: 100 }).ok).toBe(true);
    expect(validateClosePricing({ speed: "market" }).ok).toBe(true);
    expect(validateClosePricing({ speed: "normal" }).ok).toBe(false); // no final price
    expect(validateClosePricing({ speed: "turbo", percent: 100 }).ok).toBe(false);
    expect(validateClosePricing({ speed: "normal", percent: 101 }).ok).toBe(false);
    expect(validateClosePricing({ speed: "normal", slippage: -1 }).ok).toBe(false);
    expect(validateClosePricing({ speed: "off", tradePrice: { op: "%", value: 2 } }).ok).toBe(false);
    expect(validateClosePricing({ speed: "off", tradePrice: { op: "×", value: 0.5 } }).ok).toBe(true);
  });

  it("works a price out from the position's trade price", () => {
    expect(applyTradeOp(3.5, { op: "×", value: 0.5 })).toBe(1.75);
    expect(applyTradeOp(3.5, { op: "+", value: 0.25 })).toBe(3.75);
    expect(applyTradeOp(3.5, { op: "−", value: 0.5 })).toBe(3);
    expect(applyTradeOp(3.5, { op: "÷", value: 2 })).toBe(1.75);
    expect(applyTradeOp(null, { op: "×", value: 0.5 })).toBeNull();
    expect(applyTradeOp(3.5, { op: "−", value: 5 })).toBeNull();
  });

  it("is saved per trigger, and null returns the step to the bot's own pricing", () => {
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { pricing: { speed: "fast", percent: 50 } } } });
    expect(botsStore.get(NDX_BOT_ID)!.closeSettings!.bullish!.pricing).toEqual({ speed: "fast", percent: 50 });
    expect(botsStore.get(NDX_BOT_ID)!.closeSettings!.bearish).toBeUndefined();
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { memo: "m" } } }); // leaving pricing out keeps it
    expect(botsStore.get(NDX_BOT_ID)!.closeSettings!.bullish!.pricing).toEqual({ speed: "fast", percent: 50 });
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { pricing: null } } });
    expect(botsStore.get(NDX_BOT_ID)!.closeSettings!.bullish!.pricing).toBeUndefined();
  });

  it("refuses a bad one without saving it", () => {
    expect(() => updateBot(NDX_BOT_ID, { closeSettings: { bullish: { pricing: { speed: "normal" } as never } } })).toThrow(/final price/);
    expect(botsStore.get(NDX_BOT_ID)?.closeSettings).toBeUndefined();
  });

  it("with none saved, the close is priced as before: Normal, 100% of the way", async () => {
    await bullish();
    expect(closes().map((o) => o.price)).toEqual([3.3]); // the mock market takes the first price
    expect(decisionsStore.all()[0].outcome).toBeDefined();
  });

  it("walks the speed and final price it was given", async () => {
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { pricing: { speed: "off", percent: 100, flat: 3.5 } } } });
    executor.setMarket({ debitAtLeast: 99 }); // never fills: we only want to see the price it tried
    await bullish();
    expect(closes().map((o) => o.price)).toEqual([3.5]);
  });

  it("Market sends the close with no limit price", async () => {
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { pricing: { speed: "market" } } } });
    await bullish();
    expect(closes()).toHaveLength(1);
    expect(closes()[0].price).toBeUndefined();
    expect(positionsStore.query((p) => p.type === "short_call_spread")[0].status).toBe("closed");
  });

  it("the Bearish trigger is untouched by Bullish's pricing", async () => {
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { pricing: { speed: "market" } } } });
    expect(describeClosePricing({ speed: "market" })).toBe("Market order");
    expect(botsStore.get(NDX_BOT_ID)!.closeSettings!.bearish?.pricing).toBeUndefined();
  });
});

describe("a trigger's Close Position quantity", () => {
  const callSpreads = () => positionsStore.query((p) => p.type === "short_call_spread");
  const hold = (n: number) => {
    positionsStore.remove(callSpreads()[0].id);
    positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_call_spread", status: "open", shortStrike: 21_035, longStrike: 21_045, requestedQuantity: n, filledQuantity: n, credit: 3.5 }));
  };

  it("validates a percent or a whole number of contracts", () => {
    expect(validateCloseQuantity({ mode: "percent", value: 50 }).ok).toBe(true);
    expect(validateCloseQuantity({ mode: "percent", value: 0 }).ok).toBe(false);
    expect(validateCloseQuantity({ mode: "percent", value: 101 }).ok).toBe(false);
    expect(validateCloseQuantity({ mode: "contracts", value: 2 }).ok).toBe(true);
    expect(validateCloseQuantity({ mode: "contracts", value: 1.5 }).ok).toBe(false);
    expect(validateCloseQuantity({ mode: "shares", value: 1 }).ok).toBe(false);
  });

  it("works out whole contracts, at least one, never more than held", () => {
    expect(contractsToClose(4, { mode: "percent", value: 50 })).toBe(2);
    expect(contractsToClose(3, { mode: "percent", value: 10 })).toBe(1);
    expect(contractsToClose(2, { mode: "contracts", value: 5 })).toBe(2);
    expect(contractsToClose(2, undefined)).toBe(2);
    expect(describeQuantity({ mode: "contracts", value: 1 })).toBe("1 contract");
    expect(describeQuantity(undefined)).toBe("100% of position");
  });

  it("closes only that many contracts: the closed part is its own record and the rest stays open", async () => {
    hold(2);
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { quantity: { mode: "contracts", value: 1 } } } });
    await bullish();
    expect(closes()).toHaveLength(1);
    expect(closes()[0].quantity).toBe(1);
    const rows = callSpreads();
    const open = rows.filter((p) => p.status === "open");
    const closed = rows.filter((p) => p.status === "closed");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ filledQuantity: 1, requestedQuantity: 1 });
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ filledQuantity: 1, splitFrom: open[0].id });
  });

  it("a percent is the same: 50% of 2 contracts closes 1", async () => {
    hold(2);
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { quantity: { mode: "percent", value: 50 } } } });
    await bullish();
    expect(callSpreads().map((p) => [p.status, p.filledQuantity]).sort()).toEqual([["closed", 1], ["open", 1]]);
  });

  it("asking for as many as are held (or 100%) closes the whole position, as before", async () => {
    hold(2);
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { quantity: { mode: "contracts", value: 5 } } } });
    await bullish();
    expect(callSpreads().map((p) => p.status)).toEqual(["closed"]);
    expect(closes()[0].quantity).toBe(2);
  });

  it("the closed part is not a new position: it doesn't count toward the daily limit", async () => {
    hold(2);
    ensureBotRecord(NDX_BOT_ID);
    botsStore.update(NDX_BOT_ID, { safeguards: { totalPositionLimit: 5 } }); // the part that stays open still takes a slot
    const before = countTodayNewPositions(NDX_BOT_ID, BASE_NOW, 0);
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { quantity: { mode: "contracts", value: 1 } } } });
    await bullish();
    const split = callSpreads().filter((p) => p.splitFrom);
    expect(split).toHaveLength(1);
    // The bullish signal opened one put spread; the split record adds nothing.
    expect(countTodayNewPositions(NDX_BOT_ID, BASE_NOW, 0)).toBe(before + 1);
  });

  it("is saved per trigger, kept when left out, and null returns it to all of the position", () => {
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { quantity: { mode: "percent", value: 25 } } } });
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { memo: "m" } } });
    expect(botsStore.get(NDX_BOT_ID)!.closeSettings!.bullish!.quantity).toEqual({ mode: "percent", value: 25 });
    updateBot(NDX_BOT_ID, { closeSettings: { bullish: { quantity: null } } });
    expect(botsStore.get(NDX_BOT_ID)!.closeSettings!.bullish!.quantity).toBeUndefined();
    expect(() => updateBot(NDX_BOT_ID, { closeSettings: { bullish: { quantity: { mode: "shares", value: 1 } as never } } })).toThrow();
  });
});
