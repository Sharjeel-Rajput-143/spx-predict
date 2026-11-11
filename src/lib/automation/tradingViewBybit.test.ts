import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as hookRoute } from "@/app/api/webhook/hook/[token]/route";
import { ensureBotRecord } from "./bots";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { BybitExecutor } from "./bybitExecutor";
import { positionsStore, decisionsStore, signalsStore, webhooksStore } from "./store";
import { BTC_BOT_ID, NDX_BOT_ID, resetAutomationStores } from "./testSupport";
import { getExecutor } from "./sharedExecutor";
import { createWebhook, repointWebhook } from "./webhooks";

/**
 * A real TradingView alert reaching the Bybit demo bot, end to end and offline: a TradingView-shaped request to a named webhook URL, through the real route handler and
 * the real engine, onto the fake Bybit exchange at a BTC-scale price (about 75,000). The app is set up the way the real one is: Bybit as the broker, the BTC Bybit Bot
 * the one that trades, the NDX bot on its own defaults (none of the test-only NDX settings) and with no link to Bybit, 24/7 on.
 *
 * What it shows about the named webhook (the URL TradingView is given):
 *  - the price in the alert is NOT used: the BTC bot works from Bybit's own price (never the NDX quote), and Bybit trades at market, so the price in the alert never reaches the engine;
 *  - the alert's TEXT must say the URL's direction ("bullish" or "bearish"), or the call is refused with HTTP 422 and nothing is traded.
 */

const feed = vi.hoisted(() => ({ price: 29_310.4, btc: 75_110.6, asked: [] as string[] }));
// The app's price feed, by symbol: the NDX quote (29,310) and, for the BTC bot, Bybit's own price (75,110.6). A symbol the BTC bot is not on never gets the other's price.
vi.mock("@/lib/marketData/tickStore", () => ({
  waitForTick: async (symbol: string) => (feed.asked.push(symbol), { t: Date.now(), price: symbol === "BTC" ? feed.btc : feed.price }),
  getLastTick: (symbol: string) => (feed.asked.push(symbol), { t: Date.now(), price: symbol === "BTC" ? feed.btc : feed.price }),
  isLiveSymbol: () => false,
}));

const RISK = { STOP_LOSS_PERCENT: "0.3", TAKE_PROFIT_PERCENT: "0.6", POSITION_SIZE: "0.001", DAILY_MAX_LOSS_USD: "3" };
let bybit: FakeBybit;

const setupEnv = () => {
  // the NDX bot on its defaults, like the real app (the test-only NDX settings are not used)
  for (const k of Object.keys(process.env)) if (k.startsWith("BOT_NDX_EMA_BIAS_")) vi.stubEnv(k, "");
  vi.stubEnv("BROKER", "bybit");
  vi.stubEnv("EXECUTOR", "");
  for (const [k, v] of Object.entries({ BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET, BYBIT_ALWAYS_ON: "true", ...RISK })) vi.stubEnv(k, v);
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
  vi.stubEnv("BYBIT_KILL_SWITCH", "");
};

/** The text TradingView sends for an alert whose message is the one we recommend, with the placeholders filled in. */
const message = (direction: "bullish" | "bearish", price: number) => `{"signal":"${direction}","price":${price},"bar_time":"2026-11-09T01:05:00Z","interval":"5"}`;
const call = (token: string, text: string) => hookRoute(new NextRequest(`http://localhost/api/webhook/hook/${token}`, { method: "POST", body: text, headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token }) });
const until = async (done: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
  return done();
};
const outcomes = () => decisionsStore.all().filter((d) => d.signalId !== null).map((d) => d.outcome);
const mine = () => positionsStore.all().filter((p) => p.botId === BTC_BOT_ID);

beforeEach(() => {
  feed.asked.length = 0;
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  setupEnv();
  resetAutomationStores();
  ensureBotRecord(BTC_BOT_ID);
  ensureBotRecord(NDX_BOT_ID);
  bybit = new FakeBybit();
  bybit.price = 75_123.4;
  bybit.clock = () => Date.now();
  vi.stubGlobal("fetch", (url: string, init: Parameters<FakeBybit["fetch"]>[1]) => bybit.fetch(String(url), init));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a TradingView alert, through the named webhook, onto Bybit", () => {
  it("is set up the way the real app is: Bybit, a demo account, the NDX bot on its defaults", () => {
    expect(getExecutor().venue).toBe("bybit");
    expect(getExecutor().tradingWindowFor!("BTC")).toMatchObject({ alwaysOn: true });
    expect(process.env.BOT_NDX_EMA_BIAS_PRICE_MIN ?? "").toBe("");
  });

  it("a bullish alert opens a LONG at Bybit with its stop loss and take profit; the BTC price in the alert is never used", async () => {
    const bull = createWebhook({ name: "Bybit bullish", botId: BTC_BOT_ID, direction: "bullish" });
    const res = await call(bull.token, message("bullish", 75_123.4));
    expect(res.status).toBe(200);
    expect(await until(() => mine().some((p) => p.status === "open"))).toBe(true);
    expect(bybit.created).toHaveLength(1);
    expect(bybit.created[0].params).toMatchObject({ side: "Buy", qty: "0.001", orderType: "Market", symbol: "BTCUSDT", stopLoss: "74898.0", takeProfit: "75574.1" });
    const [signal] = signalsStore.all();
    expect(signal).toMatchObject({ signal: "bullish", status: "accepted", price: 75_110.6 }); // Bybit's own price for the BTC bot: not the alert's 75,123.4, and not the NDX quote 29,310.4
    expect(feed.asked).toContain("BTC");
    expect(mine()[0]).toMatchObject({ type: "short_put_spread", venue: "bybit", status: "open" });
    expect(bybit.position).toMatchObject({ size: 0.001, stopLoss: 74_898, takeProfit: 75_574.1 });
  });

  it("a bearish alert after it flips: reduce-only close first, then a short, with the stops mirrored", async () => {
    const bull = createWebhook({ name: "Bybit bullish", botId: BTC_BOT_ID, direction: "bullish" });
    const bear = createWebhook({ name: "Bybit bearish", botId: BTC_BOT_ID, direction: "bearish" });
    await call(bull.token, message("bullish", 75_123.4));
    expect(await until(() => mine().some((p) => p.status === "open"))).toBe(true);
    bybit.price = 75_200;
    await call(bear.token, message("bearish", 75_200));
    expect(await until(() => mine().some((p) => p.type === "short_call_spread" && p.status === "open"))).toBe(true);
    expect(bybit.created.map((c) => [c.params.side, c.params.reduceOnly ?? false])).toEqual([["Buy", false], ["Sell", true], ["Sell", false]]);
    expect(bybit.created[2].params).toMatchObject({ stopLoss: "75425.6", takeProfit: "74748.8" });
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
    expect(mine().find((p) => p.type === "short_put_spread")).toMatchObject({ status: "closed", closeReason: "signal_flip" });
    expect(bybit.position.size).toBe(-0.001);
  });

  it("webhooks that were on the NDX bot, re-pointed to the BTC bot, answer on the SAME address: the BTC bot trades, and the NDX bot makes no spread", async () => {
    const bull = createWebhook({ name: "Bybit bullish", botId: NDX_BOT_ID, direction: "bullish" });
    const bear = createWebhook({ name: "Bybit bearish", botId: NDX_BOT_ID, direction: "bearish" });
    const [bullToken, bearToken] = [bull.token, bear.token];
    repointWebhook(bull.id, BTC_BOT_ID);
    repointWebhook(bear.id, BTC_BOT_ID);
    expect(webhooksStore.get(bull.id)?.token).toBe(bullToken);
    expect(webhooksStore.get(bear.id)?.token).toBe(bearToken);
    const res = await call(bullToken, message("bullish", 75_123.4));
    expect(res.status).toBe(200);
    expect(await until(() => positionsStore.all().some((p) => p.status === "open"))).toBe(true);
    const flip = await call(bearToken, message("bearish", 75_200));
    expect(flip.status).toBe(200);
    expect(await until(() => positionsStore.all().some((p) => p.type === "short_call_spread" && p.status === "open"))).toBe(true);
    expect(signalsStore.all().every((sig) => sig.botId === BTC_BOT_ID)).toBe(true);
    expect(positionsStore.all().every((p) => p.botId === BTC_BOT_ID && p.underlying === "BTC" && p.venue === "bybit")).toBe(true);
    expect(positionsStore.all().filter((p) => p.underlying === "NDX" || p.botId === NDX_BOT_ID)).toEqual([]);
    expect(bybit.created.map((c) => [c.params.side, c.params.reduceOnly ?? false])).toEqual([["Buy", false], ["Sell", true], ["Sell", false]]);
  });

  it("an alert whose TEXT does not say the URL's direction is refused with HTTP 422 and nothing is traded (the message must contain bullish or bearish)", async () => {
    const bull = createWebhook({ name: "Bybit bullish", botId: BTC_BOT_ID, direction: "bullish" });
    const res = await call(bull.token, '{"price":75123.4,"bar_time":"2026-11-09T01:05:00Z","interval":"5"}');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/doesn't say "bullish"/);
    expect(bybit.calls).toEqual([]);
    expect(mine()).toEqual([]);
    expect(signalsStore.all()[0]).toMatchObject({ status: "rejected", rejectReason: "alert_text_missing" });
  });

  it("a bearish message sent to the bullish URL is refused too, and the slot is not used, so the right alert a moment later goes through", async () => {
    const bull = createWebhook({ name: "Bybit bullish", botId: BTC_BOT_ID, direction: "bullish" });
    expect((await call(bull.token, message("bearish", 75_000))).status).toBe(422);
    expect(bybit.created).toHaveLength(0);
    expect((await call(bull.token, message("bullish", 75_000))).status).toBe(200);
    expect(await until(() => mine().some((p) => p.status === "open"))).toBe(true);
  });

  it("the same webhook called twice within a minute is ignored the second time (no second order)", async () => {
    const bull = createWebhook({ name: "Bybit bullish", botId: BTC_BOT_ID, direction: "bullish" });
    await call(bull.token, message("bullish", 75_123.4));
    expect(await until(() => mine().some((p) => p.status === "open"))).toBe(true);
    const second = await call(bull.token, message("bullish", 75_130));
    expect(second.status).toBe(200);
    expect(JSON.stringify(await second.json())).toMatch(/once a minute/);
    await new Promise((r) => setTimeout(r, 150));
    expect(bybit.created).toHaveLength(1);
  });

  it("an unknown or detached webhook URL answers 404, and nothing is sent to Bybit", async () => {
    expect((await call("0".repeat(48), message("bullish", 75_000))).status).toBe(404);
    expect(bybit.calls).toEqual([]);
  });
});

describe("the engine at BTC-scale prices (the older single URL, whose alert price IS used)", () => {
  const fast = { closeConfirmTimeoutMs: 2000, orderFillTimeoutMs: 2000, pollIntervalMs: 5, ladderStepMs: 20 };
  const executor = () => getExecutor() as unknown as BybitExecutor;
  let n = 0;
  const alert = (direction: "bullish" | "bearish", price: number) => {
    const at = Date.now() + ++n * 5 * 60_000; // spread out, so the engine's own duplicate guard does not apply
    return receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: direction, price, barTime: `btc-${n}`, interval: "5", raw: { symbol: "BTC" }, now: at });
  };

  it("alert prices of about 75,000 (with decimals) are accepted: nothing is rejected as out of range, invalid strikes or over the allocation", async () => {
    for (const [direction, price] of [["bullish", 75_000], ["bearish", 75_123.45], ["bullish", 74_999.99], ["bearish", 75_001.5]] as const) {
      await processSignal(alert(direction, price), { executor: executor(), now: Date.now(), ...fast });
    }
    expect(outcomes()).toEqual(["opened", "closed", "opened", "closed", "opened", "closed", "opened"]);
    for (const bad of ["price_out_of_range", "invalid_strikes", "allocation_limit_reached", "below_min_credit", "symbol_mismatch", "config_error"]) expect(outcomes()).not.toContain(bad);
    expect(bybit.created.map((c) => [c.params.side, c.params.reduceOnly ?? false])).toEqual([["Buy", false], ["Sell", true], ["Sell", false], ["Buy", true], ["Buy", false], ["Sell", true], ["Sell", false]]);
    expect(bybit.position.size).toBe(-0.001);
  });

  it("other magnitudes are fine too (a price of 7,500 or 750,000 changes nothing about the Bybit order)", async () => {
    await processSignal(alert("bullish", 750_000), { executor: executor(), now: Date.now(), ...fast });
    expect(outcomes()).toEqual(["opened"]);
    expect(bybit.created[0].params).toMatchObject({ side: "Buy", qty: "0.001" });
  });
});
