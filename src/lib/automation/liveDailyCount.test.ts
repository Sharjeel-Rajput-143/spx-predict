import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BTC_BOT_ID, ensureBotRecord } from "./bots";
import type { BybitConfig } from "./bybitExecutor";
import { LiveBybitExecutor } from "./bybitLive";
import { LIVE_API_BASE, LIVE_BOT_ID } from "./bybitLiveLimits";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { appLiveGuard, syncLiveBot } from "./liveGuard";
import { __resetLiveSettings, enableLive } from "./liveSettings";
import { countTodayNewPositions } from "./safeguards";
import { botsStore, positionsStore } from "./store";
import { BASE_NOW, buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import { OrderNotPlacedError } from "./orderErrors";
import type { OpenSpreadRequest } from "./types";

// THE LIVE TRADES-A-DAY COUNT cannot be restarted by anything on a page ("Reset daily counter" works on the demo bot only), and a live chain trade counts in it.

setNdxTestEnv();
const NOW = BASE_NOW;
const trade = (botId: string, i: number, over: object = {}) => buildPosition({ botId, type: "short_put_spread", status: "closed", venue: "bybit", openedAt: NOW - (i + 1) * 60_000, closedAt: NOW - i * 60_000, closeReason: "stop_loss", ...over });
const base: Omit<BybitConfig, "apiBase"> = { apiKey: API_KEY, apiSecret: API_SECRET, symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 3, breakevenTriggerPercent: 0, breakevenLockPercent: 0, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetAutomationStores();
  setNdxTestEnv();
  __resetLiveSettings();
  (globalThis as { __liveBootedApp?: boolean }).__liveBootedApp = true;
  ensureBotRecord(BTC_BOT_ID);
  ensureBotRecord(LIVE_BOT_ID);
});
afterEach(() => vi.useRealTimers());

describe("the count itself", () => {
  it("the demo bot: a reset restarts the count (unchanged), and chain trades are not counted (unchanged)", () => {
    for (let i = 0; i < 3; i++) positionsStore.insert(trade(BTC_BOT_ID, i));
    positionsStore.insert(trade(BTC_BOT_ID, 5, { chain: { rootSignalId: "s", index: 1 } }));
    expect(countTodayNewPositions(BTC_BOT_ID, NOW)).toBe(3);
    expect(countTodayNewPositions(BTC_BOT_ID, NOW, NOW - 90_000)).toBe(1); // only the trade opened after the reset moment
    expect(countTodayNewPositions(BTC_BOT_ID, NOW, NOW + 1)).toBe(0);
  });
  it("the LIVE bot: a reset moment is IGNORED, and a chain trade IS counted", () => {
    for (let i = 0; i < 3; i++) positionsStore.insert(trade(LIVE_BOT_ID, i));
    positionsStore.insert(trade(LIVE_BOT_ID, 5, { chain: { rootSignalId: "s", index: 1 } }));
    expect(countTodayNewPositions(LIVE_BOT_ID, NOW)).toBe(4);
    expect(countTodayNewPositions(LIVE_BOT_ID, NOW, NOW + 1)).toBe(4);
    expect(countTodayNewPositions(LIVE_BOT_ID, NOW, NOW - 90_000)).toBe(4);
  });
  it("yesterday's trades are never counted, for either bot (the count restarts by itself each New York day)", () => {
    positionsStore.insert(trade(LIVE_BOT_ID, 1, { openedAt: NOW - 30 * 3600_000 }));
    positionsStore.insert(trade(BTC_BOT_ID, 1, { openedAt: NOW - 30 * 3600_000 }));
    expect(countTodayNewPositions(LIVE_BOT_ID, NOW)).toBe(0);
    expect(countTodayNewPositions(BTC_BOT_ID, NOW)).toBe(0);
  });
  it("the live bot's count is its own: demo trades are not in it, and live trades are not in the demo's", () => {
    for (let i = 0; i < 4; i++) positionsStore.insert(trade(BTC_BOT_ID, i));
    positionsStore.insert(trade(LIVE_BOT_ID, 9));
    expect(countTodayNewPositions(LIVE_BOT_ID, NOW)).toBe(1);
    expect(countTodayNewPositions(BTC_BOT_ID, NOW)).toBe(4);
  });
});

describe("what the live executor sees", () => {
  it("appLiveGuard.tradesToday ignores a reset stored on the live bot", () => {
    for (let i = 0; i < 4; i++) positionsStore.insert(trade(LIVE_BOT_ID, i));
    expect(appLiveGuard.tradesToday(NOW)).toBe(4);
    botsStore.update(LIVE_BOT_ID, { dailyResetAt: NOW });
    expect(appLiveGuard.tradesToday(NOW)).toBe(4);
  });
  it("the 5-a-day ceiling stands even if a reset was stored: the entry is refused, nothing is sent", async () => {
    expect(enableLive({ confirmed: true, preflightOk: true, gate: { ok: true, why: "" }, keyPresent: true })).toEqual({ ok: true });
    syncLiveBot(true);
    for (let i = 0; i < 5; i++) positionsStore.insert(trade(LIVE_BOT_ID, i));
    botsStore.update(LIVE_BOT_ID, { dailyResetAt: NOW }); // somebody pressed "reset" (an old stored value, or a hand-made request)
    const fake = new FakeBybit();
    fake.clock = () => NOW;
    const live = new LiveBybitExecutor({ ...base, apiBase: LIVE_API_BASE }, appLiveGuard, fake.fetch, () => undefined, () => NOW);
    live.sleep = async () => undefined;
    const req = { botId: LIVE_BOT_ID, underlying: "BTC", positionType: "short_put_spread", shortStrike: 1, longStrike: 1, quantity: 1, limitCredit: 1, expiry: "2026-11-11", clientOrderId: "x:open" } as unknown as OpenSpreadRequest;
    await expect(live.placeOpenOrder(req)).rejects.toThrow(/5 live trades have already been opened today/);
    await expect(live.placeOpenOrder(req)).rejects.toBeInstanceOf(OrderNotPlacedError);
    expect(fake.created).toHaveLength(0);
  });
});
