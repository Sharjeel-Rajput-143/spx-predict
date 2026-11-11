import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BTC_BOT_ID, ensureBotRecord } from "@/lib/automation/bots";
import { BybitExecutor, type BybitConfig } from "@/lib/automation/bybitExecutor";
import { LiveBybitExecutor } from "@/lib/automation/bybitLive";
import { LIVE_API_BASE, LIVE_BOT_ID } from "@/lib/automation/bybitLiveLimits";
import { API_KEY, API_SECRET, FakeBybit } from "@/lib/automation/bybitTestSupport";
import { MockExecutor } from "@/lib/automation/executor";
import { appLiveGuard, syncLiveBot } from "@/lib/automation/liveGuard";
import { __resetLiveSettings, enableLive, updateLiveSettings } from "@/lib/automation/liveSettings";
import { PerBotExecutor } from "@/lib/automation/perBotExecutor";
import { RoutedExecutor } from "@/lib/automation/routedExecutor";
import { MOCK_PRICING_SIMULATED, executorKind } from "@/lib/automation/sharedExecutor";
import { positionsStore, signalsStore } from "@/lib/automation/store";
import { BASE_NOW, resetAutomationStores, setNdxTestEnv } from "@/lib/automation/testSupport";
import { createWebhook } from "@/lib/automation/webhooks";
import { POST } from "./route";

// THE WHOLE PATH: a TradingView call to the BTC hook, the real route, the real mirror, the real router and the real engine, with a fake demo exchange and a fake real one.

const feed = vi.hoisted(() => ({ tick: null as { t: number; price: number } | null }));
vi.mock("@/lib/marketData/tickStore", () => ({ waitForTick: async () => feed.tick, getLastTick: () => feed.tick, isLiveSymbol: () => false, startTickFeed: () => undefined, stopTickFeed: () => undefined }));

setNdxTestEnv();
const base: Omit<BybitConfig, "apiBase"> = { apiKey: API_KEY, apiSecret: API_SECRET, symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000 };
const g = globalThis as typeof globalThis & { __automationExecutor?: unknown; __liveBybit?: unknown };
let demoFake: FakeBybit;
let liveFake: FakeBybit;
let seq = 0;
const stamp: { demoOrder: number; liveOrder: number } = { demoOrder: 0, liveOrder: 0 };

function track(fake: FakeBybit, key: "demoOrder" | "liveOrder") {
  const real = fake.fetch;
  fake.fetch = async (url, init) => {
    if (init.method === "POST" && url.endsWith("/v5/order/create")) stamp[key] ||= ++seq;
    return real(url, init);
  };
}
async function hook(direction: "bullish" | "bearish") {
  const w = createWebhook({ name: `Hook${direction}`, botId: BTC_BOT_ID, direction });
  const res = await POST(new NextRequest(`http://localhost/api/webhook/hook/${w.token}`, { method: "POST", body: `${direction} alert`, headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token: w.token }) });
  await new Promise((r) => setTimeout(r, 400));
  return res;
}
/** The live watchdog reads the live position (never writes) whenever a live key exists, even with the switch OFF: that read is allowed, anything else is not. */
const onlyWatching = (f: FakeBybit) => f.calls.every((c) => c.method === "GET" && c.path === "/v5/position/list");
const created = (f: FakeBybit) => f.created.filter((c) => c.params.reduceOnly !== true).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_NOW);
  resetAutomationStores();
  setNdxTestEnv();
  __resetLiveSettings();
  (globalThis as { __liveBootedApp?: boolean }).__liveBootedApp = true;
  feed.tick = { t: Date.now(), price: 76_000 };
  seq = 0;
  stamp.demoOrder = 0;
  stamp.liveOrder = 0;
  demoFake = new FakeBybit();
  liveFake = new FakeBybit();
  demoFake.clock = () => Date.now();
  liveFake.clock = () => Date.now();
  track(demoFake, "demoOrder");
  track(liveFake, "liveOrder");
  const demo = new BybitExecutor({ ...base, apiBase: "https://api-demo.bybit.com" }, demoFake.fetch, () => undefined, () => Date.now());
  demo.sleep = async () => undefined;
  const live = new LiveBybitExecutor({ ...base, apiBase: LIVE_API_BASE, dailyMaxLossUsd: 3 }, appLiveGuard, liveFake.fetch, () => undefined, () => Date.now());
  live.sleep = async () => undefined;
  g.__automationExecutor = { key: `${executorKind()}:${MOCK_PRICING_SIMULATED}`, executor: new PerBotExecutor(new RoutedExecutor(demo, new MockExecutor(), ["BTC"]), () => live) };
  g.__liveBybit = { executor: live, error: null };
  ensureBotRecord(BTC_BOT_ID);
  ensureBotRecord(LIVE_BOT_ID);
});
afterEach(() => vi.useRealTimers());

describe("a TradingView call through the real route, the real mirror and both accounts", () => {
  it("mirror OFF (the default): only the demo account trades; the live bot never even gets a signal", async () => {
    const res = await hook("bullish");
    expect(res.status).toBe(200);
    expect(created(demoFake)).toBe(1);
    expect(onlyWatching(liveFake)).toBe(true);
    expect(signalsStore.query((s) => s.botId === LIVE_BOT_ID)).toHaveLength(0);
  });

  it("mirror ON but the live switch OFF: the live bot gets the signal and sends nothing anywhere", async () => {
    updateLiveSettings({ mirrorEnabled: true });
    await hook("bullish");
    expect(created(demoFake)).toBe(1);
    expect(signalsStore.query((s) => s.botId === LIVE_BOT_ID)).toHaveLength(1);
    expect(onlyWatching(liveFake)).toBe(true);
    expect(positionsStore.query((p) => p.botId === LIVE_BOT_ID)).toHaveLength(0);
  });

  it("mirror ON and live ON: both accounts trade 0.001 BTC, started together, each on its own account with its own reference", async () => {
    updateLiveSettings({ mirrorEnabled: true });
    expect(enableLive({ confirmed: true, preflightOk: true, gate: { ok: true, why: "" }, keyPresent: true })).toEqual({ ok: true });
    syncLiveBot(true);
    const res = await hook("bullish");
    expect(res.status).toBe(200);
    expect(created(demoFake)).toBe(1);
    expect(created(liveFake)).toBe(1);
    expect(stamp.demoOrder).toBeGreaterThan(0);
    expect(stamp.liveOrder).toBeGreaterThan(0); // both started together: no order between them is promised
    expect(positionsStore.query((p) => p.botId === BTC_BOT_ID)[0].brokerOrderRef).toMatch(/^bybit-open-/);
    expect(positionsStore.query((p) => p.botId === LIVE_BOT_ID)[0].brokerOrderRef).toMatch(/^bybitlive-open-/);
    const live = signalsStore.query((s) => s.botId === LIVE_BOT_ID);
    expect(live).toHaveLength(1);
    expect(live[0].barTime).toMatch(/-live$/);
  });

  it("the DEMO bot's kill switch is ON: the demo bot trades nothing, and the live bot STILL gets the signal and trades (they are independent)", async () => {
    updateLiveSettings({ mirrorEnabled: true });
    expect(enableLive({ confirmed: true, preflightOk: true, gate: { ok: true, why: "" }, keyPresent: true })).toEqual({ ok: true });
    syncLiveBot(true);
    const { botsStore } = await import("@/lib/automation/store");
    botsStore.update(BTC_BOT_ID, { killSwitch: true });
    const res = await hook("bullish");
    expect(res.status).toBe(200);
    expect(created(demoFake)).toBe(0);
    expect(created(liveFake)).toBe(1);
    expect(positionsStore.query((p) => p.botId === LIVE_BOT_ID)[0].brokerOrderRef).toMatch(/^bybitlive-open-/);
  });

  it("the DEMO bot is switched OFF: it opens nothing, and the live bot still trades", async () => {
    updateLiveSettings({ mirrorEnabled: true });
    enableLive({ confirmed: true, preflightOk: true, gate: { ok: true, why: "" }, keyPresent: true });
    syncLiveBot(true);
    const { botsStore } = await import("@/lib/automation/store");
    botsStore.update(BTC_BOT_ID, { enabled: false });
    const res = await hook("bullish");
    expect(res.status).toBe(200);
    expect(created(demoFake)).toBe(0);
    expect(created(liveFake)).toBe(1);
  });

  it("the live side failing to trade (a key with withdraw rights) changes nothing about the demo trade, and turns live OFF", async () => {
    updateLiveSettings({ mirrorEnabled: true });
    enableLive({ confirmed: true, preflightOk: true, gate: { ok: true, why: "" }, keyPresent: true });
    syncLiveBot(true);
    liveFake.keyInfo.permissions.Wallet = ["AccountTransfer"];
    const res = await hook("bullish");
    expect(res.status).toBe(200);
    expect(created(demoFake)).toBe(1);
    expect(created(liveFake)).toBe(0);
    expect(positionsStore.query((p) => p.botId === BTC_BOT_ID)[0].status).toBe("open");
    const { readLiveSettings } = await import("@/lib/automation/liveSettings");
    expect(readLiveSettings().enabled).toBe(false);
  });
});
