import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBotStaticConfig } from "./bots";
import { applyClosePricing, closePosition, manualClose, pricingFor, processSignal, receiveAndSaveSignal } from "./engine";
import { sweepBot } from "./eodSweep";
import { MockExecutor } from "./executor";
import { DEFAULT_FLOOR_FRACTION, applyFloor, effectiveMinCredit } from "./minCredit";
import { buildLadder, type LegQuotes } from "./smartPricing";
import { botsStore, decisionsStore, errorsStore, ordersStore, positionsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, TEST_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import type { CloseOrderOptions, Position, SignalDirection } from "./types";

// A broker that is only ever sent limit orders on a spread (as the IBKR one is), the way the engine sees it. Nothing here talks to a broker.
//   Every order needs a price from a real quote of the spread; with none, the order is refused and nothing is changed.
//   An open is never priced under the bot's minimum credit.
//   A position stuck in "closing" with nothing working is never closed a second time, and says how to resolve it.

setTestBotEnv();
setNdxTestEnv();

/** Like the broker: refuses a close that has no limit price, whatever the engine does. */
class LimitOnlyMock extends MockExecutor {
  readonly limitOnly = true;
  closeCalls: (CloseOrderOptions | undefined)[] = [];
  override async placeCloseOrder(position: Position, options?: CloseOrderOptions) {
    this.closeCalls.push(options);
    if (options?.limitDebit === undefined) throw new Error("Refused by the broker: a close with no limit price.");
    return super.placeCloseOrder(position, options);
  }
}

// A spread worth 3.30 at the mid: a credit of 2.70 to 3.90, so Normal tries 3.30, 3.10, 2.90, 2.70 (opening) and 3.30, 3.50, 3.70, 3.90 (closing).
const quotes: LegQuotes = { short: { bid: 12.0, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } };
// Delayed paper quotes seen in the rehearsal: a credit market of 0.05 to 8.65 on a 10-point spread. The ladder fell to 0.05 and that rung filled.
const WIDE: LegQuotes = { short: { bid: 9.0, ask: 15.0 }, long: { bid: 6.35, ask: 8.95 }, delayed: true };

let executor: LimitOnlyMock;
const timing = { closeConfirmTimeoutMs: 80, orderFillTimeoutMs: 80, pollIntervalMs: 4, ladderStepMs: 25 };

const emit = (direction: SignalDirection, now = BASE_NOW) => {
  const signal = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 21_003.7, barTime: `b-${direction}-${now}`, interval: "5", raw: { symbol: "NDX" }, now });
  return processSignal(signal, { executor, now, ...timing });
};
const holdPut = (over: Partial<Position> = {}) =>
  positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 1, filledQuantity: 1, credit: 3.3, ...over }));
const mine = () => positionsStore.all().filter((p) => p.botId === NDX_BOT_ID);
const outcomes = () => decisionsStore.all().filter((d) => d.botId === NDX_BOT_ID).map((d) => d.outcome);
const placed = (kind: "open" | "close") => executor.placedOrders.filter((o) => o.kind === kind);

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  executor = new LimitOnlyMock();
  executor.setQuotes(quotes);
});
afterEach(() => vi.unstubAllEnvs());

describe("every close is priced from the quote, on the same stepped ladder as the open", () => {
  it("a flip closes at limit prices walking from the mid toward the far end, stopping at the first price the market takes", async () => {
    holdPut();
    executor.setMarket({ debitAtLeast: 3.6 }); // pays 3.70, not 3.50
    await emit("bearish");
    expect(placed("close").map((o) => o.price)).toEqual([3.3, 3.5, 3.7]);
    expect(executor.closeCalls.every((c) => typeof c?.limitDebit === "number")).toBe(true);
    expect(ordersStore.all().filter((o) => o.kind === "close").map((o) => [o.limitPrice, o.status])).toEqual([[3.3, "canceled"], [3.5, "canceled"], [3.7, "filled"]]);
    expect(mine().map((p) => [p.type, p.status])).toEqual([["short_put_spread", "closed"], ["short_call_spread", "open"]]);
  });

  it("the open and the close use the same ladder (4 prices, same pace)", async () => {
    await emit("bullish");
    expect(placed("open").map((o) => o.price)).toEqual([3.3]);
    const open = buildLadder({ side: "credit", legs: quotes, mode: "normal", finalPercent: 100, width: 10 });
    const close = buildLadder({ side: "debit", legs: quotes, mode: "normal", finalPercent: 100, width: 10 });
    expect(open.ok && close.ok && open.ladder.prices.length === close.ladder.prices.length && open.ladder.secondsEach === close.ladder.secondsEach).toBe(true);
  });
});

describe("with no usable quote a close is refused, and the position is left exactly as it was", () => {
  const noQuote: Record<string, () => void> = {
    "no quotes at all": () => executor.setQuotes(null),
    "the quote call fails": () => executor.setQuotes(() => {
      throw new Error("bridge down");
    }),
    "the bridge has no bid and ask": () => executor.setQuotes(() => null),
    "a crossed quote": () => executor.setQuotes({ short: { bid: 13, ask: 12 }, long: { bid: 8.7, ask: 9.3 } }),
  };
  for (const [name, setup] of Object.entries(noQuote)) {
    it(`a flip: ${name} -> nothing sent, the old position still open, nothing opened on the new side, the bot flagged`, async () => {
      holdPut();
      setup();
      await emit("bearish");
      expect(executor.placedOrders).toHaveLength(0);
      expect(executor.closeCalls).toHaveLength(0); // never even offered to the broker
      expect(mine().map((p) => [p.type, p.status])).toEqual([["short_put_spread", "open"]]); // unchanged: not "closing"
      expect(outcomes()).toContain("close_no_quote");
      expect(outcomes()).not.toContain("opened");
      expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ needsAttention: true });
      const reason = decisionsStore.all().find((d) => d.outcome === "close_no_quote")!.reason;
      expect(reason).toMatch(/no usable quote of the spread/);
      expect(reason).toMatch(/left exactly as it was/);
    });
  }

  it("a manual close: refused with the reason, position still open, and the bot is not flagged (nothing happened)", async () => {
    const p = holdPut();
    executor.setQuotes(null);
    const result = await manualClose(p.id, { executor, ...timing });
    expect(result).toMatchObject({ ok: false, outcome: "close_no_quote" });
    expect(positionsStore.get(p.id)?.status).toBe("open");
    expect(executor.placedOrders).toHaveLength(0);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBeFalsy();
    expect(errorsStore.all()).toHaveLength(0);
    // And it goes through once there is a quote.
    executor.setQuotes(quotes);
    expect(await manualClose(p.id, { executor, ...timing })).toMatchObject({ ok: true, outcome: "closed" });
    expect(placed("close")[0].price).toBeGreaterThan(0);
  });

  it("a partial-close position keeps its quantity when the close is refused", async () => {
    const p = holdPut({ requestedQuantity: 3, filledQuantity: 3 });
    executor.setQuotes(null);
    await manualClose(p.id, { executor, ...timing });
    expect(positionsStore.get(p.id)).toMatchObject({ status: "open", filledQuantity: 3, closeSignalId: null });
  });
});

describe("'at market' is never a bare market order on this broker", () => {
  const marketPricing = () => applyClosePricing(pricingFor(getBotStaticConfig(NDX_BOT_ID), "close", 25), { speed: "market" });

  it("becomes one limit order at the far end of the spread, priced from the quote", async () => {
    const p = holdPut();
    const result = await closePosition(p, { id: null, price: 21_003 }, executor, 80, 4, BASE_NOW, marketPricing());
    expect(result.ok).toBe(true);
    expect(placed("close").map((o) => o.price)).toEqual([3.9]); // a single order, at the natural price: no stepping
  });

  it("is refused when there is no quote (the expiration exit, the sweep and the monitors all come through here)", async () => {
    const p = holdPut();
    executor.setQuotes(null);
    const result = await closePosition(p, { id: null, price: 21_003 }, executor, 80, 4, BASE_NOW, marketPricing());
    expect(result).toMatchObject({ ok: false, outcome: "close_no_quote" });
    expect(positionsStore.get(p.id)?.status).toBe("open");
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("a close called with no pricing at all is refused too, never sent bare", async () => {
    const p = holdPut();
    const result = await closePosition(p, { id: null, price: null }, executor, 80, 4, BASE_NOW);
    expect(result).toMatchObject({ ok: false, outcome: "close_no_quote" });
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("the simulation (not limit-only) is unchanged: market means no limit price, and a close with no quote still goes", async () => {
    const sim = new MockExecutor();
    const p = holdPut();
    const result = await closePosition(p, { id: null, price: null }, sim, 80, 4, BASE_NOW);
    expect(result.ok).toBe(true);
    expect(sim.placedOrders[0].price).toBeUndefined();
  });

  it("the end-of-day sweep in 'close' mode prices its closes the same way, and refuses without a quote", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_EOD_SWEEP_MODE", "market");
    const p = holdPut();
    const res = await sweepBot(NDX_BOT_ID, BASE_NOW + 6 * 3_600_000, { executor, closeConfirmTimeoutMs: 80, pollIntervalMs: 4 });
    expect(res.closedAtMarket).toBe(1);
    expect(placed("close").map((o) => o.price)).toEqual([3.9]);
    expect(positionsStore.get(p.id)?.status).toBe("closed");

    resetAutomationStores();
    setNdxTestEnv();
    executor = new LimitOnlyMock();
    executor.setQuotes(null);
    const q = holdPut();
    const res2 = await sweepBot(NDX_BOT_ID, BASE_NOW + 6 * 3_600_000, { executor, closeConfirmTimeoutMs: 80, pollIntervalMs: 4 });
    expect(res2.failed).toBe(1);
    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.get(q.id)?.status).toBe("open");
  });
});

describe("an open is never sent at a guessed price either", () => {
  it("with no quote nothing is opened, nothing is sent, and it says so", async () => {
    executor.setQuotes(null);
    await emit("bullish");
    expect(executor.placedOrders).toHaveLength(0);
    expect(mine()).toHaveLength(0);
    expect(outcomes()).toEqual(["open_no_quote"]);
    expect(decisionsStore.all()[0].reason).toMatch(/no usable quote/);
  });

  it("the simulation still opens at the bot's expected credit when it has no quote (unchanged)", async () => {
    const sim = new MockExecutor();
    const signal = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: "bullish", price: 21_003.7, barTime: "sim", interval: "5", raw: { symbol: "NDX" }, now: BASE_NOW });
    await processSignal(signal, { executor: sim, now: BASE_NOW, ...timing });
    expect(sim.placedOrders.map((o) => o.price)).toEqual([3.5]);
  });
});

describe("the minimum credit", () => {
  it("is a quarter of the expected credit unless the bot sets its own: 0.90 for NDX, 0.55 for SPX", () => {
    expect(DEFAULT_FLOOR_FRACTION).toBe(0.25);
    expect(effectiveMinCredit(getBotStaticConfig(NDX_BOT_ID))).toBe(0.9);
    expect(effectiveMinCredit(getBotStaticConfig(TEST_BOT_ID))).toBe(0.55);
    vi.stubEnv("BOT_NDX_EMA_BIAS_MIN_CREDIT", "1.5");
    expect(effectiveMinCredit(getBotStaticConfig(NDX_BOT_ID))).toBe(1.5);
    vi.stubEnv("BOT_NDX_EMA_BIAS_MIN_CREDIT", "0");
    expect(effectiveMinCredit(getBotStaticConfig(NDX_BOT_ID))).toBe(0); // zero turns it off
  });

  it("a floor at or above the expected credit, or below zero, is a configuration error", () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_MIN_CREDIT", "3.5");
    expect(() => getBotStaticConfig(NDX_BOT_ID)).toThrow(/minimum credit/);
    vi.stubEnv("BOT_NDX_EMA_BIAS_MIN_CREDIT", "-1");
    expect(() => getBotStaticConfig(NDX_BOT_ID)).toThrow(/minimum credit/);
    vi.stubEnv("BOT_NDX_EMA_BIAS_MIN_CREDIT", "abc");
    expect(() => getBotStaticConfig(NDX_BOT_ID)).toThrow();
  });

  it("applyFloor drops the tail of a ladder, keeps the order, and treats the floor itself as allowed", () => {
    expect(applyFloor([4.35, 2.7, 1.05, 0.05], 0.9)).toEqual({ kept: [4.35, 2.7, 1.05], dropped: [0.05] });
    expect(applyFloor([3.3, 3.1], 3.1)).toEqual({ kept: [3.3, 3.1], dropped: [] });
    expect(applyFloor([0.5, 0.3], 0.9)).toEqual({ kept: [], dropped: [0.5, 0.3] });
  });

  it("the ladder that ended at 0.05 on stale, wide quotes now stops above the floor: the 0.05 price is never sent", async () => {
    executor.setQuotes(WIDE);
    executor.setMarket({ creditAtMost: 0.05 }); // only the worst price would have filled
    await emit("bullish");
    const prices = placed("open").map((o) => o.price!);
    expect(prices.length).toBeGreaterThan(0);
    expect(Math.min(...prices)).toBeGreaterThanOrEqual(0.9);
    expect(prices).not.toContain(0.05);
    expect(mine().map((p) => p.status)).toEqual(["rejected"]); // it did not fill at the bad price
    expect(outcomes()).toEqual(["open_timeout_no_fill"]);
    const detail = decisionsStore.all()[0].detail as { pricing: { droppedUnderMinCredit: number[]; note: string } };
    expect(detail.pricing.droppedUnderMinCredit).toEqual([0.05]);
    expect(detail.pricing.note).toMatch(/under the \$0\.90 minimum credit .*0\.05 was dropped/);
  });

  it("when even the best price is under the floor the open is skipped: 'skipped, below minimum credit', nothing sent, no position", async () => {
    executor.setQuotes({ short: { bid: 1.0, ask: 1.2 }, long: { bid: 0.5, ask: 0.6 } }); // a spread worth about 0.55
    await emit("bullish");
    expect(executor.placedOrders).toHaveLength(0);
    expect(mine()).toHaveLength(0);
    expect(outcomes()).toEqual(["below_min_credit"]);
    expect(decisionsStore.all()[0].reason).toMatch(/Skipped, below minimum credit/);
    expect(decisionsStore.all()[0].reason).toMatch(/\$0\.90/);
  });

  it("a bot's own floor is respected, and 0 turns it off", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_MIN_CREDIT", "3.4"); // above the 3.30 mid
    executor.setQuotes(quotes);
    await emit("bullish");
    expect(outcomes()).toEqual(["below_min_credit"]);

    resetAutomationStores();
    setNdxTestEnv();
    vi.stubEnv("BOT_NDX_EMA_BIAS_MIN_CREDIT", "0");
    executor = new LimitOnlyMock();
    executor.setQuotes(WIDE);
    executor.setMarket({ creditAtMost: 0.05 });
    await emit("bullish");
    expect(placed("open").map((o) => o.price)).toContain(0.05); // no floor: the old behaviour, on purpose
  });

  it("a skipped open is a warning the bell can show, and it is not an error against the daily failsafe", async () => {
    executor.setQuotes({ short: { bid: 1.0, ask: 1.2 }, long: { bid: 0.5, ask: 0.6 } });
    await emit("bullish");
    expect(errorsStore.all()).toHaveLength(0);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBeFalsy();
  });
});

describe("a position stuck in 'closing' with no order working", () => {
  it("is not closed a second time and nothing is opened; the message points to Resolve; it does not burn the error failsafe", async () => {
    const stuck = holdPut({ status: "closing" });
    await emit("bearish");
    expect(executor.placedOrders).toHaveLength(0);
    expect(mine().map((p) => [p.id === stuck.id, p.status])).toEqual([[true, "closing"]]);
    expect(outcomes()).toEqual(["stuck_position"]);
    const reason = decisionsStore.all().find((d) => d.outcome === "stuck_position")!.reason;
    expect(reason).toMatch(/stuck in "closing"/);
    expect(reason).toMatch(/Resolve/);
    expect(errorsStore.all()).toHaveLength(0); // an alert that comes in again and again does not count toward the 10-errors-a-day failsafe
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ needsAttention: true });
  });

  it("the same alert twice changes nothing and still sends nothing", async () => {
    holdPut({ status: "closing" });
    await emit("bearish");
    await emit("bearish", BASE_NOW + 5 * 60_000);
    expect(executor.placedOrders).toHaveLength(0);
    expect(errorsStore.all()).toHaveLength(0);
    expect(outcomes().filter((o) => o === "stuck_position")).toHaveLength(2);
  });
});
