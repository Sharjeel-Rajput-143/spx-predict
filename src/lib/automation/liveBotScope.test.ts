import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as botGET } from "@/app/api/automation/bots/[id]/route";
import { GET as liveTradesGET } from "@/app/api/automation/live/trades/route";
import { BTC_BOT_ID, ensureBotRecord } from "./bots";
import type { BybitConfig } from "./bybitExecutor";
import { LiveBybitExecutor } from "./bybitLive";
import { LIVE_API_BASE, LIVE_BOT_ID } from "./bybitLiveLimits";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { buildBybitView } from "./bybitView";
import { appLiveGuard } from "./liveGuard";
import { __resetLiveSettings } from "./liveSettings";
import { decisionsStore, ordersStore, positionsStore, runsStore, signalsStore } from "./store";
import { buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";

/**
 * THE LIVE BOT'S PAGE SHOWS LIVE DATA ONLY. The live bot's tabs (Dashboard, Positions, Log, Settings) are fed by (1) the bot's own API (/api/automation/bots/<id>, everything
 * scoped by the bot id) and (2) for the BTC trades on the Positions tab, a read of the Bybit account: the LIVE bot reads the LIVE account (/api/automation/live/trades),
 * the demo bot the demo account (/api/automation/bybit). These tests seed demo data next to live data and prove the live page can see none of the demo's.
 */

setNdxTestEnv();
const base: Omit<BybitConfig, "apiBase"> = { apiKey: API_KEY, apiSecret: API_SECRET, symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 3, breakevenTriggerPercent: 0, breakevenLockPercent: 0, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000 };
const g = globalThis as typeof globalThis & { __liveBybit?: { executor: LiveBybitExecutor | null; error: string | null }; __liveBootedApp?: boolean };
const NOW = Date.now();
const MIN = 60_000;

let liveFake: FakeBybit;
const closedRow = (orderId: string, pnl: string) => ({ orderId, closedPnl: pnl, side: "Sell", qty: "0.001", closedSize: "0.001", avgEntryPrice: "75000", avgExitPrice: "75100", leverage: "10", cumEntryValue: "75", cumExitValue: "75.1", openFee: "0.04", closeFee: "0.04", updatedTime: String(NOW - 5 * MIN), createdTime: String(NOW - 6 * MIN) });
const trade = (id: string, botId: string, ref: string) =>
  buildPosition({ id, botId, underlying: "BTC", venue: "bybit", type: "short_put_spread", status: "closed", requestedQuantity: 1, filledQuantity: 1, credit: 0.75, closePrice: 0.75, openedAt: NOW - 30 * MIN, closedAt: NOW - 5 * MIN, brokerOrderRef: ref, closeReason: "stop_loss" });
const get = (url: string) => new NextRequest(`http://localhost${url}`, { method: "GET" });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  __resetLiveSettings();
  g.__liveBootedApp = true;
  liveFake = new FakeBybit();
  const live = new LiveBybitExecutor({ ...base, apiBase: LIVE_API_BASE }, appLiveGuard, liveFake.fetch, () => undefined);
  live.sleep = async () => undefined;
  g.__liveBybit = { executor: live, error: null };
  ensureBotRecord(BTC_BOT_ID);
  ensureBotRecord(LIVE_BOT_ID);
});
afterEach(() => vi.unstubAllEnvs());

describe("the bot page's own data is scoped by the bot", () => {
  it("the live bot's payload holds none of the demo bot's positions, orders, signals, decisions or runs", async () => {
    // demo bot's records
    positionsStore.insert(trade("demo-pos", BTC_BOT_ID, "bybit-close-d1"));
    ordersStore.insert({ id: "demo-ord", positionId: "demo-pos", kind: "open", status: "filled", limitPrice: 0, filledQuantity: 1, ref: "bybit-open-d1", createdAt: NOW, updatedAt: NOW });
    signalsStore.insert({ id: "demo-sig", botId: BTC_BOT_ID, signal: "bullish", barTime: "t", price: 75_000, interval: "5", receivedAt: NOW, status: "accepted", raw: {} } as never);
    decisionsStore.insert({ id: "demo-dec", signalId: null, botId: BTC_BOT_ID, outcome: "opened", reason: "demo only", detail: {}, createdAt: NOW } as never);
    runsStore.insert({ id: "demo-run", botId: BTC_BOT_ID, signalId: "demo-sig", startedAt: NOW } as never);
    // live bot's records
    positionsStore.insert(trade("live-pos", LIVE_BOT_ID, "bybitlive-close-l1"));
    decisionsStore.insert({ id: "live-dec", signalId: null, botId: LIVE_BOT_ID, outcome: "opened", reason: "live only", detail: {}, createdAt: NOW } as never);

    const res = await botGET(get(`/api/automation/bots/${LIVE_BOT_ID}`) as never, { params: Promise.resolve({ id: LIVE_BOT_ID }) } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bot.id).toBe(LIVE_BOT_ID);
    expect(body.positions.map((p: { id: string }) => p.id)).toEqual(["live-pos"]);
    expect(body.orders).toEqual([]); // the demo position's order is not the live bot's
    expect(body.signals).toEqual([]);
    expect(body.decisions.map((d: { id: string }) => d.id)).toEqual(["live-dec"]);
    expect(body.runs).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/demo-pos|demo-ord|demo-sig|demo-dec|demo-run|demo only/);
  });

  it("today's result and the daily loss limit on the live bot's page come from the LIVE executor and the live bot's own trades", async () => {
    // a demo loss today must not appear as the live bot's result
    positionsStore.insert({ ...trade("demo-loss", BTC_BOT_ID, "bybit-close-d2"), settlement: { kind: "broker", pl: -2.5, at: NOW } });
    const res = await botGET(get(`/api/automation/bots/${LIVE_BOT_ID}`) as never, { params: Promise.resolve({ id: LIVE_BOT_ID }) } as never);
    const body = await res.json();
    expect(body.dayLoss.realized).toBe(0);
    expect(body.dayLoss.closedToday).toBe(0);
    expect(body.limits.brokerDailyLossLimit).toBe(2); // the live daily loss setting ($2 by default, never above the $3 ceiling), not the demo's $10
  });

  it("with no live key the live page falls back to the live bot's own (empty) figures and never to the demo executor", async () => {
    g.__liveBybit = { executor: null, error: "no live key" };
    positionsStore.insert({ ...trade("demo-loss", BTC_BOT_ID, "bybit-close-d2"), settlement: { kind: "broker", pl: -2.5, at: NOW } });
    const res = await botGET(get(`/api/automation/bots/${LIVE_BOT_ID}`) as never, { params: Promise.resolve({ id: LIVE_BOT_ID }) } as never);
    const body = await res.json();
    expect(body.limits.brokerDailyLossLimit).toBeNull();
    expect(body.dayLoss.realized).toBe(0);
    expect(body.positions).toEqual([]);
  });
});

describe("the live bot's BTC trades come from the live account only", () => {
  it("/api/automation/live/trades: signed out is 401 and asks Bybit nothing", async () => {
    vi.stubEnv("APP_LOGIN_PASSWORD", "x-not-a-real-password");
    const res = await liveTradesGET(get("/api/automation/live/trades") as never);
    expect(res.status).toBe(401);
    expect(liveFake.calls).toHaveLength(0);
  });

  it("with no live key it says so, asks Bybit nothing, and shows no trades", async () => {
    g.__liveBybit = { executor: null, error: "The live bot will not trade until these are set in .env.local: BYBIT_LIVE_API_KEY" };
    positionsStore.insert(trade("demo-pos", BTC_BOT_ID, "bybit-close-d1"));
    const res = await liveTradesGET(get("/api/automation/live/trades") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ active: false, noKey: true });
    expect(body.view).toBeUndefined();
    expect(liveFake.calls).toHaveLength(0);
  });

  it("with a live key it reads the LIVE account for the LIVE bot, and never returns the key", async () => {
    const res = await liveTradesGET(get("/api/automation/live/trades") as never);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(API_SECRET);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ active: true, botId: LIVE_BOT_ID });
    expect(body.view.symbol).toBe("BTCUSDT");
    expect(liveFake.calls.length).toBeGreaterThan(0);
  });

  it("a trade is 'the bot's own' only for the bot whose record owns it: demo trades never show on the live view, live trades never on the demo view", async () => {
    liveFake.closedPnl = [closedRow("d1", "-0.31"), closedRow("l1", "-0.32")];
    positionsStore.insert(trade("demo-pos", BTC_BOT_ID, "bybit-close-d1"));
    positionsStore.insert(trade("live-pos", LIVE_BOT_ID, "bybitlive-close-l1"));
    const live = g.__liveBybit!.executor!;
    const liveView = await buildBybitView(live, LIVE_BOT_ID, "BTCUSDT", NOW);
    expect(liveView.history.filter((r) => r.byBot).map((r) => r.orderId)).toEqual(["l1"]);
    // the demo page, built on the same list of closed trades, claims only the demo bot's
    const demoView = await buildBybitView(live, BTC_BOT_ID, "BTCUSDT", NOW);
    expect(demoView.history.filter((r) => r.byBot).map((r) => r.orderId)).toEqual(["d1"]);
  });
});
