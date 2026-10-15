import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBotStaticConfig } from "./bots";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import type { LegQuotes } from "./smartPricing";
import { decisionsStore, ordersStore, positionsStore, runsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import type { SignalDirection } from "./types";

// The SmartPricing ladder through the whole engine, on the mock executor with a simulated market.
// Nothing here talks to a broker.

setTestBotEnv();
setNdxTestEnv();

// A spread worth 3.30 at the mid: natural (worst) credit 2.70, best 3.90 - so Normal tries 3.30, 3.10, 2.90, 2.70.
const quotes: LegQuotes = { short: { bid: 12.0, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } };

let executor: MockExecutor;
const timing = { closeConfirmTimeoutMs: 80, orderFillTimeoutMs: 80, pollIntervalMs: 4, ladderStepMs: 25 };

function emit(direction: SignalDirection, opts: { barTime?: string; now?: number; dryRun?: boolean } = {}) {
  const now = opts.now ?? BASE_NOW;
  const signal = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 21_003.7, barTime: opts.barTime ?? `b-${direction}-${now}`, interval: "5", raw: { symbol: "NDX" }, now });
  return processSignal(signal, { executor, now, dryRun: opts.dryRun, ...timing });
}
const outcomes = () => decisionsStore.all().map((d) => d.outcome);
const orders = () => ordersStore.all().sort((a, b) => a.createdAt - b.createdAt);

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  executor = new MockExecutor();
  executor.setQuotes(quotes);
});
afterEach(() => vi.unstubAllEnvs());

describe("opening walks the ladder", () => {
  it("starts at the mid and stops at the first price the market takes", async () => {
    executor.setMarket({ creditAtMost: 2.95 }); // pays 2.90, not 3.10
    await emit("bullish");

    expect(executor.placedOrders.filter((o) => o.kind === "open").map((o) => o.price)).toEqual([3.3, 3.1, 2.9]);
    expect(orders().map((o) => [o.limitPrice, o.status])).toEqual([[3.3, "canceled"], [3.1, "canceled"], [2.9, "filled"]]);
    expect(outcomes()).toEqual(["opened"]);
    expect(positionsStore.all()[0]).toMatchObject({ status: "open", credit: 2.9 });
    expect(decisionsStore.all()[0].detail).toMatchObject({ rungsTried: 3, pricing: { mode: "normal", prices: [3.3, 3.1, 2.9, 2.7], mid: 3.3, final: 2.7 } });
  });

  it("a market that pays the mid fills on the first price - one order, no cancels", async () => {
    await emit("bullish");
    expect(orders().map((o) => [o.limitPrice, o.status])).toEqual([[3.3, "filled"]]);
  });

  it("never goes beyond the final price: a market that won't pay it ends unfilled, and each rung was an order", async () => {
    executor.setMarket({ creditAtMost: 2.5 });
    await emit("bullish");
    expect(orders().map((o) => [o.limitPrice, o.status])).toEqual([[3.3, "canceled"], [3.1, "canceled"], [2.9, "canceled"], [2.7, "canceled"]]);
    expect(outcomes()).toEqual(["open_timeout_no_fill"]);
    expect(positionsStore.all()[0].status).toBe("rejected");
    expect(Math.min(...executor.placedOrders.map((o) => o.price!))).toBe(2.7);
  });

  it("the final price waits the full timeout, the others only their step", async () => {
    executor.setMarket({ creditAtMost: 2.5 });
    const t0 = Date.now();
    await emit("bullish");
    const took = Date.now() - t0;
    // 3 rungs x 25ms + the final 80ms - well under what four full timeouts (320ms) would take.
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(300);
  });

  it("a partial fill stops the walk: no further price is sent, and the position keeps what filled", async () => {
    executor.queueScenario(NDX_BOT_ID, { kind: "partial", firstFillRatio: 0.5, remainderDelayMs: null });
    vi.stubEnv("BOT_NDX_EMA_BIAS_QUANTITY", "2");
    vi.stubEnv("BOT_NDX_EMA_BIAS_ALLOCATION_LIMIT", "5000");
    await emit("bullish");
    expect(executor.placedOrders.filter((o) => o.kind === "open")).toHaveLength(1);
    expect(positionsStore.all()[0]).toMatchObject({ status: "open", filledQuantity: 1, requestedQuantity: 2 });
    expect(outcomes()).toEqual(["opened"]);
  });

  it("SmartPricing off sends one order at the final price", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_SMART_PRICING", "off");
    await emit("bullish");
    expect(executor.placedOrders.map((o) => o.price)).toEqual([2.7]);
  });

  it("a final price of 50% stops half way across the spread", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_OPEN_PRICE_PERCENT", "50");
    executor.setMarket({ creditAtMost: 1 });
    await emit("bullish");
    expect(Math.min(...executor.placedOrders.map((o) => o.price!))).toBe(3.0);
  });

  it("the run's Open card shows the ladder, and the decision log carries its numbers", async () => {
    executor.setMarket({ creditAtMost: 3.2 });
    await emit("bullish");
    const open = runsStore.all()[0].nodes.find((n) => n.kind === "action");
    expect(open).toMatchObject({ params: expect.arrayContaining([{ label: "Price", value: "SmartPricing Normal: 3.30, 3.10, 2.90, 2.70 (10s each, mid 3.30, final 100% of bid/ask)" }]) });
  });

  it("the credit stays below the width", async () => {
    executor.setQuotes({ short: { bid: 20, ask: 20.4 }, long: { bid: 9.7, ask: 10.1 } }); // mid ~10.3 on a 10-wide
    executor.setMarket({ creditAtMost: 50 });
    await emit("bullish");
    for (const o of executor.placedOrders) expect(o.price!).toBeLessThan(10);
  });
});

describe("when there is no usable price", () => {
  it("a dead market is refused before any position or order exists", async () => {
    executor.setQuotes({ short: { bid: 0, ask: 0.05 }, long: { bid: 0, ask: 0.05 } });
    await emit("bullish");
    expect(outcomes()).toEqual(["open_rejected"]);
    expect(decisionsStore.all()[0].reason).toMatch(/No usable price/);
    expect(positionsStore.all()).toHaveLength(0);
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("no quote available falls back to one price, and says so", async () => {
    executor.setQuotes(() => null);
    await emit("bullish");
    expect(executor.placedOrders.map((o) => o.price)).toEqual([getBotStaticConfig(NDX_BOT_ID).openingCreditEstimate]);
    expect(decisionsStore.all()[0].detail).toMatchObject({ pricing: { note: "One price (no quote available: the broker gave no usable bid and ask for one or both legs)" } });
  });

  it("a quote that throws falls back to one price, with the reason", async () => {
    executor.setQuotes(() => {
      throw new Error("quotes are down");
    });
    await emit("bullish");
    expect(outcomes()).toEqual(["opened"]);
    expect(executor.placedOrders).toHaveLength(1);
    expect(decisionsStore.all()[0].detail).toMatchObject({ pricing: { note: "One price (the quote failed: quotes are down)" } });
  });

  it("a dry run shows the ladder it would use and sends nothing", async () => {
    await emit("bullish", { dryRun: true });
    expect(outcomes()).toEqual(["dry_run"]);
    expect(executor.placedOrders).toHaveLength(0);
    expect(decisionsStore.all()[0].detail).toMatchObject({ pricing: { prices: [3.3, 3.1, 2.9, 2.7] } });
  });
});

describe("closing walks the ladder the other way", () => {
  it("a flip buys the spread back from the mid up toward the full spread, then opens the other side", async () => {
    await emit("bullish"); // opens the put spread at 3.30
    executor.setMarket({ debitAtLeast: 3.5 }); // won't sell the spread back under 3.50
    await emit("bearish", { barTime: "flip", now: BASE_NOW + 200_000 });

    const closes = executor.placedOrders.filter((o) => o.kind === "close");
    expect(closes.map((o) => o.price)).toEqual([3.3, 3.5]); // the second rung is the one the market takes
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
    expect(positionsStore.query((p) => p.type === "short_put_spread")[0]).toMatchObject({ status: "closed", closePrice: 3.5 });
  });

  it("a close that never fills stops the flip: nothing new is opened", async () => {
    await emit("bullish");
    executor.setMarket({ debitAtLeast: 99 });
    await emit("bearish", { barTime: "flip", now: BASE_NOW + 200_000 });
    expect(outcomes().slice(1)).toEqual(["close_timeout"]);
    expect(executor.placedOrders.filter((o) => o.kind === "open")).toHaveLength(1);
    expect(executor.placedOrders.filter((o) => o.kind === "close").length).toBeGreaterThan(1);
  });

  it("an executor with no market keeps closing exactly as before: one order, no price", async () => {
    executor.setQuotes(null);
    positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_call_spread", status: "open", shortStrike: 21_035, longStrike: 21_045, requestedQuantity: 1, filledQuantity: 1, credit: 3.5 }));
    await emit("bullish");
    const closes = executor.placedOrders.filter((o) => o.kind === "close");
    expect(closes).toHaveLength(1);
    expect(closes[0].price).toBeUndefined();
  });
});

describe("the setting", () => {
  it("defaults to Normal, can be any preset, and refuses anything else", () => {
    expect(getBotStaticConfig(NDX_BOT_ID).smartPricing).toBe("normal");
    for (const mode of ["fast", "patient", "off"]) {
      vi.stubEnv("BOT_NDX_EMA_BIAS_SMART_PRICING", mode);
      expect(getBotStaticConfig(NDX_BOT_ID).smartPricing).toBe(mode);
    }
    vi.stubEnv("BOT_NDX_EMA_BIAS_SMART_PRICING", "aggressive");
    expect(() => getBotStaticConfig(NDX_BOT_ID)).toThrow(/must be one of normal, fast, patient, off/);
  });
});
