import { beforeEach, describe, expect, it } from "vitest";
import { BybitExecutor, protectionPrices, type BybitConfig } from "./bybitExecutor";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { OrderNotPlacedError } from "./orderErrors";
import { decisionsStore, ordersStore, positionsStore } from "./store";
import { botsStore } from "./store";
import { positionPL } from "./pnl";
import { BASE_NOW, BTC_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import { ensureBotRecord } from "./bots";
import type { OpenSpreadRequest } from "./types";

// Stop loss and take profit on Bybit's side, the check that they are really there, the emergency close when they are not, and finding out that
// Bybit closed a trade by itself. All against the fake exchange.

setNdxTestEnv();
const config: BybitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0.12, alwaysOn: false, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 5000 };

let bybit: FakeBybit;
let logs: string[];
let nowMs: number;
const make = (over: Partial<BybitConfig> = {}) => {
  const ex = new BybitExecutor({ ...config, ...over }, bybit.fetch, (l) => logs.push(l), () => nowMs);
  ex.sleep = async () => {};
  return ex;
};
const openReq = (over: Partial<OpenSpreadRequest> = {}): OpenSpreadRequest => ({ botId: BTC_BOT_ID, underlying: "BTC", positionType: "short_put_spread", shortStrike: 29_000, longStrike: 28_990, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06", clientOrderId: "alert-1:open:0", ...over });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(BTC_BOT_ID);
  bybit = new FakeBybit();
  logs = [];
  nowMs = BASE_NOW;
  bybit.clock = () => nowMs;
  delete process.env.BYBIT_KILL_SWITCH;
});

describe("where the stops go", () => {
  it("a long stops below and takes profit above, a short the mirror, rounded to the price tick", () => {
    expect(protectionPrices("Buy", 76_000, 0.1, 1, 2)).toEqual({ stopLoss: "75240.0", takeProfit: "77520.0" });
    expect(protectionPrices("Sell", 76_000, 0.1, 1, 2)).toEqual({ stopLoss: "76760.0", takeProfit: "74480.0" });
    expect(protectionPrices("Buy", 75_123.45, 0.1, 0.5, 1.5)).toEqual({ stopLoss: "74747.8", takeProfit: "76250.3" });
    expect(protectionPrices("Buy", 3_000, 0.5, 1, 2)).toEqual({ stopLoss: "2970.0", takeProfit: "3060.0" });
  });

  it("a percent so small that rounding puts a stop on the entry itself is an error, never a stop in the wrong place", () => {
    expect(() => protectionPrices("Buy", 76_000, 0.1, 0.00001, 2)).toThrow(/not on the right side/);
    expect(() => protectionPrices("Sell", 76_000, 0.1, 1, 0.00001)).toThrow(/not on the right side/);
  });
});

describe("every entry carries its stops", () => {
  it("the entry order itself has the stop loss and the take profit, triggered on the mark price, closing at market", async () => {
    await make().placeOpenOrder(openReq());
    expect(bybit.created[0].params).toMatchObject({ side: "Buy", stopLoss: "75240.0", takeProfit: "77520.0", slTriggerBy: "MarkPrice", tpTriggerBy: "MarkPrice", tpslMode: "Full", slOrderType: "Market", tpOrderType: "Market" });
    expect(bybit.position).toMatchObject({ stopLoss: 75240, takeProfit: 77520 });
  });

  it("a short entry has them the other way round", async () => {
    await make().placeOpenOrder(openReq({ positionType: "short_call_spread" }));
    expect(bybit.created[0].params).toMatchObject({ side: "Sell", stopLoss: "76760.0", takeProfit: "74480.0" });
  });

  it("uses STOP_LOSS_PERCENT and TAKE_PROFIT_PERCENT as set", async () => {
    await make({ stopLossPercent: 0.5, takeProfitPercent: 3 }).placeOpenOrder(openReq());
    expect(bybit.created[0].params).toMatchObject({ stopLoss: "75620.0", takeProfit: "78280.0" });
  });

  it("the stops are worked out from Bybit's mark price and tick size, read before the order (nothing is sent without them)", async () => {
    bybit.fail("/v5/market/tickers", { kind: "ret", code: 10016, msg: "Server Error" });
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(String(err)).toMatch(/an entry never goes out without them/);
    expect(bybit.created).toHaveLength(0);
  });

  it("an entry whose stop Bybit refuses is not held: Bybit's own words, nothing opened", async () => {
    bybit.overrides.set("/v5/market/tickers", () => ({ ok: true, status: 200, text: async () => JSON.stringify({ retCode: 0, result: { list: [{ markPrice: "70000", lastPrice: "70000" }] } }) }));
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(String(err)).toMatch(/TakeProfit:.*should greater than base_price/);
    expect(bybit.position.size).toBe(0);
  });
});

describe("when Bybit does not attach the stops", () => {
  beforeEach(() => {
    bybit.dropStops = true;
  });

  it("the position is read back, the missing stops are set once from the real entry price, and the entry stands", async () => {
    const { ref } = await make().placeOpenOrder(openReq());
    expect(ref).toBe("bybit-open-1001");
    const stop = bybit.of("/v5/position/trading-stop");
    expect(stop).toHaveLength(1);
    expect(stop[0].params).toMatchObject({ category: "linear", symbol: "BTCUSDT", tpslMode: "Full", positionIdx: 0, stopLoss: "75240.0", takeProfit: "77520.0", slTriggerBy: "MarkPrice", tpTriggerBy: "MarkPrice" });
    expect(bybit.position).toMatchObject({ size: 0.001, stopLoss: 75240, takeProfit: 77520 });
    expect(bybit.created).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/STOP ALARM \(stop_problem\).*there is no stop loss.*Repairing it now/);
  });

  it("with only the take profit missing (or only the stop loss) the missing one is set, and it counts as missing", async () => {
    for (const missing of ["takeProfit", "stopLoss"] as const) {
      bybit = new FakeBybit();
      bybit.clock = () => nowMs;
      bybit.dropStops = false;
      bybit.dropOnly = missing;
      await make().placeOpenOrder(openReq({ clientOrderId: `one-${missing}` }));
      expect(bybit.of("/v5/position/trading-stop"), missing).toHaveLength(1);
      expect(bybit.position, missing).toMatchObject({ size: 0.001, stopLoss: 75240, takeProfit: 77520 });
    }
  });

  it("if the stops can't be attached the position is closed again AT ONCE, reduce only, and the failure is thrown", async () => {
    bybit.tradingStopFails = true;
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(String(err)).toMatch(/Entry closed again at once: the stop loss could not be confirmed.*there is no stop loss.*trading stop is not allowed.*account is flat again/);
    expect(bybit.created.map((c) => [c.params.side, c.params.reduceOnly ?? false])).toEqual([["Buy", false], ["Sell", true]]);
    expect(bybit.position.size).toBe(0);
  });

  it("an entry that was closed again is not remembered as placed: the same order id can be tried again", async () => {
    const ex = make();
    bybit.tradingStopFails = true;
    await expect(ex.placeOpenOrder(openReq())).rejects.toBeInstanceOf(OrderNotPlacedError);
    bybit.tradingStopFails = false;
    bybit.dropStops = false;
    const { ref } = await ex.placeOpenOrder(openReq());
    expect(ref).toBe("bybit-open-1003");
    expect(bybit.position).toMatchObject({ size: 0.001, stopLoss: 75240 });
  });

  it("if even that close fails it says so in capitals, and says the position is open without a stop", async () => {
    bybit.tradingStopFails = true;
    const real = bybit.fetch;
    let closeTries = 0;
    bybit.fetch = async (url, init) => (init.method === "POST" && url.endsWith("/v5/order/create") && JSON.parse(init.body ?? "{}").reduceOnly === true && ++closeTries > 0 ? { ok: true, status: 200, text: async () => JSON.stringify({ retCode: 10016, retMsg: "Server Error", result: {} }) } : real(url, init));
    const ex = new BybitExecutor(config, bybit.fetch, (l) => logs.push(l), () => nowMs);
    ex.sleep = async () => {};
    const err = await ex.placeOpenOrder(openReq()).catch((e) => e);
    expect(err).not.toBeInstanceOf(OrderNotPlacedError);
    // The close is not given up on: it is retried every second until the 30 second cap, and the watchdog carries on after that.
    expect(String(err)).toMatch(/UNPROTECTED POSITION: a long 0.001 BTCUSDT may be open at Bybit WITHOUT a confirmed stop loss.*retried every second.*Close it at Bybit now/);
    expect(bybit.position.size).toBe(0.001);
    expect(closeTries).toBeGreaterThanOrEqual(25);
  });
});

describe("the position after an entry must be visible", () => {
  it("an order Bybit ended without filling is a definite refusal with Bybit's reason, nothing is held", async () => {
    bybit.onCreated = (o) => {
      Object.assign(o, { orderStatus: "Rejected", cumExecQty: 0, avgPrice: 0, rejectReason: "EC_InsufficientBalance" });
      bybit.hold(0);
    };
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(String(err)).toMatch(/ended the entry order without filling it \(Rejected: EC_InsufficientBalance\)/);
  });

  it("a filled order whose position cannot be seen is an unknown outcome that says to check Bybit, never a guess", async () => {
    bybit.overrides.set("/v5/position/list", () => ({ ok: true, status: 200, text: async () => JSON.stringify({ retCode: 0, result: { list: [{ symbol: "BTCUSDT", side: "", size: "0" }] } }) }));
    const real = bybit.overrides.get("/v5/position/list")!;
    // the first read (the flat check before the order) is real; later ones show nothing
    let n = 0;
    bybit.overrides.set("/v5/position/list", () => (++n === 1 ? real() : real()));
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).not.toBeInstanceOf(OrderNotPlacedError);
    expect(String(err)).toMatch(/the position it should have opened is not visible.*Check the Bybit demo account/);
  });
});

describe("a trade Bybit closed by itself", () => {
  /** Opens through the executor, records the position the way the engine does, and returns it. */
  async function openLong(ex: BybitExecutor, type: "short_put_spread" | "short_call_spread" = "short_put_spread") {
    const { ref } = await ex.placeOpenOrder(openReq({ positionType: type }));
    const state = await ex.getOrder(ref);
    return positionsStore.insert(buildPosition({ id: "p1", botId: BTC_BOT_ID, underlying: "BTC", type, status: "open", venue: "bybit", requestedQuantity: 1, filledQuantity: 1, credit: state.averagePrice!, openedAt: nowMs, brokerOrderRef: ref }));
  }

  it("a stop loss: the position is marked closed, as 'stop loss', with Bybit's exit price and the real loss", async () => {
    const ex = make();
    await openLong(ex);
    expect(bybit.movePrice(75_000)).toBe("StopLoss");
    nowMs += 120_000;
    expect(await ex.syncPositions(BTC_BOT_ID, nowMs)).toBe(1);
    const p = positionsStore.get("p1")!;
    expect(p).toMatchObject({ status: "closed", closeReason: "stop_loss", brokerOrderRef: "bybit-close-1002" });
    expect(positionPL(p)).toBeCloseTo(-1, 6); // (75,000 - 76,000) x 0.001
    expect(ordersStore.all().filter((o) => o.kind === "close").map((o) => [o.ref, o.status])).toEqual([["bybit-close-1002", "filled"]]);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).toMatch(/Closed at Bybit by Bybit's stop loss at 75000/);
  });

  it("a stop that Bybit's history lists without the reduce-only flag is still found, by its stop type", async () => {
    const ex = make();
    await openLong(ex);
    bybit.stopReduceOnly = false;
    bybit.movePrice(75_000);
    await ex.syncPositions(BTC_BOT_ID, nowMs);
    expect(positionsStore.get("p1")).toMatchObject({ status: "closed", closeReason: "stop_loss", brokerOrderRef: "bybit-close-1002" });
  });

  it("Bybit's history lagging behind the position (seen on the demo): the closing order is looked for again, and the stop is still recognised with its price", async () => {
    const ex = make();
    await openLong(ex);
    bybit.movePrice(75_000);
    bybit.historyLag = 3; // the first three looks at the history do not list the stop's order yet
    await ex.syncPositions(BTC_BOT_ID, nowMs);
    expect(positionsStore.get("p1")).toMatchObject({ status: "closed", closeReason: "stop_loss", brokerOrderRef: "bybit-close-1002" });
    expect(positionPL(positionsStore.get("p1")!)).toBeCloseTo(-1, 6);
    expect(positionsStore.get("p1")!.resultUnknown).toBeUndefined();
    expect(bybit.of("/v5/order/history").length).toBeGreaterThanOrEqual(4);
  });

  it("if the closing order never shows in that time the close is recorded without it - and is repaired on a later pass once Bybit lists it", async () => {
    const ex = make();
    await openLong(ex);
    bybit.movePrice(75_000);
    bybit.historyLag = 100;
    await ex.syncPositions(BTC_BOT_ID, nowMs);
    expect(positionsStore.get("p1")).toMatchObject({ status: "closed", closeReason: "closed_at_broker", closePrice: null, resultUnknown: "unknown, check Bybit" });
    bybit.historyLag = 0;
    expect(await ex.syncPositions(BTC_BOT_ID, nowMs + 10_000)).toBe(1);
    const p = positionsStore.get("p1")!;
    expect(p).toMatchObject({ status: "closed", closeReason: "stop_loss", brokerOrderRef: "bybit-close-1002" });
    expect(p.resultUnknown).toBeUndefined();
    expect(positionPL(p)).toBeCloseTo(-1, 6);
    expect(ordersStore.all().filter((o) => o.kind === "close")).toHaveLength(1);
    expect(await ex.syncPositions(BTC_BOT_ID, nowMs + 20_000)).toBe(0); // nothing left to repair
  });

  it("an unpriced close is only retried for 15 minutes", async () => {
    const ex = make();
    await openLong(ex);
    bybit.movePrice(75_000);
    bybit.historyLag = 100;
    await ex.syncPositions(BTC_BOT_ID, nowMs);
    bybit.historyLag = 0;
    expect(await ex.syncPositions(BTC_BOT_ID, nowMs + 16 * 60_000)).toBe(0);
    expect(positionsStore.get("p1")!.closeReason).toBe("closed_at_broker");
  });

  it("the previous trade's own close, a few seconds earlier, is never mistaken for this trade's stop (seen on the demo)", async () => {
    const ex = make();
    // trade A is opened and closed by the bot...
    const a = await ex.placeOpenOrder(openReq({ clientOrderId: "A" }));
    positionsStore.insert(buildPosition({ id: "pA", botId: BTC_BOT_ID, underlying: "BTC", type: "short_put_spread", status: "open", venue: "bybit", requestedQuantity: 1, filledQuantity: 1, credit: 0.76, openedAt: nowMs, brokerOrderRef: a.ref }));
    const closeA = await ex.placeCloseOrder(positionsStore.get("pA")!, { clientOrderId: "A-close" });
    positionsStore.update("pA", { status: "closed", closedAt: nowMs, brokerOrderRef: closeA.ref, closeReason: "signal_flip", closePrice: 0.76 });
    // ...two seconds later (inside the 5 second clock allowance) trade B opens, and Bybit's stop closes it, with the history not listing the stop's order yet
    nowMs += 2_000;
    const b = await ex.placeOpenOrder(openReq({ clientOrderId: "B" }));
    positionsStore.insert(buildPosition({ id: "pB", botId: BTC_BOT_ID, underlying: "BTC", type: "short_put_spread", status: "open", venue: "bybit", requestedQuantity: 1, filledQuantity: 1, credit: 0.76, openedAt: nowMs, brokerOrderRef: b.ref }));
    nowMs += 3_000;
    bybit.movePrice(75_000);
    bybit.historyLag = 2;
    await ex.syncPositions(BTC_BOT_ID, nowMs);
    const stopOrder = [...bybit.orders.values()].find((o) => o.stopOrderType === "StopLoss")!;
    expect(positionsStore.get("pB")).toMatchObject({ status: "closed", closeReason: "stop_loss", brokerOrderRef: `bybit-close-${stopOrder.orderId}` });
    expect(positionsStore.get("pB")!.brokerOrderRef).not.toBe(closeA.ref);
    expect(positionPL(positionsStore.get("pB")!)).toBeCloseTo(-1, 6);
  });

  it("the earlier trade's close, a few seconds before this entry, is not taken for the stop even when that trade is no longer on record (seen on the demo)", async () => {
    const ex = make();
    // an earlier trade, opened and closed through Bybit, that this record knows nothing about (as after a restart or a clean-up)
    await ex.placeOpenOrder(openReq({ clientOrderId: "old" }));
    await ex.placeCloseOrder(buildPosition({ type: "short_put_spread", status: "closing", brokerOrderRef: "bybit-open-1001", filledQuantity: 1, requestedQuantity: 1 }), { clientOrderId: "old-close" });
    nowMs += 3_900; // 3.9 seconds later the new trade opens: inside the old 5 second allowance
    const b = await ex.placeOpenOrder(openReq({ clientOrderId: "B" }));
    positionsStore.insert(buildPosition({ id: "pB", botId: BTC_BOT_ID, underlying: "BTC", type: "short_put_spread", status: "open", venue: "bybit", requestedQuantity: 1, filledQuantity: 1, credit: 0.76, openedAt: nowMs - 1_500, brokerOrderRef: b.ref }));
    nowMs += 60_000;
    bybit.movePrice(75_000);
    bybit.historyLag = 2; // the stop's own order is not listed yet at first
    await ex.syncPositions(BTC_BOT_ID, nowMs);
    const stopOrder = [...bybit.orders.values()].find((o) => o.stopOrderType === "StopLoss")!;
    expect(positionsStore.get("pB")).toMatchObject({ status: "closed", closeReason: "stop_loss", brokerOrderRef: `bybit-close-${stopOrder.orderId}` });
    expect(positionPL(positionsStore.get("pB")!)).toBeCloseTo(-1, 6);
  });

  it("an order from before the position opened is not its close, even with nothing else to find", async () => {
    const ex = make();
    const a = await ex.placeOpenOrder(openReq({ clientOrderId: "A" }));
    positionsStore.insert(buildPosition({ id: "pA", botId: BTC_BOT_ID, underlying: "BTC", type: "short_put_spread", status: "open", venue: "bybit", requestedQuantity: 1, filledQuantity: 1, credit: 0.76, openedAt: nowMs, brokerOrderRef: a.ref }));
    await ex.placeCloseOrder(positionsStore.get("pA")!, { clientOrderId: "A-close" });
    positionsStore.update("pA", { status: "closed", closedAt: nowMs, closeReason: "signal_flip", closePrice: 0.76 });
    nowMs += 20_000;
    positionsStore.insert(buildPosition({ id: "pB", botId: BTC_BOT_ID, underlying: "BTC", type: "short_put_spread", status: "open", venue: "bybit", requestedQuantity: 1, filledQuantity: 1, credit: 0.76, openedAt: nowMs, brokerOrderRef: "bybit-open-9999" })); // an entry that is no longer in the list: our own opening time is the bound
    await ex.syncPositions(BTC_BOT_ID, nowMs);
    expect(positionsStore.get("pB")).toMatchObject({ status: "closed", closeReason: "closed_at_broker", closePrice: null, resultUnknown: "unknown, check Bybit" });
  });

  it("a take profit", async () => {
    const ex = make();
    await openLong(ex);
    expect(bybit.movePrice(78_000)).toBe("TakeProfit");
    await ex.syncPositions(BTC_BOT_ID, nowMs);
    const p = positionsStore.get("p1")!;
    expect(p).toMatchObject({ status: "closed", closeReason: "take_profit" });
    expect(positionPL(p)).toBeCloseTo(2, 6);
  });

  it("a short's stop loss and take profit (the price rising stops it out)", async () => {
    const ex = make();
    await openLong(ex, "short_call_spread");
    expect(bybit.movePrice(77_000)).toBe("StopLoss");
    await ex.syncPositions(BTC_BOT_ID, nowMs);
    expect(positionPL(positionsStore.get("p1")!)).toBeCloseTo(-1, 6);
    expect(positionsStore.get("p1")!.closeReason).toBe("stop_loss");
  });

  it("closed by hand at Bybit (a reduce-only order that is not a stop): marked closed, said so, with its real exit price", async () => {
    const ex = make();
    await openLong(ex);
    bybit.price = 76_500;
    await make().placeCloseOrder(buildPosition({ type: "short_put_spread", status: "closing", brokerOrderRef: "bybit-open-1001", filledQuantity: 1, requestedQuantity: 1 }), { manual: true, clientOrderId: "by-hand" });
    await ex.syncPositions(BTC_BOT_ID, nowMs);
    const p = positionsStore.get("p1")!;
    expect(p).toMatchObject({ status: "closed", closeReason: "closed_at_broker" });
    expect(positionPL(p)).toBeCloseTo(0.5, 6);
  });

  it("flat with no closing order to find: closed, but with no price and 'unknown, check Bybit' - never an estimate", async () => {
    const ex = make();
    await openLong(ex);
    bybit.hold(0);
    bybit.orders.delete("1001"); // Bybit's history no longer shows anything to match
    await ex.syncPositions(BTC_BOT_ID, nowMs);
    const p = positionsStore.get("p1")!;
    expect(p).toMatchObject({ status: "closed", closeReason: "closed_at_broker", closePrice: null, resultUnknown: "unknown, check Bybit" });
    expect(positionPL(p)).toBeNull();
  });

  it("a position the account still holds is left alone, and with nothing open it asks Bybit nothing", async () => {
    const ex = make();
    await openLong(ex);
    expect(await ex.syncPositions(BTC_BOT_ID, nowMs)).toBe(0);
    expect(positionsStore.get("p1")!.status).toBe("open");
    bybit.calls.length = 0;
    expect(await ex.syncPositions("some_other_bot", nowMs)).toBe(0);
    expect(bybit.calls).toEqual([]);
  });

  it("an account that holds something else than the bot's record is flagged for a person and changed in no way", async () => {
    const ex = make();
    await openLong(ex);
    bybit.hold(-0.002);
    expect(await ex.syncPositions(BTC_BOT_ID, nowMs)).toBe(0);
    expect(positionsStore.get("p1")!.status).toBe("open");
    expect(botsStore.get(BTC_BOT_ID)).toMatchObject({ needsAttention: true });
    expect(botsStore.get(BTC_BOT_ID)!.needsAttentionReason).toMatch(/holds a short 0.002 BTCUSDT, which does not match the bot's open long of 0.001/);
  });

  it("Bybit's own closed profit and loss is what settles it later (the closing order is the stop's order)", async () => {
    const ex = make();
    await openLong(ex);
    bybit.movePrice(75_000);
    await ex.syncPositions(BTC_BOT_ID, nowMs);
    const r = await ex.getContractResult(positionsStore.get("p1")!.brokerOrderRef!);
    expect(r).toMatchObject({ settled: true });
    expect(r!.profit).toBeCloseTo(-1 - 75 * 0.00055 - 76 * 0.00055, 3);
  });
});
