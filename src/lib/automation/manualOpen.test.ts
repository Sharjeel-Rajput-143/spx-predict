import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withBotLock } from "./botLock";
import { BTC_BOT_ID, ensureBotRecord } from "./bots";
import { BybitExecutor, type BybitConfig } from "./bybitExecutor";
import { LiveBybitExecutor } from "./bybitLive";
import { LIVE_API_BASE, LIVE_BOT_ID } from "./bybitLiveLimits";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { buildBybitView } from "./bybitView";
import { logDecision } from "./decisions";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { runEntryRetry } from "./entryRetry";
import { MockExecutor } from "./executor";
import { __resetLastCheck, type LiveControlDeps } from "./liveControl";
import { appLiveGuard, syncLiveBot } from "./liveGuard";
import { openByHand, type ManualOpenDeps } from "./manualOpen";
import { __resetLiveSettings, enableLive, readLiveSettings } from "./liveSettings";
import { PerBotExecutor } from "./perBotExecutor";
import { RoutedExecutor } from "./routedExecutor";
import { countTodayNewPositions } from "./safeguards";
import { MOCK_PRICING_SIMULATED, executorKind, sharedExecutor } from "./sharedExecutor";
import { botsStore, decisionsStore, positionsStore, signalsStore } from "./store";
import { BASE_NOW, resetAutomationStores, setNdxTestEnv } from "./testSupport";

// THE OPEN UP / OPEN DOWN BUTTONS, through the real engine and the real router, with a fake demo exchange and a fake real one. No network, no key.

setNdxTestEnv();
const base: Omit<BybitConfig, "apiBase"> = { apiKey: API_KEY, apiSecret: API_SECRET, symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0.3, breakevenLockPercent: 0.12, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000 };
const g = globalThis as typeof globalThis & { __automationExecutor?: unknown; __liveBybit?: { executor: LiveBybitExecutor | null; error: string | null } };
let demoFake: FakeBybit;
let liveFake: FakeBybit;
let demo: BybitExecutor;
let live: LiveBybitExecutor;
let price: number | null;

const liveDeps = (over: Partial<LiveControlDeps> = {}): LiveControlDeps => ({ executor: () => g.__liveBybit?.executor ?? null, problem: () => g.__liveBybit?.error ?? null, gate: () => ({ ok: false, why: "gate not passed" }), now: () => Date.now(), ...over });
const deps = (over: Partial<ManualOpenDeps> = {}): ManualOpenDeps => ({ executor: sharedExecutor, price: async () => price, now: () => Date.now(), live: liveDeps(), ...over });
const opens = (f: FakeBybit) => f.created.filter((c) => c.params.reduceOnly !== true);
const turnLiveOn = () => {
  expect(enableLive({ confirmed: true, preflightOk: true, gate: { ok: true, why: "" }, keyPresent: true })).toEqual({ ok: true });
  syncLiveBot(true);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_NOW);
  resetAutomationStores();
  setNdxTestEnv();
  __resetLiveSettings();
  __resetLastCheck();
  (globalThis as { __liveBootedApp?: boolean }).__liveBootedApp = true;
  price = 76_000;
  demoFake = new FakeBybit();
  liveFake = new FakeBybit();
  demoFake.clock = () => Date.now();
  liveFake.clock = () => Date.now();
  demo = new BybitExecutor({ ...base, apiBase: "https://api-demo.bybit.com" }, demoFake.fetch, () => undefined, () => Date.now());
  demo.sleep = async () => undefined;
  live = new LiveBybitExecutor({ ...base, apiBase: LIVE_API_BASE, dailyMaxLossUsd: 3 }, appLiveGuard, liveFake.fetch, () => undefined, () => Date.now());
  live.sleep = async () => undefined;
  g.__automationExecutor = { key: `${executorKind()}:${MOCK_PRICING_SIMULATED}`, executor: new PerBotExecutor(new RoutedExecutor(demo, new MockExecutor(), ["BTC"]), () => live) };
  g.__liveBybit = { executor: live, error: null };
  ensureBotRecord(BTC_BOT_ID);
  ensureBotRecord(LIVE_BOT_ID);
});
afterEach(() => vi.useRealTimers());

describe("the DEMO page: Open UP and Open DOWN open a trade at once", () => {
  it("UP opens a long on the demo account with no confirm, the stop loss and take profit set at Bybit, and says so", async () => {
    const r = await openByHand(BTC_BOT_ID, "up", {}, deps());
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/long/) });
    expect(opens(demoFake)).toHaveLength(1);
    expect(opens(demoFake)[0].params).toMatchObject({ side: "Buy", qty: "0.001", tpslMode: "Full" });
    expect(Number(opens(demoFake)[0].params.stopLoss)).toBeGreaterThan(0);
    expect(Number(opens(demoFake)[0].params.takeProfit)).toBeGreaterThan(0);
    expect(demoFake.position.stopLoss).toBeGreaterThan(0); // confirmed by the unchanged executor
  });
  it("DOWN opens a short with its own stop above the entry", async () => {
    const r = await openByHand(BTC_BOT_ID, "down", {}, deps());
    expect(r.ok).toBe(true);
    expect(opens(demoFake)[0].params.side).toBe("Sell");
    expect(demoFake.position.size).toBeLessThan(0);
    expect(demoFake.position.stopLoss).toBeGreaterThan(demoFake.position.avg);
  });
  it("is labelled Manual: the signal is marked, the open trade in the Bybit view says manual, and a signal-made trade does not", async () => {
    await openByHand(BTC_BOT_ID, "up", {}, deps());
    const sig = signalsStore.query((s) => s.botId === BTC_BOT_ID)[0];
    expect(sig.raw).toMatchObject({ source: "manual", manualOpen: true });
    const v = await buildBybitView(demo, BTC_BOT_ID, "BTCUSDT", Date.now());
    expect(v.open?.manual).toBe(true);
  });
  it("the HISTORY says Manual for the trade the button opened (once it has closed), and not for the signal trade that came after it", async () => {
    await openByHand(BTC_BOT_ID, "up", {}, deps());
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const flip = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: "bearish", price: 76_000, barTime: "t-flip", interval: "5", raw: { origin: "tradingview", symbol: "BTC" }, now: Date.now() });
    await withBotLock(BTC_BOT_ID, () => processSignal(flip, { executor: sharedExecutor, now: Date.now() }));
    const v = await buildBybitView(demo, BTC_BOT_ID, "BTCUSDT", Date.now());
    expect(v.history).toHaveLength(1);
    expect(v.history[0]).toMatchObject({ side: "Long", byBot: true, manual: true, closedBy: "signal_flip" });
    expect(v.open).toMatchObject({ side: "Short", manual: false });
  });
  it("counts in the trades-a-day number like a signal trade", async () => {
    expect(countTodayNewPositions(BTC_BOT_ID, Date.now())).toBe(0);
    await openByHand(BTC_BOT_ID, "up", {}, deps());
    expect(countTodayNewPositions(BTC_BOT_ID, Date.now())).toBe(1);
  });
  it("only while no trade is running: a second click is refused in words, and nothing more is sent", async () => {
    await openByHand(BTC_BOT_ID, "up", {}, deps());
    const r = await openByHand(BTC_BOT_ID, "down", {}, deps());
    expect(r).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/A trade is already running/) });
    expect(opens(demoFake)).toHaveLength(1);
  });
  it("is never copied to the live bot: the live account and the live bot's records are untouched, even with live trading ON", async () => {
    turnLiveOn();
    liveFake.calls.length = 0;
    await openByHand(BTC_BOT_ID, "up", {}, deps());
    expect(opens(demoFake)).toHaveLength(1);
    expect(opens(liveFake)).toHaveLength(0);
    expect(liveFake.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(signalsStore.query((s) => s.botId === LIVE_BOT_ID)).toHaveLength(0);
    expect(positionsStore.query((p) => p.botId === LIVE_BOT_ID)).toHaveLength(0);
  });
  it("a refusal is a sentence: kill switch, bot off, no price, a bad direction", async () => {
    botsStore.update(BTC_BOT_ID, { killSwitch: true });
    expect(await openByHand(BTC_BOT_ID, "up", {}, deps())).toMatchObject({ ok: false, error: expect.stringMatching(/kill switch is on/) });
    botsStore.update(BTC_BOT_ID, { killSwitch: false, enabled: false });
    const off = await openByHand(BTC_BOT_ID, "up", {}, deps());
    expect(off).toMatchObject({ ok: false, error: expect.stringMatching(/^Nothing was opened: /) });
    expect(opens(demoFake)).toHaveLength(0);
    botsStore.update(BTC_BOT_ID, { enabled: true });
    price = null;
    expect(await openByHand(BTC_BOT_ID, "up", {}, deps())).toMatchObject({ ok: false, error: expect.stringMatching(/no live BTC price/) });
    price = 76_000;
    expect(await openByHand(BTC_BOT_ID, "sideways", {}, deps())).toMatchObject({ ok: false, status: 400 });
    expect(opens(demoFake)).toHaveLength(0);
  });
  it("the daily loss limit is honoured: once tripped, a manual open is refused with the reason", async () => {
    const { tripDailyLimit } = await import("./bybitDay");
    tripDailyLimit(BTC_BOT_ID, Date.now(), "test");
    const r = await openByHand(BTC_BOT_ID, "up", {}, deps());
    expect(r.ok).toBe(false);
    expect(opens(demoFake)).toHaveLength(0);
    expect(!r.ok && r.error).toMatch(/loss limit|daily/i);
  });
  it("the engine's 'identical signal within 2 minutes' rule applies to a manual open too, and the refusal says so", async () => {
    expect((await openByHand(BTC_BOT_ID, "up", {}, deps())).ok).toBe(true);
    demoFake.position = { size: 0, avg: 0, stopLoss: 0, takeProfit: 0 };
    for (const p of positionsStore.query((q) => q.botId === BTC_BOT_ID && q.status === "open")) positionsStore.update(p.id, { status: "closed", closedAt: Date.now() });
    const again = await openByHand(BTC_BOT_ID, "up", {}, deps());
    expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/Identical signal received within 120s/) });
    vi.setSystemTime(Date.now() + 3 * 60_000);
    expect((await openByHand(BTC_BOT_ID, "up", {}, deps())).ok).toBe(true);
  });
  it("only the BTC bots have the buttons", async () => {
    expect(await openByHand("ndx_ema_bias", "up", {}, deps())).toMatchObject({ ok: false, status: 404 });
  });
});

describe("the LIVE page: the same, with the one 'Are you sure? real money' click and the live rules", () => {
  it("without the confirm: refused before anything is asked of Bybit", async () => {
    turnLiveOn();
    liveFake.calls.length = 0;
    for (const confirmed of [undefined, false, "true", 1, "LIVE"]) {
      expect(await openByHand(LIVE_BOT_ID, "up", { confirmed }, deps()), String(confirmed)).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/Confirm that real money/) });
    }
    expect(liveFake.calls).toHaveLength(0);
    expect(opens(liveFake)).toHaveLength(0);
  });
  it("with live trading OFF: refused in words, nothing sent", async () => {
    liveFake.calls.length = 0;
    const r = await openByHand(LIVE_BOT_ID, "up", { confirmed: true }, deps());
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Live trading is OFF/) });
    expect(liveFake.calls).toHaveLength(0);
    expect(readLiveSettings().enabled).toBe(false);
  });
  it("with the toggle ON, the confirm and a passing account check: opens a LIVE long with its stop and take profit, 0.001 BTC, on the live account only", async () => {
    turnLiveOn();
    const r = await openByHand(LIVE_BOT_ID, "up", { confirmed: true }, deps());
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/live account/) });
    expect(opens(liveFake)).toHaveLength(1);
    expect(opens(liveFake)[0].params).toMatchObject({ side: "Buy", qty: "0.001", tpslMode: "Full" });
    expect(Number(opens(liveFake)[0].params.stopLoss)).toBeGreaterThan(0);
    expect(opens(demoFake)).toHaveLength(0);
    expect(positionsStore.query((p) => p.botId === LIVE_BOT_ID && p.status === "open")).toHaveLength(1);
    expect(positionsStore.query((p) => p.botId === BTC_BOT_ID)).toHaveLength(0);
    expect(liveFake.account.marginMode).toBe("ISOLATED_MARGIN"); // the account check ran
  });
  it("a failing account check refuses it in words, and nothing is opened", async () => {
    turnLiveOn();
    liveFake.keyInfo.permissions.Wallet = ["Withdraw"];
    const r = await openByHand(LIVE_BOT_ID, "down", { confirmed: true }, deps());
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/move money/) });
    expect(opens(liveFake)).toHaveLength(0);
  });
  it("no live key: refused in words", async () => {
    turnLiveOn();
    g.__liveBybit = { executor: null, error: "no live key" };
    const r = await openByHand(LIVE_BOT_ID, "up", { confirmed: true }, deps());
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/no live key/) });
  });
  it("the kill switch, a running trade and the live executor's own rules still apply", async () => {
    turnLiveOn();
    botsStore.update(LIVE_BOT_ID, { killSwitch: true });
    expect(await openByHand(LIVE_BOT_ID, "up", { confirmed: true }, deps())).toMatchObject({ ok: false, error: expect.stringMatching(/kill switch/) });
    botsStore.update(LIVE_BOT_ID, { killSwitch: false });
    expect((await openByHand(LIVE_BOT_ID, "up", { confirmed: true }, deps())).ok).toBe(true);
    expect(await openByHand(LIVE_BOT_ID, "down", { confirmed: true }, deps())).toMatchObject({ ok: false, error: expect.stringMatching(/already running/) });
    expect(opens(liveFake)).toHaveLength(1);
  });
  it("is never copied to the demo bot", async () => {
    turnLiveOn();
    demoFake.calls.length = 0;
    await openByHand(LIVE_BOT_ID, "up", { confirmed: true }, deps());
    expect(demoFake.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(signalsStore.query((s) => s.botId === BTC_BOT_ID)).toHaveLength(0);
  });
  it("counts in the live trades-a-day ceiling like a signal trade: the day's ceiling stops further manual opens, with the reason in words", async () => {
    turnLiveOn();
    // KNOWN, reported to the owner and NOT changed here (a limit): the position record of the trade being opened is saved before the executor counts, so it counts itself,
    // and the live ceiling of 5 stops the 5th attempt of a day. The test pins what the code does today.
    for (let i = 0; i < 4; i++) {
      const r = await openByHand(LIVE_BOT_ID, i % 2 === 0 ? "up" : "down", { confirmed: true }, deps());
      expect(r.ok, `open ${i + 1}: ${JSON.stringify(r)}`).toBe(true);
      vi.setSystemTime(Date.now() + 3 * 60_000); // the engine refuses an identical signal within 2 minutes (the same rule as for a signal trade)
      liveFake.position = { size: 0, avg: 0, stopLoss: 0, takeProfit: 0 };
      for (const p of positionsStore.query((q) => q.botId === LIVE_BOT_ID && q.status === "open")) positionsStore.update(p.id, { status: "closed", closedAt: Date.now() });
    }
    const next = await openByHand(LIVE_BOT_ID, "up", { confirmed: true }, deps());
    expect(next).toMatchObject({ ok: false, error: expect.stringMatching(/5 live trades have already been opened today/) });
    expect(opens(liveFake)).toHaveLength(4);
  });
});

describe("no entry retry, no chain: a manual open is asked for once", () => {
  it("a manual open that the order step rejected is never retried", async () => {
    const sig = signalsStore.insert({ id: "sig-manual-1", botId: BTC_BOT_ID, signal: "bullish", barTime: "manual-1", price: 76_000, interval: "manual", receivedAt: Date.now(), status: "accepted", raw: { source: "manual", manualOpen: true, symbol: "BTC" } });
    logDecision({ signalId: sig.id, botId: BTC_BOT_ID, outcome: "open_rejected", reason: "Bybit refused the order", detail: {}, now: Date.now() });
    const r = await runEntryRetry(BTC_BOT_ID, Date.now() + 5 * 60_000, { executor: sharedExecutor, price: async () => 76_000 });
    expect(r.retried).toBe(false);
    expect(signalsStore.query((s) => s.botId === BTC_BOT_ID && (s.raw as { origin?: string } | null)?.origin === "retry")).toHaveLength(0);
    expect(decisionsStore.query((d) => d.outcome === "entry_retry")).toHaveLength(0);
  });
  it("the same rejection on a real alert IS retried (so the check above is not vacuous)", async () => {
    const sig = signalsStore.insert({ id: "sig-alert-1", botId: BTC_BOT_ID, signal: "bullish", barTime: "bar-1", price: 76_000, interval: "", receivedAt: Date.now(), status: "accepted", raw: { origin: "tradingview", webhook: "BullishBTC" } });
    logDecision({ signalId: sig.id, botId: BTC_BOT_ID, outcome: "open_rejected", reason: "Bybit refused the order", detail: {}, now: Date.now() });
    const r = await runEntryRetry(BTC_BOT_ID, Date.now() + 5 * 60_000, { executor: sharedExecutor, price: async () => 76_000 });
    expect(r.retried).toBe(true);
  });
});

describe("the Bybit view carries each bot's OWN pullback rule", () => {
  it("demo: the rule in force ($0.03 fall, $0.12 minimum peak by default); a saved value is shown as saved; live: its own values, never the demo's", async () => {
    const v = await buildBybitView(demo, BTC_BOT_ID, "BTCUSDT", Date.now());
    expect(v.pullback).toEqual({ enabled: true, fallUsd: 0.03, minPeakUsd: 0.12 });
    botsStore.update(BTC_BOT_ID, { pullback: { minPeakUsd: 0 } });
    expect((await buildBybitView(demo, BTC_BOT_ID, "BTCUSDT", Date.now())).pullback).toMatchObject({ minPeakUsd: 0 });
    botsStore.update(BTC_BOT_ID, { pullback: { enabled: false } });
    expect((await buildBybitView(demo, BTC_BOT_ID, "BTCUSDT", Date.now())).pullback).toMatchObject({ enabled: false });
    expect((await buildBybitView(live, LIVE_BOT_ID, "BTCUSDT", Date.now())).pullback).toEqual({ enabled: true, fallUsd: 0.03, minPeakUsd: 0.12 }); // the demo's saved values changed nothing here
    botsStore.update(LIVE_BOT_ID, { pullback: { minPeakUsd: 0.5 } });
    expect((await buildBybitView(live, LIVE_BOT_ID, "BTCUSDT", Date.now())).pullback).toMatchObject({ minPeakUsd: 0.5 });
    expect((await buildBybitView(demo, BTC_BOT_ID, "BTCUSDT", Date.now())).pullback).toMatchObject({ enabled: false }); // and the live bot's saved value changed nothing on the demo side
  });
});
