import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { BybitConfigError, BybitExecutor, formatQty, mapBybitStatus, parseRef, readBybitConfig, toEngineUnits, type BybitConfig } from "./bybitExecutor";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { OrderNotPlacedError } from "./orderErrors";
import { resetAutomationStores, BASE_NOW } from "./testSupport";
import { positionsStore } from "./store";
import type { OpenSpreadRequest, Position } from "./types";

const SATURDAY = Date.UTC(2026, 9, 10, 15, 0);
const config: BybitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0.12, alwaysOn: false, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 5000 };
const env = { BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET, STOP_LOSS_PERCENT: "1", TAKE_PROFIT_PERCENT: "2", POSITION_SIZE: "0.001", DAILY_MAX_LOSS_USD: "10" };

let bybit: FakeBybit;
let logs: string[];
let nowMs: number;
const make = (over: Partial<BybitConfig> = {}) => {
  const ex = new BybitExecutor({ ...config, ...over }, bybit.fetch, (l) => logs.push(l), () => nowMs);
  ex.sleep = async () => {};
  return ex;
};
const openReq = (over: Partial<OpenSpreadRequest> = {}): OpenSpreadRequest => ({ botId: "ndx_ema_bias", underlying: "BTC", positionType: "short_put_spread", shortStrike: 29_000, longStrike: 28_990, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06", clientOrderId: "alert-1:open:0", ...over });
const held = (over: Partial<Position> = {}): Position =>
  ({ id: "pos-1", botId: "ndx_ema_bias", type: "short_put_spread", status: "closing", venue: "bybit", brokerOrderRef: "bybit-open-1001", filledQuantity: 1, requestedQuantity: 1, credit: 0.76, ...over }) as Position;

beforeEach(() => {
  resetAutomationStores();
  bybit = new FakeBybit();
  logs = [];
  nowMs = BASE_NOW; // a Tuesday morning inside the default window
  bybit.clock = () => nowMs;
});

describe("settings", () => {
  it("need the demo key and secret, and say which are missing without ever printing a value", () => {
    expect(() => readBybitConfig({})).toThrow(/BYBIT_DEMO_API_KEY, BYBIT_DEMO_API_SECRET, STOP_LOSS_PERCENT, TAKE_PROFIT_PERCENT, POSITION_SIZE, DAILY_MAX_LOSS_USD/);
    expect(() => readBybitConfig({ ...env, BYBIT_DEMO_API_SECRET: "" })).toThrow(/Missing|set in .env.local: BYBIT_DEMO_API_SECRET\./);
    try {
      readBybitConfig({ ...env, BYBIT_API_BASE: "https://api.bybit.com" });
    } catch (err) {
      expect(String(err)).not.toContain(API_SECRET);
    }
  });

  it("the four risk settings have NO defaults: with any one missing the executor will not exist, and the error names exactly that one", () => {
    for (const name of ["STOP_LOSS_PERCENT", "TAKE_PROFIT_PERCENT", "POSITION_SIZE", "DAILY_MAX_LOSS_USD"] as const) {
      const without = { ...env, [name]: undefined };
      expect(() => readBybitConfig(without), name).toThrow(new RegExp(`will not trade until these are set in .env.local: ${name}\\.`));
      expect(() => readBybitConfig({ ...env, [name]: "  " }), name).toThrow(BybitConfigError);
    }
  });

  it("refuses values that are not plain positive numbers", () => {
    for (const bad of ["0", "-1", "abc", "1%", "NaN", "Infinity"]) {
      for (const name of ["STOP_LOSS_PERCENT", "TAKE_PROFIT_PERCENT", "POSITION_SIZE", "DAILY_MAX_LOSS_USD"] as const) {
        expect(() => readBybitConfig({ ...env, [name]: bad }), `${name}=${bad}`).toThrow(BybitConfigError);
      }
    }
    expect(() => readBybitConfig({ ...env, STOP_LOSS_PERCENT: "100" })).toThrow(/below 100/);
    expect(() => readBybitConfig({ ...env, TAKE_PROFIT_PERCENT: "150" })).toThrow(/below 100/);
  });

  it("reads the four settings, and the other defaults are the demo host, BTCUSDT, not always on, 09:35 to 15:55", () => {
    expect(readBybitConfig({ ...env, STOP_LOSS_PERCENT: "0.5", TAKE_PROFIT_PERCENT: "1.5", POSITION_SIZE: "0.002", DAILY_MAX_LOSS_USD: "25.5" })).toMatchObject({
      apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.002, stopLossPercent: 0.5, takeProfitPercent: 1.5, dailyMaxLossUsd: 25.5, breakevenTriggerPercent: 0.3, breakevenLockPercent: 0.12, alwaysOn: false, hoursStart: "09:35", hoursEnd: "15:55",
    });
  });

  it("refuses any host but the demo one: real money cannot be reached", () => {
    for (const base of ["https://api.bybit.com", "https://api-testnet.bybit.com", "http://api-demo.bybit.com", "https://api-demo.bybit.com.evil.com", "https://user:pw@api-demo.bybit.com", "https://api-demo.bybit.com/v5"]) {
      expect(() => readBybitConfig({ ...env, BYBIT_API_BASE: base }), base).toThrow(BybitConfigError);
    }
    expect(readBybitConfig({ ...env, BYBIT_API_BASE: "https://api-demo.bybit.com/" }).apiBase).toBe("https://api-demo.bybit.com");
  });

  it("reads the always-on switch and the hours, and refuses nonsense", () => {
    expect(readBybitConfig({ ...env, BYBIT_ALWAYS_ON: "true" }).alwaysOn).toBe(true);
    expect(readBybitConfig({ ...env, BYBIT_ALWAYS_ON: "false" }).alwaysOn).toBe(false);
    expect(readBybitConfig({ ...env, BYBIT_HOURS_START: "08:00", BYBIT_HOURS_END: "12:30" })).toMatchObject({ hoursStart: "08:00", hoursEnd: "12:30" });
    expect(() => readBybitConfig({ ...env, BYBIT_ALWAYS_ON: "maybe" })).toThrow(/true or false/);
    expect(() => readBybitConfig({ ...env, BYBIT_HOURS_START: "16:00", BYBIT_HOURS_END: "09:00" })).toThrow(/must be before/);
    expect(() => readBybitConfig({ ...env, BYBIT_SYMBOL: "BTCUSD" })).toThrow(/BYBIT_SYMBOL/);
  });
});

describe("pure helpers", () => {
  it("formats a quantity the way Bybit wants it", () => {
    expect([formatQty(0.001), formatQty(0.003), formatQty(0.01), formatQty(1), formatQty(0.1 + 0.2)]).toEqual(["0.001", "0.003", "0.01", "1", "0.3"]);
  });

  it("a price is the dollar value of one contract over 100", () => {
    expect(toEngineUnits(76_000, 0.001)).toBe(0.76);
  });

  it("an order reference round-trips, and one that isn't ours is not read", () => {
    expect(parseRef("bybit-open-1001")).toEqual({ kind: "open", orderId: "1001" });
    expect(parseRef("bybit-close-ab-12_x")).toEqual({ kind: "close", orderId: "ab-12_x" });
    for (const bad of ["deriv-buy-1", "mock-1", "bybit-open-", "bybit-open-a b", "", null, undefined]) expect(parseRef(bad as string | null | undefined)).toBeNull();
  });

  it("maps Bybit's statuses and refuses one it doesn't know", () => {
    expect(["New", "Created", "Untriggered"].map(mapBybitStatus)).toEqual(["working", "working", "working"]);
    expect([mapBybitStatus("PartiallyFilled"), mapBybitStatus("Filled"), mapBybitStatus("Cancelled"), mapBybitStatus("Rejected")]).toEqual(["partially_filled", "filled", "canceled", "rejected"]);
    expect(() => mapBybitStatus("Mystery")).toThrow(/does not know/);
  });
});

describe("signing and the connection check", () => {
  it("signs a GET over timestamp + key + recvWindow + the query string, and sends the key headers", async () => {
    await make().checkConnection();
    const [c] = bybit.calls;
    expect(c.path).toBe("/v5/account/wallet-balance");
    expect(c.url.startsWith("https://api-demo.bybit.com/")).toBe(true);
    const sig = crypto.createHmac("sha256", API_SECRET).update(`${c.headers["X-BAPI-TIMESTAMP"]}${API_KEY}5000accountType=UNIFIED`).digest("hex");
    expect(c.headers).toMatchObject({ "X-BAPI-API-KEY": API_KEY, "X-BAPI-RECV-WINDOW": "5000", "X-BAPI-SIGN": sig });
    expect(c.headers["X-BAPI-TIMESTAMP"]).toBe(String(BASE_NOW));
  });

  it("signs a POST over the exact JSON body that is sent", async () => {
    await make().placeOpenOrder(openReq());
    const [c] = bybit.created;
    expect(c.headers["X-BAPI-SIGN"]).toMatch(/^[0-9a-f]{64}$/); // the fake exchange re-computes it and would have answered "error sign!"
    expect(bybit.orders.size).toBe(1);
  });

  it("a wrong secret is refused by Bybit, loudly and without the secret in the words", async () => {
    const ex = new BybitExecutor({ ...config, apiSecret: "another-secret-9999" }, bybit.fetch, (l) => logs.push(l), () => nowMs);
    const err = await ex.checkConnection().catch((e) => e);
    expect(String(err)).toMatch(/retCode 10004: error sign!/);
    expect(String(err) + logs.join("\n")).not.toContain("another-secret-9999");
  });

  it("is always a paper account, and never reads the key into a log line", async () => {
    const ex = make();
    expect(await ex.isPaperAccount()).toBe(true);
    await ex.checkConnection();
    await ex.placeOpenOrder(openReq());
    expect(logs.join("\n")).not.toContain(API_KEY);
    expect(logs.join("\n")).not.toContain(API_SECRET);
    expect(bybit.calls.every((c) => !c.url.includes(API_KEY) && !c.url.includes(API_SECRET))).toBe(true);
  });
});

describe("opening", () => {
  it("a bullish signal buys 0.001 BTCUSDT at market on the linear category, one-way mode, with a link id", async () => {
    const { ref } = await make().placeOpenOrder(openReq());
    expect(ref).toBe("bybit-open-1001");
    expect(bybit.created[0].params).toMatchObject({ category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: "0.001", positionIdx: 0 });
    expect(bybit.created[0].params.reduceOnly).toBeUndefined();
    expect(String(bybit.created[0].params.orderLinkId)).toMatch(/^bb[0-9a-f]{32}$/);
    expect(bybit.position).toMatchObject({ size: 0.001, avg: 76_000 });
    expect(logs.join("\n")).toMatch(/opened: Buy 0.001 BTCUSDT at market \(mark 76000\), stop loss 75240.0, take profit 77520.0, order 1001/);
    expect(bybit.created[0].params).toMatchObject({ stopLoss: "75240.0", takeProfit: "77520.0", slTriggerBy: "MarkPrice", tpTriggerBy: "MarkPrice", tpslMode: "Full", slOrderType: "Market", tpOrderType: "Market" });
    expect(bybit.position).toMatchObject({ stopLoss: 75240, takeProfit: 77520 });
  });

  it("a bearish signal sells short", async () => {
    await make().placeOpenOrder(openReq({ positionType: "short_call_spread" }));
    expect(bybit.created[0].params).toMatchObject({ side: "Sell", qty: "0.001" });
    expect(bybit.position.size).toBe(-0.001);
  });

  it("the size is the fixed POSITION_SIZE; an order for more than one contract is refused with nothing sent (one position at a time, one fixed size)", async () => {
    const err = await make().placeOpenOrder(openReq({ quantity: 3, clientOrderId: "a:3" })).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(String(err)).toMatch(/one fixed size \(POSITION_SIZE = 0.001 BTCUSDT\).*asks for 3 contracts/);
    expect(bybit.calls).toEqual([]);
    await make({ qty: 0.003 }).placeOpenOrder(openReq({ clientOrderId: "a:1" }));
    expect(bybit.created[0].params.qty).toBe("0.003");
  });

  it("refuses a fractional or zero quantity and another underlying, sending nothing", async () => {
    for (const req of [openReq({ quantity: 0 }), openReq({ quantity: 1.5 }), openReq({ underlying: "SPX" })]) {
      await expect(make().placeOpenOrder(req)).rejects.toBeInstanceOf(OrderNotPlacedError);
    }
    expect(bybit.calls).toEqual([]);
  });

  it("the same order id again returns the same order without a second one; a different order under it is refused", async () => {
    const ex = make();
    const a = await ex.placeOpenOrder(openReq());
    const b = await ex.placeOpenOrder(openReq());
    expect(b).toEqual(a);
    expect(bybit.created).toHaveLength(1);
    await expect(ex.placeOpenOrder(openReq({ positionType: "short_call_spread" }))).rejects.toThrow(/already used with a different order/);
  });

  it("after a restart (no memory of the order id) the same order is refused while the position is held, never doubled", async () => {
    await make().placeOpenOrder(openReq());
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(String(err)).toMatch(/already holds a long 0.001/);
    expect(bybit.created).toHaveLength(1);
  });

  it("is refused when the account is not flat, naming what it holds, and sends nothing", async () => {
    bybit.hold(-0.002);
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(String(err)).toMatch(/already holds a short 0.002 BTCUSDT/);
    expect(bybit.created).toHaveLength(0);
  });

  it("is refused when the position can't be checked, rather than sent blind", async () => {
    bybit.fail("/v5/position/list", { kind: "timeout", times: 3 }); // a read is asked 3 times in all before it gives up
    await expect(make().placeOpenOrder(openReq())).rejects.toBeInstanceOf(OrderNotPlacedError);
    expect(bybit.created).toHaveLength(0);
  });

  it("Bybit refusing the order is a definite refusal with Bybit's own words", async () => {
    bybit.overrides.set("/v5/order/create", () => ({ ok: true, status: 200, text: async () => JSON.stringify({ retCode: 110007, retMsg: "ab not enough for new order", result: {} }) }));
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(String(err)).toMatch(/retCode 110007: ab not enough for new order/);
  });

  it("an HTTP 403 (a blocked address) is a refusal; an HTTP 500 with no order found is an unknown outcome that says to check Bybit", async () => {
    bybit.fail("/v5/order/create", { kind: "http", status: 403, msg: "access denied" });
    await expect(make().placeOpenOrder(openReq())).rejects.toBeInstanceOf(OrderNotPlacedError);
    bybit.fail("/v5/order/create", { kind: "http", status: 500, msg: "boom" });
    const err = await make().placeOpenOrder(openReq({ clientOrderId: "other" })).catch((e) => e);
    expect(err).not.toBeInstanceOf(OrderNotPlacedError);
    expect(String(err)).toMatch(/may have gone through: check the Bybit demo account/);
  });

  it("a lost answer: the order did reach Bybit, so it is found by its link id and used, not sent twice", async () => {
    bybit.fail("/v5/order/create", { kind: "lose" });
    const { ref } = await make().placeOpenOrder(openReq());
    expect(ref).toBe("bybit-open-1001");
    expect(bybit.created).toHaveLength(1);
    expect(bybit.orders.size).toBe(1);
  });

  it("a timeout where no order exists is an unknown outcome, never retried", async () => {
    bybit.fail("/v5/order/create", { kind: "timeout" });
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).not.toBeInstanceOf(OrderNotPlacedError);
    expect(String(err)).toMatch(/could not be completed/);
    expect(bybit.created).toHaveLength(1);
  });
});

describe("closing", () => {
  it("closes a long with a reduce-only market Sell of the same size, and the position is flat afterwards", async () => {
    const ex = make();
    await ex.placeOpenOrder(openReq());
    const { ref } = await ex.placeCloseOrder(held(), { clientOrderId: "pos-1:close:1:1" });
    expect(ref).toBe("bybit-close-1002");
    expect(bybit.created[1].params).toMatchObject({ category: "linear", symbol: "BTCUSDT", side: "Sell", orderType: "Market", qty: "0.001", reduceOnly: true, positionIdx: 0 });
    expect(bybit.position.size).toBe(0);
  });

  it("closes a short with a reduce-only Buy", async () => {
    const ex = make();
    await ex.placeOpenOrder(openReq({ positionType: "short_call_spread" }));
    await ex.placeCloseOrder(held({ type: "short_call_spread" }), { clientOrderId: "c1" });
    expect(bybit.created[1].params).toMatchObject({ side: "Buy", reduceOnly: true });
  });

  it("every close carries reduceOnly: true", async () => {
    const ex = make();
    for (let i = 0; i < 3; i++) {
      await ex.placeOpenOrder(openReq({ clientOrderId: `o${i}` }));
      await ex.placeCloseOrder(held(), { clientOrderId: `c${i}` });
    }
    expect(bybit.created.filter((c) => c.params.reduceOnly === true)).toHaveLength(3);
    expect(bybit.created.filter((c) => c.params.reduceOnly === undefined)).toHaveLength(3);
  });

  it("is refused, with nothing sent, when the account holds nothing: it would otherwise be a stuck position left for Resolve", async () => {
    const err = await make().placeCloseOrder(held(), { clientOrderId: "c" }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect((err as OrderNotPlacedError).needsResolve).toBe(true);
    expect(String(err)).toMatch(/does not hold this position to close.*holds nothing/);
    expect(bybit.created).toHaveLength(0);
  });

  it("is refused when the account holds the other side, or less than the size to close", async () => {
    bybit.hold(-0.001);
    await expect(make().placeCloseOrder(held(), { clientOrderId: "c" })).rejects.toThrow(/Needed a long of 0.001.*holds a short 0.001/);
    bybit.hold(0.001);
    await expect(make().placeCloseOrder(held({ filledQuantity: 2 }), { clientOrderId: "c2" })).rejects.toThrow(/Needed a long of 0.002.*holds a long 0.001/);
    expect(bybit.created).toHaveLength(0);
  });

  it("closes only its own size when the account holds more", async () => {
    bybit.hold(0.005);
    await make().placeCloseOrder(held(), { clientOrderId: "c" });
    expect(bybit.created[0].params.qty).toBe("0.001");
    expect(bybit.position.size).toBeCloseTo(0.004, 9);
  });

  it("refuses a position that has no Bybit order", async () => {
    await expect(make().placeCloseOrder(held({ brokerOrderRef: "deriv-buy-5" }), {})).rejects.toThrow(/no Bybit order/);
    await expect(make().placeCloseOrder(held({ brokerOrderRef: undefined }), {})).rejects.toThrow(/no Bybit order/);
  });

  it("the same close id twice gives the same order, not a second close", async () => {
    const ex = make();
    await ex.placeOpenOrder(openReq());
    const a = await ex.placeCloseOrder(held(), { clientOrderId: "c" });
    const b = await ex.placeCloseOrder(held(), { clientOrderId: "c" });
    expect(b).toEqual(a);
    expect(bybit.created).toHaveLength(2);
  });
});

describe("reading an order back", () => {
  it("an open: filled, its size in contracts, its price in the engine's units", async () => {
    const ex = make();
    const { ref } = await ex.placeOpenOrder(openReq({ clientOrderId: "a" }));
    expect(await ex.getOrder(ref)).toMatchObject({ status: "filled", filledQuantity: 1, averagePrice: 0.76, ibkrStatus: "Filled" });
  });

  it("a close of a long: the engine's own formula gives exactly (exit - entry) x size", async () => {
    const ex = make();
    const open = await ex.placeOpenOrder(openReq());
    positionsStore.insert({ ...held(), brokerOrderRef: open.ref, credit: 0.76 });
    bybit.price = 77_000;
    const close = await ex.placeCloseOrder(held(), { clientOrderId: "c" });
    positionsStore.update("pos-1", { brokerOrderRef: close.ref });
    const s = await ex.getOrder(close.ref);
    expect(s).toMatchObject({ status: "filled", filledQuantity: 1 });
    expect((0.76 - s.averagePrice!) * 100 * 1).toBeCloseTo(1, 6); // (77,000 - 76,000) x 0.001 = +$1
  });

  it("a close of a short: a fall is a profit", async () => {
    const ex = make();
    const open = await ex.placeOpenOrder(openReq({ positionType: "short_call_spread" }));
    positionsStore.insert({ ...held({ type: "short_call_spread" }), brokerOrderRef: open.ref, credit: 0.76 });
    bybit.price = 75_000;
    const close = await ex.placeCloseOrder(held({ type: "short_call_spread" }), { clientOrderId: "c" });
    positionsStore.update("pos-1", { brokerOrderRef: close.ref });
    const s = await ex.getOrder(close.ref);
    expect((0.76 - s.averagePrice!) * 100).toBeCloseTo(1, 6); // (76,000 - 75,000) x 0.001 = +$1
  });

  it("a close whose position has no entry on record is an error, not a guessed result", async () => {
    const ex = make();
    await ex.placeOpenOrder(openReq());
    const close = await ex.placeCloseOrder(held(), { clientOrderId: "c" });
    await expect(ex.getOrder(close.ref)).rejects.toThrow(/no entry price on record/);
  });

  it("a rejected order carries Bybit's reason; an order Bybit doesn't know is an error", async () => {
    const ex = make();
    const { ref } = await ex.placeOpenOrder(openReq());
    Object.assign(bybit.orders.get("1001")!, { orderStatus: "Rejected", cumExecQty: 0, avgPrice: 0, rejectReason: "EC_PerCancelRequest" });
    expect(await ex.getOrder(ref)).toMatchObject({ status: "rejected", filledQuantity: 0, rejectReason: "EC_PerCancelRequest" });
    await expect(ex.getOrder("bybit-open-9999")).rejects.toThrow(/no order 9999/);
    await expect(ex.getOrder("deriv-buy-1")).rejects.toThrow(/not a Bybit order reference/);
  });

  it("a fill with no average price is an error, never a made-up price", async () => {
    const ex = make();
    const { ref } = await ex.placeOpenOrder(openReq());
    bybit.orders.get("1001")!.avgPrice = 0;
    await expect(ex.getOrder(ref)).rejects.toThrow(/gave no average price/);
  });
});

describe("Bybit's own result", () => {
  it("is the closed profit and loss Bybit lists for the closing order, net of fees", async () => {
    const ex = make();
    await ex.placeOpenOrder(openReq());
    bybit.price = 77_000;
    const close = await ex.placeCloseOrder(held(), { clientOrderId: "c" });
    const r = await ex.getContractResult(close.ref);
    expect(r).toMatchObject({ settled: true, status: "closed" });
    expect(r!.profit).toBeCloseTo(1 - 77 * 0.00055 - 76 * 0.00055, 3);
  });

  it("is not settled while Bybit has not listed it, and not asked for an open", async () => {
    const ex = make();
    expect(await ex.getContractResult("bybit-close-4242")).toMatchObject({ settled: false, profit: null });
    expect(await ex.getContractResult("bybit-open-1001")).toBeNull();
    expect(bybit.of("/v5/position/closed-pnl")).toHaveLength(1);
  });

  it("when the demo does not support the endpoint, the error is Bybit's own words", async () => {
    bybit.closedPnlSupported = false;
    await expect(make().getContractResult("bybit-close-4242")).rejects.toThrow(/not supported on demo/);
  });
});

describe("cancel", () => {
  it("an order that is already over is not an error", async () => {
    await expect(make().cancelOrder("bybit-open-1001")).resolves.toBeUndefined();
    expect(bybit.of("/v5/order/cancel")[0].params).toMatchObject({ category: "linear", symbol: "BTCUSDT", orderId: "1001" });
    expect(logs.join("\n")).toMatch(/already over/);
  });
});

describe("the trading window", () => {
  it("not always on: a Saturday open and an after-hours open are refused before anything is sent, not even a read", async () => {
    for (const at of [SATURDAY, Date.UTC(2026, 9, 6, 21, 0)]) {
      nowMs = at;
      const err = await make().placeOpenOrder(openReq({ clientOrderId: `w${at}` })).catch((e) => e);
      expect(err).toBeInstanceOf(OrderNotPlacedError);
      expect(String(err)).toMatch(/outside trading window/);
    }
    expect(bybit.calls).toEqual([]);
  });

  it("always on: a Saturday open goes through", async () => {
    nowMs = SATURDAY;
    await make({ alwaysOn: true }).placeOpenOrder(openReq());
    expect(bybit.created).toHaveLength(1);
  });

  it("not always on: a scheduled close outside the window is refused, but a person's own Close position is never held to it", async () => {
    const ex = make();
    await ex.placeOpenOrder(openReq());
    nowMs = SATURDAY;
    await expect(ex.placeCloseOrder(held(), { clientOrderId: "c1" })).rejects.toThrow(/outside trading window/);
    await expect(ex.placeCloseOrder(held(), { clientOrderId: "c2", manual: true })).resolves.toMatchObject({ ref: "bybit-close-1002" });
  });

  it("reports its window to the engine: BTC only (the NDX Bias Bot gets none), with alwaysOn when set", () => {
    expect(make().tradingWindowFor("BTC")).toEqual({ start: "09:35", end: "15:55" });
    expect(make({ alwaysOn: true }).tradingWindowFor("btc")).toEqual({ start: "09:35", end: "15:55", alwaysOn: true });
    expect(make().tradingWindowFor("SPX")).toBeNull();
    expect(make().tradingWindowFor("NDX")).toBeNull();
    expect("lastBuyMinutesFor" in make()).toBe(false); // a perpetual has no expiry, so no last buy time
  });
});

describe("Bybit's list of closed trades", () => {
  it("each closed-pnl record becomes a trade: the position's side (a Sell closes a long), size, entry, exit, net result, fees, time, newest first", async () => {
    const ex = make();
    await ex.placeOpenOrder(openReq({ clientOrderId: "a" }));
    bybit.price = 77_000;
    nowMs += 1_000;
    await ex.placeCloseOrder(held(), { clientOrderId: "a-close" });
    bybit.price = 76_000;
    nowMs += 1_000;
    await ex.placeOpenOrder(openReq({ clientOrderId: "b", positionType: "short_call_spread" }));
    bybit.price = 75_000;
    nowMs += 1_000;
    await ex.placeCloseOrder(held({ type: "short_call_spread" }), { clientOrderId: "b-close" });
    const trades = await ex.getClosedTrades();
    expect(trades.map((t) => t.side)).toEqual(["Short", "Long"]); // newest first
    expect(trades[1]).toMatchObject({ size: 0.001, entryPrice: 76_000, exitPrice: 77_000, kind: "user" });
    expect(trades[1].pnl).toBeCloseTo(1 - 76 * 0.00055 - 77 * 0.00055, 3);
    expect(trades[1].fees).toBeCloseTo(76 * 0.00055 + 77 * 0.00055, 4);
    expect(trades[0]).toMatchObject({ entryPrice: 76_000, exitPrice: 75_000 });
    expect(trades[1]).toMatchObject({ leverage: 10 });
    expect(trades[1].openFee).toBeCloseTo(76 * 0.00055, 4);
    expect(trades[1].closeFee).toBeCloseTo(77 * 0.00055, 4);
    expect(trades[1].entryValue).toBeCloseTo(76, 6);
    expect(trades[1].exitValue).toBeCloseTo(77, 6);
    expect(trades[0].closedAt).toBeGreaterThan(trades[1].closedAt);
  });

  it("asks Bybit for the latest 100 closed trades", async () => {
    await make().getClosedTrades();
    expect(bybit.of("/v5/position/closed-pnl")[0].params).toMatchObject({ category: "linear", symbol: "BTCUSDT", limit: "100" });
  });

  it("an order Bybit placed for its stop loss or take profit is told apart from one a person placed", async () => {
    const ex = make();
    await ex.placeOpenOrder(openReq({ clientOrderId: "a" }));
    bybit.movePrice(75_000);
    await ex.placeOpenOrder(openReq({ clientOrderId: "b" }));
    bybit.movePrice(78_000);
    expect((await ex.getClosedTrades()).map((t) => t.kind)).toEqual(["take_profit", "stop_loss"]);
  });

  it("a trade whose closing order is no longer in the recent order history has no kind rather than a guess; a failed history read does not stop the list", async () => {
    const ex = make();
    await ex.placeOpenOrder(openReq({ clientOrderId: "a" }));
    await ex.placeCloseOrder(held(), { clientOrderId: "a-close" });
    bybit.orders.delete("1002");
    expect((await ex.getClosedTrades())[0].kind).toBeNull();
    bybit.fail("/v5/order/history", { kind: "http", status: 500, msg: "down" });
    expect((await ex.getClosedTrades())[0]).toMatchObject({ pnl: expect.any(Number), kind: null });
  });

  it("skips a record it cannot read, and fails loudly when the closed-pnl call itself fails", async () => {
    const ex = make();
    bybit.closedPnl.unshift({ orderId: "bad", closedPnl: "not a number", side: "Sell" }, { orderId: "worse", closedPnl: "1", side: "Hold" });
    expect(await ex.getClosedTrades()).toEqual([]);
    bybit.closedPnlSupported = false;
    await expect(ex.getClosedTrades()).rejects.toThrow(/not supported on demo/);
  });
});
