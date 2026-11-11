import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord } from "./bots";
import { DerivExecutor, TradingWindowError, readDerivConfig, type DerivConfig } from "./derivExecutor";
import { ACCOUNT, APP_ID, FakeDeriv, TOKEN } from "./derivTestSupport";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { runDueSweeps, sweepBot, sweepMinutesFor, sweepModeFor } from "./eodSweep";
import { runExitChecks } from "./exitChecks";
import { OrderNotPlacedError } from "./orderErrors";
import { RoutedExecutor } from "./routedExecutor";
import { MockExecutor } from "./executor";
import { botsStore, decisionsStore, positionsStore } from "./store";
import { NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import { hoursFor } from "./tradingWindow";
import { isWithinTradingHours } from "./tradingHours";

// The trading window: Deriv is only sent orders between 09:35 and 15:55 New York time (America/New_York, so daylight saving follows by itself), Monday to Friday.
// It is separate from the hours Deriv has the instrument open. Nothing here touches a network.

setNdxTestEnv();
const utc = (y: number, m: number, d: number, h: number, min: number, s = 0) => Date.UTC(y, m - 1, d, h, min, s);
const config: DerivConfig = { token: TOKEN, appId: APP_ID, accountId: ACCOUNT, apiBase: "https://api.derivws.com", symbol: "OTC_NDX", product: "rise_fall", stake: 10, maxStake: 100, currency: "USD", duration: 1, durationUnit: "h", maxSlippage: 0.02, allowReal: false, timeoutMs: 1500, hoursStart: "09:35", hoursEnd: "15:55", lastBuyMarginMinutes: 5 };
const fast = { closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 };

let deriv: FakeDeriv;
let logs: string[];
let nowMs: number;
const make = (c: DerivConfig = config) => new DerivExecutor(c, deriv.fetch, deriv.socketFactory, (l) => logs.push(l), () => nowMs);
const openReq = (over = {}) => ({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", positionType: "short_put_spread" as const, shortStrike: 29_250, longStrike: 29_200, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06", clientOrderId: "o1", ...over });
const held = (ref: string) => buildPosition({ id: "pos-1", botId: NDX_BOT_ID, underlying: "NDX", type: "short_put_spread", status: "open", requestedQuantity: 1, filledQuantity: 1, brokerOrderRef: ref, credit: 0.1 });
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
  nowMs = utc(2026, 10, 6, 14, 40); // 10:40am New York, a Tuesday
});
afterEach(() => vi.unstubAllEnvs());

describe("the setting", () => {
  const env = { DERIV_API_TOKEN: TOKEN, DERIV_APP_ID: APP_ID, DERIV_ACCOUNT_ID: ACCOUNT };
  it("DERIV_HOURS_START and DERIV_HOURS_END are strings, default 09:35 and 15:55, and can be changed", () => {
    expect(readDerivConfig(env)).toMatchObject({ hoursStart: "09:35", hoursEnd: "15:55" });
    expect(readDerivConfig({ ...env, DERIV_HOURS_START: "10:00", DERIV_HOURS_END: "15:30" })).toMatchObject({ hoursStart: "10:00", hoursEnd: "15:30" });
  });
  it("a bad value or a start that is not before the end is a loud configuration error", () => {
    expect(() => readDerivConfig({ ...env, DERIV_HOURS_START: "9.35" })).toThrow(/DERIV_HOURS_START/);
    expect(() => readDerivConfig({ ...env, DERIV_HOURS_END: "25:00" })).toThrow(/DERIV_HOURS_END/);
    expect(() => readDerivConfig({ ...env, DERIV_HOURS_START: "15:55", DERIV_HOURS_END: "09:35" })).toThrow(/must be before/);
    expect(() => readDerivConfig({ ...env, DERIV_HOURS_START: "10:00", DERIV_HOURS_END: "10:00" })).toThrow(/must be before/);
  });
  it("the executor reports its window for NDX only, and through the router", () => {
    const ex = make();
    expect(ex.tradingWindowFor("NDX")).toEqual({ start: "09:35", end: "15:55" });
    expect(ex.tradingWindowFor("ndx")).toEqual({ start: "09:35", end: "15:55" });
    expect(ex.tradingWindowFor("SPX")).toBeNull();
    const routed = new RoutedExecutor(ex, new MockExecutor(), ["NDX"]);
    expect(routed.tradingWindowFor?.("NDX")).toEqual({ start: "09:35", end: "15:55" });
    expect(routed.tradingWindowFor?.("SPX")).toBeNull();
    expect(hoursFor(routed, "SPX", { start: "09:00", end: "10:00" })).toMatchObject({ startMinutes: 540, endMinutes: 600 });
    expect(hoursFor(routed, "NDX", { start: "09:00", end: "10:00" })).toMatchObject({ startMinutes: 575, endMinutes: 955 });
  });
});

describe("the window, in New York time, through daylight saving", () => {
  const inWindow = (ms: number) => isWithinTradingHours(ms, hoursFor(make(), "NDX"));
  it("summer (EDT, UTC-4): 9:35 is in, 9:34:59 is out, 3:55:59 is in, 3:56 is out", () => {
    expect(inWindow(utc(2026, 10, 6, 13, 34, 59))).toBe(false);
    expect(inWindow(utc(2026, 10, 6, 13, 35))).toBe(true);
    expect(inWindow(utc(2026, 10, 6, 19, 55, 59))).toBe(true);
    expect(inWindow(utc(2026, 10, 6, 19, 56))).toBe(false);
  });
  it("winter (EST, UTC-5): the same New York times are an hour later in UTC", () => {
    expect(inWindow(utc(2026, 12, 8, 14, 34, 59))).toBe(false);
    expect(inWindow(utc(2026, 12, 8, 14, 35))).toBe(true);
    expect(inWindow(utc(2026, 12, 8, 20, 55, 59))).toBe(true);
    expect(inWindow(utc(2026, 12, 8, 20, 56))).toBe(false);
    // 13:35 UTC is 9:35 in summer but 8:35 in winter: a fixed UTC offset would get one of them wrong
    expect(inWindow(utc(2026, 12, 8, 13, 35))).toBe(false);
  });
  it("across the March change: Friday March 6 (EST) and Monday March 9 (EDT) open at different UTC times", () => {
    expect(inWindow(utc(2026, 3, 6, 14, 35))).toBe(true);
    expect(inWindow(utc(2026, 3, 6, 13, 35))).toBe(false);
    expect(inWindow(utc(2026, 3, 9, 13, 35))).toBe(true);
    expect(inWindow(utc(2026, 3, 9, 14, 35))).toBe(true);
    expect(inWindow(utc(2026, 3, 9, 13, 34))).toBe(false);
  });
  it("Saturday and Sunday are out, whatever the hour", () => {
    expect(inWindow(utc(2026, 10, 10, 15, 0))).toBe(false);
    expect(inWindow(utc(2026, 10, 11, 15, 0))).toBe(false);
  });
  it("an exchange holiday is out, and an early-close day ends the same distance before 1:00pm (12:55)", () => {
    expect(inWindow(utc(2026, 11, 26, 16, 0))).toBe(false); // Thanksgiving
    expect(inWindow(utc(2026, 11, 27, 17, 55))).toBe(true); // 12:55 EST on the early-close day
    expect(inWindow(utc(2026, 11, 27, 17, 56))).toBe(false);
  });
  it("a window set in the settings is the one used", () => {
    const narrow = make({ ...config, hoursStart: "10:00", hoursEnd: "11:00" });
    const hours = hoursFor(narrow, "NDX");
    expect(isWithinTradingHours(utc(2026, 10, 6, 14, 0), hours)).toBe(true);
    expect(isWithinTradingHours(utc(2026, 10, 6, 15, 1), hours)).toBe(false);
    expect(isWithinTradingHours(utc(2026, 10, 6, 13, 59), hours)).toBe(false);
  });
});

describe("the executor itself: nothing is sent to Deriv outside the window", () => {
  it("an open outside the window sends NOTHING - no sign-in, no connection, no proposal - and says why, in the log and in the error", async () => {
    nowMs = utc(2026, 10, 6, 13, 30); // 9:30am
    const err = await make().placeOpenOrder(openReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TradingWindowError);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect((err as Error).message).toBe("Skipped: outside trading window (9:35am - 3:55pm New York time, Monday to Friday): the open was not sent to Deriv.");
    expect(logs.join("\n")).toMatch(/\[deriv\] Skipped: outside trading window/);
    nothingSent();
  });

  it("a scheduled (not manual) close outside the window sends nothing either", async () => {
    nowMs = utc(2026, 10, 6, 20, 5); // 4:05pm
    const err = await make().placeCloseOrder(held("deriv-buy-987654321")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TradingWindowError);
    expect((err as Error).message).toMatch(/the close was not sent to Deriv/);
    nothingSent();
  });

  it("a person's own Close position is the one exception: a position is never left unable to close", async () => {
    const { ref } = await make().placeOpenOrder(openReq());
    nowMs = utc(2026, 10, 6, 21, 30); // 5:30pm
    deriv.sent.length = 0;
    const out = await make().placeCloseOrder(held(ref), { manual: true });
    expect(out.ref).toBe("deriv-sell-987654321");
    expect(deriv.calls("sell")).toHaveLength(1);
  });

  it("reads are not orders: a price, a proposal and an order's status work at any hour", async () => {
    const { ref } = await make().placeOpenOrder(openReq());
    nowMs = utc(2026, 10, 10, 3, 0); // Friday night / Saturday
    expect((await make().getUnderlyingQuote("NDX"))?.price).toBe(29284.55);
    expect((await make().getOrder(ref)).status).toBe("filled");
    expect((await make().getProposal("short_put_spread")).askPrice).toBe(10);
  });

  it("a scheduled close on the last minute of the window still goes through (an open then is held to the earlier last buy time instead)", async () => {
    const { ref } = await make().placeOpenOrder(openReq());
    nowMs = utc(2026, 10, 6, 19, 55, 59);
    expect((await make().placeCloseOrder(held(ref))).ref).toBe("deriv-sell-987654321");
    deriv = new FakeDeriv();
    await expect(make().placeOpenOrder(openReq())).rejects.toThrow(/after last buy time/);
  });
});

describe("the engine skips a signal outside the window and logs it", () => {
  const alert = (direction: "bullish" | "bearish", barTime: string, at: number, test = false) =>
    receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 29_284.55, barTime, interval: "5", raw: { symbol: "NDX", ...(test ? { test: true } : {}) }, now: at });
  const run = (direction: "bullish" | "bearish", barTime: string, at: number, test = false) => {
    nowMs = at;
    return processSignal(alert(direction, barTime, at, test), { executor: make(), now: at, ...fast });
  };

  beforeEach(() => ensureBotRecord(NDX_BOT_ID));

  it("an alert at 4:30pm is skipped as 'outside trading window': nothing reaches Deriv, no position, no flag", async () => {
    await run("bullish", "b1", utc(2026, 10, 6, 20, 30));
    const d = decisionsStore.all().find((x) => x.outcome === "outside_hours");
    expect(d?.reason).toBe("Skipped: outside trading window (9:35am - 3:55pm New York time, Monday to Friday). Nothing was sent to the broker.");
    nothingSent();
    expect(positionsStore.all()).toHaveLength(0);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(false);
  });

  it("before 9:35 and on a Saturday too", async () => {
    await run("bullish", "b1", utc(2026, 10, 6, 13, 34));
    await run("bearish", "b2", utc(2026, 10, 10, 15, 0));
    expect(decisionsStore.all().filter((x) => x.outcome === "outside_hours")).toHaveLength(2);
    nothingSent();
  });

  it("inside the window the same alert opens", async () => {
    await run("bullish", "b1", utc(2026, 10, 6, 14, 40));
    expect(decisionsStore.all().map((x) => x.outcome)).toEqual(["opened"]);
    expect(deriv.calls("buy")).toHaveLength(1);
  });

  it("the Deriv window wins over wider hours set on the bot", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_HOURS_START", "00:00");
    vi.stubEnv("BOT_NDX_EMA_BIAS_HOURS_END", "23:59");
    await run("bullish", "b1", utc(2026, 10, 6, 20, 30));
    expect(decisionsStore.all().map((x) => x.outcome)).toEqual(["outside_hours"]);
    nothingSent();
  });

  it("a test alert does not skip the window for Deriv, even in testing mode", async () => {
    vi.stubEnv("AUTOMATION_TEST_MODE", "true");
    await run("bullish", "b1", utc(2026, 10, 6, 20, 30), true);
    expect(decisionsStore.all().map((x) => x.outcome)).toEqual(["outside_hours"]);
    nothingSent();
  });

  it("a flip outside the window leaves the held position alone: no sell, no buy", async () => {
    await run("bullish", "b1", utc(2026, 10, 6, 14, 40));
    deriv.sent.length = 0;
    deriv.restCalls.length = 0;
    await run("bearish", "b2", utc(2026, 10, 6, 20, 10));
    expect(deriv.calls("sell")).toHaveLength(0);
    expect(deriv.calls("buy")).toHaveLength(0);
    expect(positionsStore.all().map((p) => p.status)).toEqual(["open"]);
  });

  it("another underlying behind the router keeps the ordinary hours: only NDX is held to Deriv's window", async () => {
    const routed = new RoutedExecutor(make(), new MockExecutor(), ["NDX"]);
    expect(routed.tradingWindowFor?.("SPX")).toBeNull();
  });
});

describe("scheduled closes: an exit order is only sent inside the window", () => {
  const exitPosition = () =>
    positionsStore.insert(buildPosition({ id: "pos-x", botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", requestedQuantity: 1, filledQuantity: 1, credit: 0.1, brokerOrderRef: "deriv-buy-987654321", expiry: "2026-10-06", exitOptions: { expirationMinutes: 30 }, manual: false }));
  const seed = async () => {
    await make().placeOpenOrder(openReq());
    deriv.sent.length = 0;
    deriv.restCalls.length = 0;
    deriv.opened.length = 0;
  };
  beforeEach(() => ensureBotRecord(NDX_BOT_ID));

  it("an exit option that is met inside the window closes the contract", async () => {
    await seed();
    exitPosition();
    nowMs = utc(2026, 10, 6, 19, 30); // 3:30pm: 30 minutes before the close
    const r = await runExitChecks(NDX_BOT_ID, nowMs, { executor: make(), ...fast });
    expect(r.closed).toBe(1);
    expect(deriv.calls("sell")).toHaveLength(1);
  });

  it("at 3:57pm, inside the ordinary exit hours (to 3:59) but past Deriv's window, it is skipped and Deriv is not called", async () => {
    await seed();
    exitPosition();
    nowMs = utc(2026, 10, 6, 19, 57);
    const r = await runExitChecks(NDX_BOT_ID, nowMs, { executor: make(), ...fast });
    expect(r.skipped).toBe("outside_hours");
    nothingSent();
  });
});

describe("the end-of-day close fires inside the window, at or before 3:55pm", () => {
  beforeEach(() => ensureBotRecord(NDX_BOT_ID));
  const heldContract = async () => {
    const { ref } = await make().placeOpenOrder(openReq());
    positionsStore.insert(buildPosition({ id: "pos-eod", botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", requestedQuantity: 1, filledQuantity: 1, credit: 0.1, brokerOrderRef: ref, expiry: "2026-10-06" }));
    deriv.sent.length = 0;
    deriv.restCalls.length = 0;
    deriv.opened.length = 0;
  };

  it("a Deriv-backed bot is swept one minute before its window ends (15:54), not at the usual 16:05", () => {
    const ex = new RoutedExecutor(make(), new MockExecutor(), ["NDX"]);
    expect(sweepMinutesFor(NDX_BOT_ID, ex, utc(2026, 10, 6, 14, 0))).toBe(15 * 60 + 54);
    expect(sweepMinutesFor(NDX_BOT_ID, ex, utc(2026, 12, 8, 15, 0))).toBe(15 * 60 + 54); // winter too
    expect(sweepMinutesFor(NDX_BOT_ID)).toBeGreaterThan(15 * 60 + 55); // without Deriv: the bot's own time, after the close, unchanged
  });

  it("on an early-close day it is swept a minute before that day's end (12:54)", () => {
    const ex = new RoutedExecutor(make(), new MockExecutor(), ["NDX"]);
    expect(sweepMinutesFor(NDX_BOT_ID, ex, utc(2026, 11, 27, 16, 0))).toBe(12 * 60 + 54);
  });

  it("a window changed in the settings moves the sweep with it, and an earlier sweep time of the bot's own still wins", () => {
    const early = make({ ...config, hoursEnd: "15:00" });
    expect(sweepMinutesFor(NDX_BOT_ID, early, utc(2026, 10, 6, 14, 0))).toBe(14 * 60 + 59);
    vi.stubEnv("BOT_NDX_EMA_BIAS_EOD_SWEEP_TIME", "15:30");
    expect(sweepMinutesFor(NDX_BOT_ID, make(), utc(2026, 10, 6, 14, 0))).toBe(15 * 60 + 30);
  });

  it("the sweep always SELLS for Deriv, whatever the bot's sweep mode says (estimate would leave the contract open at Deriv)", () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_EOD_SWEEP_MODE", "estimate");
    expect(sweepModeFor(NDX_BOT_ID)).toBe("estimate");
    expect(sweepModeFor(NDX_BOT_ID, make())).toBe("market");
  });

  it("at 15:54 the due sweep sells the held contract", async () => {
    await heldContract();
    nowMs = utc(2026, 10, 6, 19, 54, 20); // 3:54:20pm
    const swept = await runDueSweeps(nowMs, { executor: make(), ...fast });
    expect(swept).toContain(NDX_BOT_ID);
    expect(deriv.calls("sell")).toHaveLength(1);
    expect(positionsStore.get("pos-eod")?.status).toBe("closed");
  });

  it("at 15:50 it is not due yet", async () => {
    await heldContract();
    nowMs = utc(2026, 10, 7, 19, 50);
    expect(await runDueSweeps(nowMs, { executor: make(), ...fast })).not.toContain(NDX_BOT_ID);
    expect(deriv.calls("sell")).toHaveLength(0);
  });

  it("a sweep that only gets to run after the window (the app was down) sends NOTHING, flags the bot, and says the position is still held", async () => {
    await heldContract();
    nowMs = utc(2026, 10, 8, 20, 30); // 4:30pm
    const r = await sweepBot(NDX_BOT_ID, nowMs, { executor: make(), ...fast });
    expect(r).toMatchObject({ mode: "market", failed: 1, closedAtMarket: 0 });
    nothingSent();
    expect(positionsStore.get("pos-eod")?.status).toBe("open");
    const bot = botsStore.get(NDX_BOT_ID);
    expect(bot?.needsAttention).toBe(true);
    expect(bot?.needsAttentionReason).toMatch(/skipped, outside trading window \(9:35am - 3:55pm New York time\)\. Nothing was sent to the broker, so the open position is still held: close it by hand\./);
    expect(decisionsStore.all().some((d) => d.outcome === "outside_hours")).toBe(true);
  });
});
