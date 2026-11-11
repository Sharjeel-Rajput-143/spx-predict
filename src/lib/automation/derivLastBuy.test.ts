import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord } from "./bots";
import { AfterLastBuyError, DerivExecutor, durationMinutes, readDerivConfig, type DerivConfig } from "./derivExecutor";
import { ACCOUNT, APP_ID, FakeDeriv, TOKEN } from "./derivTestSupport";
import { manualOpen, processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import { OrderNotPlacedError } from "./orderErrors";
import { RoutedExecutor } from "./routedExecutor";
import { botsStore, decisionsStore, positionsStore } from "./store";
import { NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import { lastBuyCheck } from "./tradingWindow";

// The last buy time: window end - the contract's duration - a margin (a setting). After it a NEW signal is skipped, not sent and not rejected. Nothing touches a network.

setNdxTestEnv();
const utc = (y: number, m: number, d: number, h: number, min: number, s = 0) => Date.UTC(y, m - 1, d, h, min, s);
const config: DerivConfig = { token: TOKEN, appId: APP_ID, accountId: ACCOUNT, apiBase: "https://api.derivws.com", symbol: "OTC_NDX", product: "rise_fall", stake: 10, maxStake: 100, currency: "USD", duration: 1, durationUnit: "h", maxSlippage: 0.02, allowReal: false, timeoutMs: 1500, hoursStart: "09:35", hoursEnd: "15:55", lastBuyMarginMinutes: 5 };
const fast = { closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 };
const min = (h: number, m: number) => h * 60 + m;

let deriv: FakeDeriv;
let logs: string[];
let nowMs: number;
const make = (c: DerivConfig = config) => new DerivExecutor(c, deriv.fetch, deriv.socketFactory, (l) => logs.push(l), () => nowMs);
const openReq = () => ({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", positionType: "short_put_spread" as const, shortStrike: 29_250, longStrike: 29_200, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06", clientOrderId: "o1" });
const nothingSent = () => {
  expect(deriv.restCalls).toEqual([]);
  expect(deriv.sent).toEqual([]);
  expect(deriv.opened).toEqual([]);
};

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  deriv = new FakeDeriv();
  logs = [];
  nowMs = utc(2026, 10, 6, 14, 0); // 10:00am New York
});
afterEach(() => vi.unstubAllEnvs());

describe("the setting and the arithmetic", () => {
  const env = { DERIV_API_TOKEN: TOKEN, DERIV_APP_ID: APP_ID, DERIV_ACCOUNT_ID: ACCOUNT };
  it("the margin is a setting, default 5 minutes, and a bad one is a loud error", () => {
    expect(readDerivConfig(env).lastBuyMarginMinutes).toBe(5);
    expect(readDerivConfig({ ...env, DERIV_LAST_BUY_MARGIN_MINUTES: "10" }).lastBuyMarginMinutes).toBe(10);
    expect(readDerivConfig({ ...env, DERIV_LAST_BUY_MARGIN_MINUTES: "0" }).lastBuyMarginMinutes).toBe(0);
    expect(() => readDerivConfig({ ...env, DERIV_LAST_BUY_MARGIN_MINUTES: "-1" })).toThrow(/DERIV_LAST_BUY_MARGIN_MINUTES/);
    expect(() => readDerivConfig({ ...env, DERIV_LAST_BUY_MARGIN_MINUTES: "x" })).toThrow(/DERIV_LAST_BUY_MARGIN_MINUTES/);
  });

  it("a contract length that cannot finish inside the window is refused when the settings are read", () => {
    expect(() => readDerivConfig({ ...env, DERIV_DURATION: "1", DERIV_DURATION_UNIT: "d" })).toThrow(/cannot finish inside the trading window/);
    expect(() => readDerivConfig({ ...env, DERIV_DURATION: "7", DERIV_DURATION_UNIT: "h" })).toThrow(/last buy time would be before the window opens/);
    expect(readDerivConfig({ ...env, DERIV_DURATION: "15", DERIV_DURATION_UNIT: "m" }).duration).toBe(15);
    expect(readDerivConfig({ ...env, DERIV_PRODUCT: "multiplier", DERIV_MULTIPLIER: "100" }).product).toBe("multiplier"); // no length to fit
  });

  it("durations in minutes", () => {
    expect(durationMinutes({ product: "rise_fall", duration: 1, durationUnit: "h" })).toBe(60);
    expect(durationMinutes({ product: "rise_fall", duration: 15, durationUnit: "m" })).toBe(15);
    expect(durationMinutes({ product: "rise_fall", duration: 90, durationUnit: "s" })).toBe(1.5);
    expect(durationMinutes({ product: "rise_fall", duration: 1, durationUnit: "d" })).toBe(1440);
    expect(durationMinutes({ product: "multiplier", duration: 1, durationUnit: "h" })).toBe(0);
  });

  it("a 1 hour contract: window end 15:55 - 60 - 5 = 14:50", () => {
    expect(make().lastBuyMinutesFor("NDX", utc(2026, 10, 6, 14, 0))).toBe(min(14, 50));
    expect(make().lastBuyMinutesFor("ndx", utc(2026, 12, 8, 15, 0))).toBe(min(14, 50)); // winter: still New York time
  });

  it("the duration and the margin move it", () => {
    expect(make({ ...config, duration: 15, durationUnit: "m" }).lastBuyMinutesFor("NDX", nowMs)).toBe(min(15, 35));
    expect(make({ ...config, lastBuyMarginMinutes: 0 }).lastBuyMinutesFor("NDX", nowMs)).toBe(min(14, 55));
    expect(make({ ...config, lastBuyMarginMinutes: 10 }).lastBuyMinutesFor("NDX", nowMs)).toBe(min(14, 45));
    expect(make({ ...config, hoursEnd: "15:00", lastBuyMarginMinutes: 5 }).lastBuyMinutesFor("NDX", nowMs)).toBe(min(13, 55));
  });

  it("on an early-close day it follows that day's end (12:55 - 65 = 11:50)", () => {
    expect(make().lastBuyMinutesFor("NDX", utc(2026, 11, 27, 16, 0))).toBe(min(11, 50));
  });

  it("only for the underlying it trades, and through the router", () => {
    expect(make().lastBuyMinutesFor("SPX", nowMs)).toBeNull();
    const routed = new RoutedExecutor(make(), new MockExecutor(), ["NDX"]);
    expect(routed.lastBuyMinutesFor?.("NDX", nowMs)).toBe(min(14, 50));
    expect(routed.lastBuyMinutesFor?.("SPX", nowMs)).toBeNull();
    expect(lastBuyCheck(routed, "SPX", nowMs)).toBeNull();
    expect(lastBuyCheck({}, "NDX", nowMs)).toBeNull(); // an executor without one (the simulation, IBKR): no such limit
  });

  it("lastBuyCheck says whether now is past it, and the time", () => {
    const ex = make();
    expect(lastBuyCheck(ex, "NDX", utc(2026, 10, 6, 18, 50, 59))).toEqual({ late: false, at: "14:50" });
    expect(lastBuyCheck(ex, "NDX", utc(2026, 10, 6, 18, 51))).toEqual({ late: true, at: "14:50" });
  });
});

describe("the executor: nothing is sent after the last buy time", () => {
  it("a buy at 14:50:59 still goes; at 14:51 nothing is sent, not even a sign-in, and the error says why", async () => {
    nowMs = utc(2026, 10, 6, 18, 50, 59);
    expect((await make().placeOpenOrder(openReq())).ref).toMatch(/^deriv-buy-/);
    deriv = new FakeDeriv();
    logs = [];
    nowMs = utc(2026, 10, 6, 18, 51);
    const err = await make().placeOpenOrder(openReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AfterLastBuyError);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect((err as Error).message).toBe("Skipped: after last buy time (14:50 New York time: the window ends 15:55, less the 1h contract and a 5 minute margin): the open was not sent to Deriv.");
    expect(logs.join("\n")).toMatch(/after last buy time/);
    nothingSent();
  });

  it("a close is never held to it: a sell at 15:30 and at 15:54 go through", async () => {
    nowMs = utc(2026, 10, 6, 14, 0);
    const { ref } = await make().placeOpenOrder(openReq());
    const held = buildPosition({ id: "pos-1", botId: NDX_BOT_ID, underlying: "NDX", type: "short_put_spread", status: "open", requestedQuantity: 1, filledQuantity: 1, brokerOrderRef: ref, credit: 0.1 });
    nowMs = utc(2026, 10, 6, 19, 54);
    expect((await make().placeCloseOrder(held)).ref).toBe("deriv-sell-987654321");
    expect(deriv.calls("sell")).toHaveLength(1);
  });
});

describe("the engine: a signal after the last buy time is logged as 'after last buy time' and not sent", () => {
  const alert = (direction: "bullish" | "bearish", barTime: string, at: number) =>
    receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 29_284.55, barTime, interval: "5", raw: { symbol: "NDX" }, now: at });
  const run = (direction: "bullish" | "bearish", barTime: string, at: number, ex = make()) => {
    nowMs = at;
    return processSignal(alert(direction, barTime, at), { executor: ex, now: at, ...fast });
  };
  beforeEach(() => ensureBotRecord(NDX_BOT_ID));

  it("at 14:51 (inside the window, past the last buy time): skipped, logged, nothing sent, no position, not rejected, no flag, the bot stays on", async () => {
    await run("bullish", "b1", utc(2026, 10, 6, 18, 51));
    const d = decisionsStore.all().find((x) => x.outcome === "after_last_buy_time");
    expect(d?.reason).toBe("Skipped: after last buy time (14:50 New York time: the end of the trading window less the contract's length and a margin). Nothing was sent to the broker.");
    expect(decisionsStore.all().map((x) => x.outcome)).toEqual(["after_last_buy_time"]);
    nothingSent();
    expect(positionsStore.all()).toHaveLength(0); // so nothing was created and then rejected
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ needsAttention: false, enabled: true });
  });

  it("at 14:50 the same alert opens", async () => {
    await run("bullish", "b1", utc(2026, 10, 6, 18, 50));
    expect(decisionsStore.all().map((x) => x.outcome)).toEqual(["opened"]);
    expect(deriv.calls("buy")).toHaveLength(1);
  });

  it("a flip after the last buy time still SELLS the held contract, and only the new buy is skipped", async () => {
    await run("bullish", "b1", utc(2026, 10, 6, 14, 0));
    deriv.sent.length = 0;
    await run("bearish", "b2", utc(2026, 10, 6, 19, 10)); // 3:10pm
    expect(deriv.calls("sell")).toHaveLength(1);
    expect(deriv.calls("buy")).toHaveLength(0);
    expect(decisionsStore.all().map((x) => x.outcome)).toEqual(["opened", "closed", "after_last_buy_time"]);
    expect(positionsStore.all().map((p) => p.status)).toEqual(["closed"]);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(false);
  });

  it("a signal for the side already held says so (it is not an 'after last buy time' skip)", async () => {
    await run("bullish", "b1", utc(2026, 10, 6, 14, 0));
    await run("bullish", "b2", utc(2026, 10, 6, 19, 10));
    expect(decisionsStore.all().map((x) => x.outcome).at(-1)).toBe("already_in_position");
  });

  it("a hand-placed position is held to it too", async () => {
    nowMs = utc(2026, 10, 6, 19, 0);
    const res = await manualOpen(NDX_BOT_ID, { type: "short_put_spread", shortStrike: 29_250, underlyingPrice: 29_284.55 }, { executor: make(), now: nowMs, ...fast });
    expect(res.outcome).toBe("after_last_buy_time");
    nothingSent();
  });

  it("the margin setting moves the cutoff: with 10 minutes, 14:46 is skipped and 14:45 is not", async () => {
    const ex = make({ ...config, lastBuyMarginMinutes: 10 });
    await run("bullish", "b1", utc(2026, 10, 6, 18, 46), ex);
    expect(decisionsStore.all().map((x) => x.outcome)).toEqual(["after_last_buy_time"]);
    resetAutomationStores();
    setNdxTestEnv();
    ensureBotRecord(NDX_BOT_ID);
    deriv = new FakeDeriv();
    await run("bullish", "b2", utc(2026, 10, 6, 18, 45), make({ ...config, lastBuyMarginMinutes: 10 }));
    expect(decisionsStore.all().map((x) => x.outcome)).toEqual(["opened"]);
  });

  it("another underlying behind the router has no last buy time", async () => {
    const routed = new RoutedExecutor(make(), new MockExecutor(), ["NDX"]);
    expect(routed.lastBuyMinutesFor?.("SPX", utc(2026, 10, 6, 19, 30))).toBeNull();
  });
});
