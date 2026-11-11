import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BTC_BOT_ID, ensureBotRecord, updateBot } from "./bots";
import { BybitExecutor, type BybitConfig } from "./bybitExecutor";
import { LiveBybitExecutor } from "./bybitLive";
import { LIVE_API_BASE, LIVE_BOT_ID } from "./bybitLiveLimits";
import { tripDailyLimit } from "./bybitDay";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import { __resetLastCheck, turnSwitchOff } from "./liveControl";
import { appLiveGuard, syncLiveBot } from "./liveGuard";
import { __resetLiveSettings, enableLive } from "./liveSettings";
import { PerBotExecutor } from "./perBotExecutor";
import { __resetPullbackForTests, pullbackSettings, pullbackTick, type PullbackDeps } from "./pullbackExit";
import { RoutedExecutor } from "./routedExecutor";
import { countTodayNewPositions } from "./safeguards";
import { botsStore, decisionsStore, positionsStore } from "./store";
import { BASE_NOW, buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";

/**
 * THE PULLBACK EXIT AND THE CHAIN ON THE LIVE BOT (release 9): the same code and defaults as the demo bot, each bot with its own saved values, its own account, its own peak and its own lock.
 * A fake demo exchange and a fake real one side by side, the real engine, the real router. 0.001 BTC: $0.03 of profit is a $30 move of the price.
 */

setNdxTestEnv();
const cfg: Omit<BybitConfig, "apiBase"> = { apiKey: API_KEY, apiSecret: API_SECRET, symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000 };
const fast = { closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 };
const g = globalThis as typeof globalThis & { __liveBybit?: { executor: LiveBybitExecutor | null; error: string | null } };

let demoFake: FakeBybit;
let liveFake: FakeBybit;
let demo: BybitExecutor;
let live: LiveBybitExecutor;
let executor: PerBotExecutor;
let nowMs = BASE_NOW;
let n = 0;
let liveReader: PullbackDeps["bybit"];

const deps = (): PullbackDeps => ({ bybit: (id) => liveReader(id), executor, price: async () => liveFake.price, closeConfirmTimeoutMs: 1000, pollIntervalMs: 5, process: fast });
const tick = () => pullbackTick(nowMs, deps());
/** An alert for one bot, saved and processed like a TradingView call (the live bot gets its own copy, as the mirror makes it). */
const alert = async (botId: string, direction: "bullish" | "bearish") => {
  nowMs += 5 * 60_000;
  vi.setSystemTime(nowMs);
  const signal = receiveAndSaveSignal({ botId, signal: direction, price: 76_000, barTime: `t-${++n}`, interval: "5", raw: { origin: "tradingview", symbol: "BTC" }, now: nowMs });
  await processSignal(signal, { executor, now: nowMs, ...fast });
  return signal;
};
const turnLiveOn = () => {
  expect(enableLive({ confirmed: true, preflightOk: true, gate: { ok: true, why: "" }, keyPresent: true })).toEqual({ ok: true });
  syncLiveBot(true);
};
const rec = (botId: string) => positionsStore.all().filter((p) => p.botId === botId).sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
const open = (botId: string) => rec(botId).find((p) => p.status === "open");
const reduceOnly = (f: FakeBybit) => f.created.filter((c) => c.params.reduceOnly === true);
const opens = (f: FakeBybit) => f.created.filter((c) => c.params.reduceOnly !== true);
const outcomes = (botId: string) => decisionsStore.all().filter((d) => d.botId === botId).map((d) => d.outcome);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  nowMs = BASE_NOW;
  vi.setSystemTime(nowMs);
  resetAutomationStores();
  setNdxTestEnv();
  __resetLiveSettings();
  __resetLastCheck();
  __resetPullbackForTests();
  (globalThis as { __liveBootedApp?: boolean }).__liveBootedApp = true;
  demoFake = new FakeBybit();
  liveFake = new FakeBybit();
  demoFake.clock = () => nowMs;
  liveFake.clock = () => nowMs;
  demo = new BybitExecutor({ ...cfg, apiBase: "https://api-demo.bybit.com" }, demoFake.fetch, () => undefined, () => nowMs);
  demo.sleep = async () => undefined;
  live = new LiveBybitExecutor({ ...cfg, apiBase: LIVE_API_BASE, dailyMaxLossUsd: 3 }, appLiveGuard, liveFake.fetch, () => undefined, () => nowMs);
  live.sleep = async () => undefined;
  executor = new PerBotExecutor(new RoutedExecutor(demo, new MockExecutor(), ["BTC"]), () => live);
  g.__liveBybit = { executor: live, error: null };
  liveReader = (id) => (id === LIVE_BOT_ID ? live : demo);
  ensureBotRecord(BTC_BOT_ID);
  ensureBotRecord(LIVE_BOT_ID);
  delete process.env.BYBIT_KILL_SWITCH;
});
afterEach(() => vi.useRealTimers());

describe("the LIVE bot's pullback exit: the same rule, on the live account", () => {
  it("closes a live trade with a reduce-only MARKET order on the live account only, once the peak reached the default $0.12 and the profit fell $0.03; the stop loss and take profit were on the entry", async () => {
    turnLiveOn();
    await alert(LIVE_BOT_ID, "bullish");
    const id = open(LIVE_BOT_ID)!.id;
    expect(opens(liveFake)[0].params).toMatchObject({ side: "Buy", qty: "0.001", stopLoss: expect.anything(), takeProfit: expect.anything() });
    liveFake.price = 76_060; // +$0.06
    await tick();
    liveFake.price = 76_030; // +$0.03: below the default minimum peak, nothing happens
    expect(await tick()).toBe(0);
    expect(positionsStore.get(id)?.status).toBe("open");
    expect(positionsStore.get(id)?.peakProfitUsd).toBeCloseTo(0.06, 9);
    liveFake.price = 76_120; // peak +$0.12
    await tick();
    liveFake.price = 76_090; // a fall of exactly $0.03
    expect(await tick()).toBe(1);
    expect(positionsStore.get(id)).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
    expect(reduceOnly(liveFake)).toHaveLength(1);
    expect(reduceOnly(liveFake)[0].params).toMatchObject({ side: "Sell", orderType: "Market", reduceOnly: true });
    expect(liveFake.position.size).toBe(0);
    expect(outcomes(LIVE_BOT_ID)).toContain("pullback_exit");
    // nothing happened on the demo account or to the demo bot
    expect(demoFake.created).toHaveLength(0);
    expect(rec(BTC_BOT_ID)).toHaveLength(0);
  });

  it("works while the live switch is OFF (a held position can always be closed)", async () => {
    turnLiveOn();
    await alert(LIVE_BOT_ID, "bullish");
    const id = open(LIVE_BOT_ID)!.id;
    turnSwitchOff({ now: () => nowMs });
    liveFake.price = 76_120;
    await tick();
    liveFake.price = 76_090;
    expect(await tick()).toBe(1);
    expect(positionsStore.get(id)).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
  });

  it("a short mirrored: the same, on the live account", async () => {
    turnLiveOn();
    await alert(LIVE_BOT_ID, "bearish");
    const id = open(LIVE_BOT_ID)!.id;
    liveFake.price = 75_880;
    await tick();
    liveFake.price = 75_910;
    expect(await tick()).toBe(1);
    expect(positionsStore.get(id)).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
    expect(reduceOnly(liveFake)[0].params.side).toBe("Buy");
  });

  it("switched off for the live bot only: the demo bot still exits, the live trade is left to its stop and take profit", async () => {
    turnLiveOn();
    updateBot(LIVE_BOT_ID, { pullback: { enabled: false } });
    await alert(LIVE_BOT_ID, "bullish");
    await alert(BTC_BOT_ID, "bullish");
    liveFake.price = 76_120;
    demoFake.price = 76_120;
    await tick();
    liveFake.price = 76_090;
    demoFake.price = 76_090;
    expect(await tick()).toBe(1);
    expect(open(LIVE_BOT_ID)).toBeTruthy();
    expect(rec(BTC_BOT_ID)[0]).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
    expect(reduceOnly(liveFake)).toHaveLength(0);
  });
});

describe("the default readers (what the app uses)", () => {
  it("the demo bot is read from the demo account and the live bot from the live account", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.join(__dirname, "pullbackExit.ts"), "utf8");
    expect(src).toContain("bybit: (botId) => (botId === LIVE_BOT_ID ? liveBybitExecutor() : bybitExecutor())");
    expect(src).toContain("[BTC_BOT_ID, LIVE_BOT_ID].map((botId) => tickOne(botId, now, deps))");
  });
});

describe("the two bots are independent: own values, own account, own peak, own lock", () => {
  it("each keeps its own saved minimum peak: with the demo at 0 and the live bot at the default $0.12, the same +$0.06 then +$0.03 closes the demo trade only", async () => {
    turnLiveOn();
    updateBot(BTC_BOT_ID, { pullback: { minPeakUsd: 0 } });
    expect(pullbackSettings(BTC_BOT_ID).minPeakUsd).toBe(0);
    expect(pullbackSettings(LIVE_BOT_ID).minPeakUsd).toBe(0.12);
    await alert(BTC_BOT_ID, "bullish");
    await alert(LIVE_BOT_ID, "bullish");
    for (const f of [demoFake, liveFake]) f.price = 76_060;
    await tick();
    for (const f of [demoFake, liveFake]) f.price = 76_030;
    expect(await tick()).toBe(1);
    expect(rec(BTC_BOT_ID)[0]).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
    expect(open(LIVE_BOT_ID)).toBeTruthy();
    expect(reduceOnly(demoFake)).toHaveLength(1);
    expect(reduceOnly(liveFake)).toHaveLength(0);
  });

  it("each trade is closed on ITS OWN account: both fall by the same amount, each closes only its own", async () => {
    turnLiveOn();
    updateBot(BTC_BOT_ID, { pullback: { minPeakUsd: 0 } });
    updateBot(LIVE_BOT_ID, { pullback: { minPeakUsd: 0 } });
    await alert(BTC_BOT_ID, "bullish");
    await alert(LIVE_BOT_ID, "bullish");
    for (const f of [demoFake, liveFake]) f.price = 76_120;
    await tick();
    for (const f of [demoFake, liveFake]) f.price = 76_090;
    expect(await tick()).toBe(2);
    expect(reduceOnly(demoFake)).toHaveLength(1);
    expect(reduceOnly(liveFake)).toHaveLength(1);
    expect(rec(BTC_BOT_ID)).toHaveLength(1);
    expect(rec(LIVE_BOT_ID)).toHaveLength(1);
    expect(rec(BTC_BOT_ID)[0].peakProfitUsd).toBeCloseTo(0.12, 9);
    expect(rec(LIVE_BOT_ID)[0].peakProfitUsd).toBeCloseTo(0.12, 9);
  });

  it("the peak of one bot's trade is never the other's: a live peak does not move the demo trade's peak", async () => {
    turnLiveOn();
    await alert(BTC_BOT_ID, "bullish");
    await alert(LIVE_BOT_ID, "bullish");
    demoFake.price = 76_010; // demo +$0.01
    liveFake.price = 76_200; // live +$0.20
    await tick();
    expect(rec(BTC_BOT_ID)[0].peakProfitUsd).toBeCloseTo(0.01, 9);
    expect(rec(LIVE_BOT_ID)[0].peakProfitUsd).toBeCloseTo(0.2, 9);
  });

  it("a live bot with no key or a live reader that throws does not stop the demo bot's exit", async () => {
    turnLiveOn();
    updateBot(BTC_BOT_ID, { pullback: { minPeakUsd: 0 } });
    await alert(BTC_BOT_ID, "bullish");
    demoFake.price = 76_120;
    await tick();
    demoFake.price = 76_090;
    liveReader = (id) => (id === LIVE_BOT_ID ? null : demo);
    expect(await tick()).toBe(1);
    expect(rec(BTC_BOT_ID)[0].status).toBe("closed");
    // and a live reader that throws
    await alert(BTC_BOT_ID, "bearish");
    demoFake.price = 75_880;
    await tick();
    demoFake.price = 75_910;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    liveReader = (id) => {
      if (id === LIVE_BOT_ID) throw new Error("live reader broke");
      return demo;
    };
    ensureBotRecord(LIVE_BOT_ID);
    positionsStore.insert(buildPosition({ botId: LIVE_BOT_ID, type: "short_put_spread", status: "open", venue: "bybit", brokerOrderRef: "bybitlive-open-x", openedAt: nowMs, credit: 0.76 }));
    expect(await tick()).toBe(1);
    spy.mockRestore();
    expect(rec(BTC_BOT_ID).filter((p) => p.status === "closed")).toHaveLength(2);
  });

  it("the live bot's settings reach it through its own bot record only: the demo bot's saved chain value does not turn the live chain on", () => {
    updateBot(BTC_BOT_ID, { pullback: { chainEnabled: true } });
    expect(pullbackSettings(LIVE_BOT_ID).chainEnabled).toBe(false);
    updateBot(LIVE_BOT_ID, { pullback: { chainEnabled: true } });
    updateBot(BTC_BOT_ID, { pullback: { chainEnabled: false } });
    expect(pullbackSettings(LIVE_BOT_ID).chainEnabled).toBe(true);
    expect(botsStore.get(BTC_BOT_ID)?.chainState).toBeUndefined();
  });
});

describe("the chain on the LIVE bot: OFF by default, and every live limit still applies to its trades", () => {
  const chainOnLive = () => updateBot(LIVE_BOT_ID, { pullback: { chainEnabled: true, minPeakUsd: 0 } });
  const exitTheFirstTrade = async () => {
    liveFake.price = 76_380;
    await tick();
    liveFake.price = 76_350;
    return tick();
  };

  it("OFF by default: a live pullback exit opens nothing", async () => {
    turnLiveOn();
    updateBot(LIVE_BOT_ID, { pullback: { minPeakUsd: 0 } });
    await alert(LIVE_BOT_ID, "bullish");
    expect(await exitTheFirstTrade()).toBe(1);
    expect(rec(LIVE_BOT_ID)).toHaveLength(1);
    expect(opens(liveFake)).toHaveLength(1);
  });

  it("ON: the opposite live trade opens at once through the live engine, with the executor's stop loss and take profit, and it counts in the day's trades", async () => {
    turnLiveOn();
    chainOnLive();
    await alert(LIVE_BOT_ID, "bullish");
    expect(countTodayNewPositions(LIVE_BOT_ID, nowMs)).toBe(1);
    expect(await exitTheFirstTrade()).toBe(2);
    const chain = open(LIVE_BOT_ID)!;
    expect(chain).toMatchObject({ type: "short_call_spread", chain: { index: 1 } });
    expect(liveFake.position.size).toBeLessThan(0);
    expect(liveFake.position.stopLoss).toBeGreaterThan(0);
    expect(liveFake.position.takeProfit).toBeGreaterThan(0);
    expect(opens(liveFake)).toHaveLength(2);
    expect(opens(liveFake)[1].params).toMatchObject({ side: "Sell", qty: "0.001" });
    expect(countTodayNewPositions(LIVE_BOT_ID, nowMs)).toBe(2); // a chain trade on live USES UP the day's allowance
    expect(outcomes(LIVE_BOT_ID)).toContain("chain_open");
    expect(demoFake.created).toHaveLength(0);
  });

  it("the same chain on the DEMO bot still does not use up its allowance (unchanged)", async () => {
    updateBot(BTC_BOT_ID, { pullback: { chainEnabled: true, minPeakUsd: 0 } });
    await alert(BTC_BOT_ID, "bullish");
    demoFake.price = 76_380;
    await tick();
    demoFake.price = 76_350;
    await tick();
    expect(rec(BTC_BOT_ID)).toHaveLength(2);
    expect(countTodayNewPositions(BTC_BOT_ID, nowMs)).toBe(1);
  });

  it("the live ceiling stops the chain: with 3 live trades already opened today, the chain's would be the 5th and is refused (the ceiling is written in the code)", async () => {
    turnLiveOn();
    chainOnLive();
    for (let i = 0; i < 3; i++) positionsStore.insert(buildPosition({ botId: LIVE_BOT_ID, type: "short_put_spread", status: "closed", venue: "bybit", openedAt: nowMs - (i + 1) * 3600_000, closedAt: nowMs - i * 3600_000, closeReason: "stop_loss" }));
    await alert(LIVE_BOT_ID, "bullish");
    expect(await exitTheFirstTrade()).toBe(1); // only the close
    expect(opens(liveFake)).toHaveLength(1); // no second live order was sent
    expect(open(LIVE_BOT_ID)).toBeUndefined();
    expect(botsStore.get(LIVE_BOT_ID)?.chainState).toBeUndefined();
    expect(outcomes(LIVE_BOT_ID)).toContain("chain_ended");
  });

  it("the daily loss limit stops the chain: nothing opens once it is tripped", async () => {
    turnLiveOn();
    chainOnLive();
    await alert(LIVE_BOT_ID, "bullish");
    tripDailyLimit(LIVE_BOT_ID, nowMs, "test");
    await exitTheFirstTrade();
    expect(opens(liveFake)).toHaveLength(1);
    expect(open(LIVE_BOT_ID)).toBeUndefined();
    expect(outcomes(LIVE_BOT_ID)).toContain("chain_ended");
  });

  it("turning live trading OFF ends the chain: the running trade is still closed by the exit, and no new one opens", async () => {
    turnLiveOn();
    chainOnLive();
    await alert(LIVE_BOT_ID, "bullish");
    turnSwitchOff({ now: () => nowMs });
    expect(await exitTheFirstTrade()).toBe(1);
    expect(opens(liveFake)).toHaveLength(1);
    expect(open(LIVE_BOT_ID)).toBeUndefined();
    expect(decisionsStore.all().filter((d) => d.botId === LIVE_BOT_ID && d.outcome === "chain_ended")[0]?.reason).toMatch(/off/i);
  });

  it("one position at a time: a chain trade is never opened next to another live position", async () => {
    turnLiveOn();
    chainOnLive();
    await alert(LIVE_BOT_ID, "bullish");
    expect(await exitTheFirstTrade()).toBe(2);
    expect(rec(LIVE_BOT_ID).filter((p) => p.status === "open")).toHaveLength(1);
    expect(liveFake.position.size).not.toBe(0);
    expect(Math.abs(liveFake.position.size)).toBeCloseTo(0.001, 9);
  });

  it("the demo bot's chain and the live bot's chain never meet: each chain state lives on its own bot", async () => {
    turnLiveOn();
    chainOnLive();
    updateBot(BTC_BOT_ID, { pullback: { chainEnabled: true, minPeakUsd: 0 } });
    await alert(LIVE_BOT_ID, "bullish");
    await exitTheFirstTrade();
    expect(botsStore.get(LIVE_BOT_ID)?.chainState).toMatchObject({ count: 1 });
    expect(botsStore.get(BTC_BOT_ID)?.chainState).toBeUndefined();
    expect(rec(BTC_BOT_ID)).toHaveLength(0);
  });
});
