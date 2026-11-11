import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BTC_BOT_ID, ensureBotRecord } from "./bots";
import { BybitExecutor, type BybitConfig } from "./bybitExecutor";
import { LiveBybitExecutor } from "./bybitLive";
import { LIVE_API_BASE, LIVE_BOT_ID } from "./bybitLiveLimits";
import { __resetLiveWatchdogForTests, hasRecordedLivePosition, liveRiskTick, liveWatchdogTick } from "./bybitLiveWatchdog";
import { tripDailyLimit } from "./bybitDay";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { btcBotIds, hasRecordedBybitPosition } from "./bybitWatchdog";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { riskTick } from "./eodSweep";
import { MockExecutor } from "./executor";
import { appLiveGuard, liveAutoOff, syncLiveBot } from "./liveGuard";
import { __resetLiveSettings, enableLive, readLiveSettings, updateLiveSettings } from "./liveSettings";
import { PerBotExecutor } from "./perBotExecutor";
import { RoutedExecutor } from "./routedExecutor";
import { MOCK_PRICING_SIMULATED, executorKind } from "./sharedExecutor";
import { botsStore, decisionsStore, positionsStore } from "./store";
import { BASE_NOW, resetAutomationStores, setNdxTestEnv } from "./testSupport";

// BOTH ACCOUNTS AT ONCE: a fake Bybit demo exchange and a fake REAL Bybit exchange behind the real router, the real live settings, the real engine and the real watchdogs.
// The question in every test: did each bot's orders reach only its own account?

setNdxTestEnv();
const fast = { closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 };
const base: Omit<BybitConfig, "apiBase"> = { apiKey: API_KEY, apiSecret: API_SECRET, symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000 };

let demoFake: FakeBybit;
let liveFake: FakeBybit;
let live: LiveBybitExecutor;
let router: PerBotExecutor;
let nowMs = BASE_NOW;
let seq = 0;
let firstCall: { demo: number; live: number };
const g = globalThis as typeof globalThis & { __automationExecutor?: unknown; __liveBybit?: unknown };

const wrap = (fake: FakeBybit, side: "demo" | "live") => {
  const real = fake.fetch;
  fake.fetch = async (url, init) => {
    firstCall[side] ||= ++seq;
    return real(url, init);
  };
};
const onlyWatching = (f: FakeBybit) => f.calls.every((c) => c.method === "GET" && c.path === "/v5/position/list");
const orders = (f: FakeBybit) => f.created.map((c) => [c.params.side, c.params.reduceOnly === true ? "reduce" : "open", c.params.qty]);
const alert = (botId: string, direction: "bullish" | "bearish", barTime: string) => receiveAndSaveSignal({ botId, signal: direction, price: 76_000, barTime, interval: "5", raw: { symbol: "BTC" }, now: nowMs });
const send = (botId: string, direction: "bullish" | "bearish", barTime: string) => processSignal(alert(botId, direction, barTime), { executor: router, now: nowMs, ...fast });
const turnLiveOn = () => {
  const r = enableLive({ confirmed: true, preflightOk: true, gate: { ok: true, why: "" }, keyPresent: true });
  expect(r).toEqual({ ok: true });
  syncLiveBot(true);
};
/** What a restart does to the in-memory side only: the file stays as it was. */
const __resetLiveSettingsKeepFile = () => {
  (globalThis as { __liveBooted?: boolean }).__liveBooted = false;
};
const outcomesOf = (botId: string) => decisionsStore.query((d) => d.botId === botId && d.signalId !== null).map((d) => d.outcome);

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  __resetLiveSettings();
  __resetLiveWatchdogForTests();
  (globalThis as { __liveBootedApp?: boolean }).__liveBootedApp = true; // this test "process" has already started; the restart rule has its own test below
  nowMs = BASE_NOW;
  seq = 0;
  firstCall = { demo: 0, live: 0 };
  demoFake = new FakeBybit();
  liveFake = new FakeBybit();
  demoFake.clock = () => nowMs;
  liveFake.clock = () => nowMs;
  wrap(demoFake, "demo");
  wrap(liveFake, "live");
  const demo = new BybitExecutor({ ...base, apiBase: "https://api-demo.bybit.com" }, demoFake.fetch, () => undefined, () => nowMs);
  demo.sleep = async () => undefined;
  live = new LiveBybitExecutor({ ...base, apiBase: LIVE_API_BASE, dailyMaxLossUsd: 3 }, appLiveGuard, liveFake.fetch, () => undefined, () => nowMs);
  live.sleep = async () => undefined;
  router = new PerBotExecutor(new RoutedExecutor(demo, new MockExecutor(), ["BTC"]), () => live);
  // The app's own global executor, so the monitors and watchdogs that use it find the same two accounts.
  g.__automationExecutor = { key: `${executorKind()}:${MOCK_PRICING_SIMULATED}`, executor: router };
  g.__liveBybit = { executor: live, error: null };
  ensureBotRecord(BTC_BOT_ID);
  ensureBotRecord(LIVE_BOT_ID);
});

describe("the live bot's own record", () => {
  it("is born OFF (only the live switch turns it on), has its own account, and its limits are the code's: one position, five a day", async () => {
    const { getBotLimits, getBotStaticConfig } = await import("./bots");
    botsStore.remove?.(LIVE_BOT_ID);
    expect(ensureBotRecord(LIVE_BOT_ID).enabled).toBe(false);
    expect(getBotStaticConfig(LIVE_BOT_ID)).toMatchObject({ accountId: "bybit-live", underlying: "BTC", totalPositionLimit: 1 });
    expect(getBotLimits(LIVE_BOT_ID)).toMatchObject({ dailyNewPositionLimit: 5, totalPositionLimit: 1, maxPositionsPerType: 1 });
    // not even a generous safeguard setting raises them
    botsStore.update(LIVE_BOT_ID, { safeguards: { dailyNewPositionLimit: 50, totalPositionLimit: 9, maxPositionsPerType: 9 } });
    expect(getBotLimits(LIVE_BOT_ID)).toMatchObject({ dailyNewPositionLimit: 5, totalPositionLimit: 1, maxPositionsPerType: 1 });
    expect(getBotLimits(BTC_BOT_ID).dailyNewPositionLimit).toBeGreaterThan(5); // the demo bot keeps its own limits
  });
});

describe("each bot's orders reach only its own account", () => {
  it("the demo bot trades on the demo account; the live account hears nothing", async () => {
    await send(BTC_BOT_ID, "bullish", "d1");
    expect(orders(demoFake)).toEqual([["Buy", "open", "0.001"]]);
    expect(liveFake.calls).toHaveLength(0);
    expect(positionsStore.query((p) => p.botId === BTC_BOT_ID)[0].brokerOrderRef).toMatch(/^bybit-open-/);
  });

  it("the live bot born OFF: a mirrored signal reaches it, sends NOT ONE request to either account and opens nothing", async () => {
    await send(LIVE_BOT_ID, "bullish", "l1");
    expect(liveFake.calls).toHaveLength(0);
    expect(demoFake.calls).toHaveLength(0);
    expect(positionsStore.query((p) => p.botId === LIVE_BOT_ID)).toHaveLength(0);
  });

  it("live switched ON: the live bot trades 0.001 BTC on the LIVE account (isolated margin set first), with a live reference; the demo account hears nothing", async () => {
    turnLiveOn();
    await send(LIVE_BOT_ID, "bullish", "l1");
    expect(orders(liveFake)).toEqual([["Buy", "open", "0.001"]]);
    expect(liveFake.account.marginMode).toBe("ISOLATED_MARGIN");
    expect(liveFake.created[0].params).toMatchObject({ tpslMode: "Full" });
    const [p] = positionsStore.query((x) => x.botId === LIVE_BOT_ID);
    expect(p).toMatchObject({ venue: "bybit", status: "open" });
    expect(p.brokerOrderRef).toMatch(/^bybitlive-open-/);
    expect(demoFake.calls).toHaveLength(0);
  });

  it("a flip on live: the opposite signal closes the long (reduce only) and opens the short, all on the live account", async () => {
    turnLiveOn();
    await send(LIVE_BOT_ID, "bullish", "l1");
    await send(LIVE_BOT_ID, "bearish", "l2");
    expect(orders(liveFake)).toEqual([["Buy", "open", "0.001"], ["Sell", "reduce", "0.001"], ["Sell", "open", "0.001"]]);
    expect(demoFake.calls).toHaveLength(0);
  });

  it("with the switch OFF a live position can still be CLOSED by the opposite signal, and nothing new is opened", async () => {
    turnLiveOn();
    await send(LIVE_BOT_ID, "bullish", "l1");
    expect(orders(liveFake)).toHaveLength(1);
    // the switch goes OFF (an alarm, a person) while the position is held
    const { turnLiveOff } = await import("./liveSettings");
    turnLiveOff("test");
    syncLiveBot(false);
    await send(LIVE_BOT_ID, "bearish", "l2");
    expect(orders(liveFake)).toEqual([["Buy", "open", "0.001"], ["Sell", "reduce", "0.001"]]);
    expect(liveFake.position.size).toBe(0);
    expect(positionsStore.query((p) => p.botId === LIVE_BOT_ID && p.status === "open")).toHaveLength(0);
    expect(demoFake.calls).toHaveLength(0);
  });

  it("a tripped daily cap refuses the entry, turns the switch OFF and the live bot off", async () => {
    turnLiveOn();
    tripDailyLimit(LIVE_BOT_ID, nowMs, "test");
    await send(LIVE_BOT_ID, "bullish", "l1");
    expect(liveFake.created).toHaveLength(0);
    expect(readLiveSettings().enabled).toBe(false);
    expect(readLiveSettings().offReason).toMatch(/daily loss limit/);
    expect(botsStore.get(LIVE_BOT_ID)?.enabled).toBe(false);
  });

  it("a demo executor handed a live reference does not know it", async () => {
    const demoOnly = new BybitExecutor({ ...base, apiBase: "https://api-demo.bybit.com" }, demoFake.fetch, () => undefined, () => nowMs);
    await expect(demoOnly.getOrder("bybitlive-open-1001")).rejects.toThrow();
    expect(demoFake.calls).toHaveLength(0);
  });
});

describe("after a restart", () => {
  it("the first look finds the live switch OFF and the live bot off, whatever they were before", () => {
    turnLiveOn();
    expect(appLiveGuard.switchOn()).toBe(true);
    (globalThis as { __liveBootedApp?: boolean }).__liveBootedApp = false; // a new process
    __resetLiveSettingsKeepFile();
    expect(appLiveGuard.switchOn()).toBe(false);
    // it was ON and nothing tripped: OFF for now, with the saved ON state kept so the auto resume can turn it back on after its own checks (liveControl.test.ts)
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: true, mirrorEnabled: false });
    expect(botsStore.get(LIVE_BOT_ID)?.enabled).toBe(false);
  });
  it("after an alarm there is nothing to resume: the first look after a restart finds it OFF and not waiting", () => {
    turnLiveOn();
    liveAutoOff("STOP LOSS ALARM: test");
    (globalThis as { __liveBootedApp?: boolean }).__liveBootedApp = false;
    __resetLiveSettingsKeepFile();
    expect(appLiveGuard.switchOn()).toBe(false);
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false });
    expect(botsStore.get(LIVE_BOT_ID)?.enabled).toBe(false);
  });
  it("the mirror is OFF after a restart too", () => {
    updateLiveSettings({ mirrorEnabled: true });
    expect(readLiveSettings().mirrorEnabled).toBe(true);
    (globalThis as { __liveBootedApp?: boolean }).__liveBootedApp = false;
    (globalThis as { __liveBooted?: boolean }).__liveBooted = false;
    appLiveGuard.switchOn();
    expect(readLiveSettings().mirrorEnabled).toBe(false);
  });
});

describe("the two watchdogs and risk checks do not cross", () => {
  it("the demo side does not see the live bot or its positions", async () => {
    turnLiveOn();
    await send(LIVE_BOT_ID, "bullish", "l1");
    expect(hasRecordedLivePosition()).toBe(true);
    expect(hasRecordedBybitPosition()).toBe(false); // the live position is not a demo position
    expect(btcBotIds()).toEqual([BTC_BOT_ID]);
  });

  it("a live position that loses its stop: the LIVE watchdog closes it on the LIVE account, rings the LIVE bot's alarm, turns the switch OFF; the demo bot is untouched", async () => {
    turnLiveOn();
    await send(LIVE_BOT_ID, "bullish", "l1");
    liveFake.deleteStop();
    liveFake.tradingStopFails = true;
    for (let i = 0; i < 8 && liveFake.position.size !== 0; i++) {
      nowMs += 1500;
      await liveWatchdogTick(nowMs);
    }
    expect(liveFake.position.size).toBe(0);
    expect(readLiveSettings().enabled).toBe(false);
    expect(readLiveSettings().offReason).toMatch(/STOP LOSS ALARM/);
    expect(botsStore.get(LIVE_BOT_ID)).toMatchObject({ enabled: false, needsAttention: true });
    expect(botsStore.get(LIVE_BOT_ID)?.needsAttentionReason).toMatch(/LIVE STOP LOSS ALARM/);
    expect(decisionsStore.query((d) => d.botId === LIVE_BOT_ID && d.outcome === "executor_error").length).toBeGreaterThan(0);
    // nothing for the demo bot or the demo account
    expect(botsStore.get(BTC_BOT_ID)?.needsAttention).toBeFalsy();
    expect(decisionsStore.query((d) => d.botId === BTC_BOT_ID)).toHaveLength(0);
    expect(demoFake.calls).toHaveLength(0);
  });

  it("without a live key the live watchdog does nothing and asks nobody", async () => {
    g.__liveBybit = { executor: null, error: "no key" };
    expect(await liveWatchdogTick(nowMs)).toBeNull();
    expect(liveFake.calls).toHaveLength(0);
    expect(demoFake.calls).toHaveLength(0);
  });

  it("the live bot's kill switch turns the live switch OFF", async () => {
    turnLiveOn();
    botsStore.update(LIVE_BOT_ID, { killSwitch: true });
    await liveRiskTick(nowMs);
    expect(readLiveSettings().enabled).toBe(false);
    expect(readLiveSettings().offReason).toMatch(/kill switch/);
  });

  it("a day's loss limit reached on the live bot turns the live switch OFF", async () => {
    turnLiveOn();
    tripDailyLimit(LIVE_BOT_ID, nowMs, "test");
    await liveRiskTick(nowMs);
    expect(readLiveSettings().enabled).toBe(false);
  });
});

describe("the DEMO risk check never looks at the live bot", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("with a live position open, the demo risk tick sends nothing to the demo account (it would otherwise compare a live trade with the demo account)", async () => {
    turnLiveOn();
    await send(LIVE_BOT_ID, "bullish", "l1");
    expect(positionsStore.query((p) => p.botId === LIVE_BOT_ID && p.status === "open")).toHaveLength(1);
    // make the app's demo Bybit executor the one behind the router
    vi.stubEnv("BROKER", "bybit");
    vi.stubEnv("BYBIT_DEMO_API_KEY", API_KEY);
    vi.stubEnv("BYBIT_DEMO_API_SECRET", API_SECRET);
    vi.stubEnv("POSITION_SIZE", "0.001");
    vi.stubEnv("STOP_LOSS_PERCENT", "1");
    vi.stubEnv("TAKE_PROFIT_PERCENT", "2");
    vi.stubEnv("DAILY_MAX_LOSS_USD", "10");
    g.__automationExecutor = { key: `${executorKind()}:${MOCK_PRICING_SIMULATED}`, executor: router };
    expect(executorKind()).toBe("bybit");
    const demoCallsBefore = demoFake.calls.length;
    await riskTick(nowMs);
    expect(demoFake.calls.length).toBe(demoCallsBefore);
    expect(positionsStore.query((p) => p.botId === LIVE_BOT_ID && p.status === "open")).toHaveLength(1); // not marked closed because the DEMO account is flat
  });
});

describe("the live bot cannot be given more than the code allows", () => {
  it("the 6th trade of a day is refused even with every setting generous", async () => {
    updateLiveSettings({ dailyLossUsd: 3 });
    turnLiveOn();
    for (let i = 1; i <= 5; i++) {
      await send(LIVE_BOT_ID, i % 2 ? "bullish" : "bearish", `n${i}`);
    }
    const opened = liveFake.created.filter((c) => c.params.reduceOnly !== true).length;
    expect(opened).toBeLessThanOrEqual(5);
    await send(LIVE_BOT_ID, "bullish", "n6");
    expect(liveFake.created.filter((c) => c.params.reduceOnly !== true).length).toBeLessThanOrEqual(5);
  });

  it("the live bot never has more than one position open", async () => {
    turnLiveOn();
    await send(LIVE_BOT_ID, "bullish", "a1");
    await send(LIVE_BOT_ID, "bullish", "a2"); // same direction again: it must not add
    expect(liveFake.position.size).toBe(0.001);
    expect(positionsStore.query((p) => p.botId === LIVE_BOT_ID && p.status === "open")).toHaveLength(1);
  });
});

describe("the order of the two accounts when a signal comes through the mirror", () => {
  it("the demo account is asked before the live one", async () => {
    turnLiveOn();
    await send(BTC_BOT_ID, "bullish", "m1");
    await send(LIVE_BOT_ID, "bullish", "m1-live");
    expect(firstCall.demo).toBeGreaterThan(0);
    expect(firstCall.live).toBeGreaterThan(firstCall.demo);
    expect(outcomesOf(BTC_BOT_ID)).toEqual(["opened"]);
    expect(outcomesOf(LIVE_BOT_ID)).toEqual(["opened"]);
  });
});
