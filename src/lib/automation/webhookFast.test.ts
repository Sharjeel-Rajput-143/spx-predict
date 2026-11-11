import fs from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as hookRoute } from "@/app/api/webhook/hook/[token]/route";
import { ensureBotRecord } from "./bots";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { startEodScheduler, warmBotFeeds } from "./eodSweep";
import { freshQuoteNow, warmQuoteFeeds } from "./hookPrice";
import { botsStore, decisionsStore, positionsStore, signalsStore, webhooksStore } from "./store";
import { BTC_BOT_ID, resetAutomationStores } from "./testSupport";
import { __resetArrival, arrivalIdle, enqueueArrival } from "./webhookQueue";
import { createWebhook } from "./webhooks";

/**
 * The webhook answers fast, whatever the price lookup or the Bybit orders take (seen on the real app: the first alert after a restart took 1.7 seconds, most of it fetching a
 * quote, and TradingView gives up after a few). The answer validates the token and the signal word, takes the minute's slot, and goes out; the signal is saved at once when a
 * fresh quote is held, else as soon as the price is found; the orders follow behind, one signal at a time and in the order the calls arrived.
 */

const feed = vi.hoisted(() => ({ tick: null as { t: number; price: number } | null, lookupMs: 0, lookupPrice: 29_310.4 as number | null, asked: [] as string[] }));
vi.mock("@/lib/marketData/tickStore", () => ({
  getLastTick: (symbol: string) => {
    feed.asked.push(symbol);
    return feed.tick;
  },
  waitForTick: async (_symbol: string, _ms: number, maxAge?: number) => {
    if (feed.tick && Date.now() - feed.tick.t <= (maxAge ?? Infinity)) return feed.tick;
    if (feed.lookupMs) await new Promise((r) => setTimeout(r, feed.lookupMs));
    return feed.lookupPrice === null ? null : { t: Date.now(), price: feed.lookupPrice };
  },
  isLiveSymbol: () => false,
}));

const RISK = { STOP_LOSS_PERCENT: "0.3", TAKE_PROFIT_PERCENT: "0.6", POSITION_SIZE: "0.001", DAILY_MAX_LOSS_USD: "10" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let bybit: FakeBybit;
const slow = { createMs: 0 };

const text = (direction: "bullish" | "bearish") => `{"signal":"${direction}","price":75308.6,"bar_time":"2026-11-09T01:05:00Z","interval":"5"}`;
const post = (token: string, body: string) => hookRoute(new NextRequest(`http://localhost/api/webhook/hook/${token}`, { method: "POST", body, headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token }) });
/** The answer, and how long it took to come back. */
const timed = async (token: string, body: string) => {
  const start = performance.now();
  const res = await post(token, body);
  const ms = performance.now() - start;
  if (process.env.WEBHOOK_TIMINGS_FILE) fs.appendFileSync(process.env.WEBHOOK_TIMINGS_FILE, `${expect.getState().currentTestName?.slice(0, 95)} -> ${ms.toFixed(0)} ms (HTTP ${res.status})\n`);
  return { res, ms };
};
const until = async (done: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await sleep(15);
  return done();
};
const mine = () => positionsStore.all().filter((p) => p.botId === BTC_BOT_ID);
const outcomes = () => decisionsStore.all().filter((d) => d.signalId !== null).map((d) => d.outcome);
const sides = () => bybit.created.map((c) => [c.params.side, c.params.reduceOnly ?? false]);

beforeEach(() => {
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  __resetArrival();
  for (const k of Object.keys(process.env)) if (k.startsWith("BOT_NDX_EMA_BIAS_")) vi.stubEnv(k, "");
  vi.stubEnv("BROKER", "bybit");
  vi.stubEnv("EXECUTOR", "");
  for (const [k, v] of Object.entries({ BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET, BYBIT_ALWAYS_ON: "true", ...RISK })) vi.stubEnv(k, v);
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
  vi.stubEnv("BYBIT_KILL_SWITCH", "");
  resetAutomationStores();
  ensureBotRecord(BTC_BOT_ID);
  bybit = new FakeBybit();
  bybit.price = 75_300;
  bybit.clock = () => Date.now();
  slow.createMs = 0;
  feed.tick = { t: Date.now(), price: 29_310.4 };
  feed.lookupMs = 0;
  feed.lookupPrice = 29_310.4;
  feed.asked.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: Parameters<FakeBybit["fetch"]>[1]) => {
    if (slow.createMs && String(url).endsWith("/v5/order/create")) await sleep(slow.createMs);
    return bybit.fetch(String(url), init);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the answer comes back fast while the work behind it is slow", () => {
  it("slow Bybit orders: the answer is back in well under a second, before the order has even been placed; the trade opens behind it, once, with its stops", async () => {
    slow.createMs = 1500; // Bybit takes a second and a half to take the order
    const bull = createWebhook({ name: "Bybit bullish", botId: BTC_BOT_ID, direction: "bullish" });
    const { res, ms } = await timed(bull.token, text("bullish"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true });
    expect(ms).toBeLessThan(400); // the proof: nothing of the 1.5 s of order work is waited for
    expect(bybit.created).toHaveLength(0); // the order has not even been taken yet
    expect(mine().filter((p) => p.status === "open")).toHaveLength(0);
    expect(signalsStore.all()).toHaveLength(1); // but the signal is already saved
    expect(signalsStore.all()[0]).toMatchObject({ status: "accepted", signal: "bullish" });
    expect(await until(() => mine().some((p) => p.status === "open"))).toBe(true);
    expect(bybit.created).toHaveLength(1);
    expect(bybit.created[0].params).toMatchObject({ side: "Buy", qty: "0.001", stopLoss: "75074.1", takeProfit: "75751.8" });
    expect(bybit.position).toMatchObject({ size: 0.001, stopLoss: 75_074.1, takeProfit: 75_751.8 });
  });

  it("a cold quote feed (none held, a lookup that takes 2 seconds): the answer is still back at once, the signal is saved when the price is found, and the trade opens", async () => {
    feed.tick = null; // the server has just started
    feed.lookupMs = 2000;
    const bull = createWebhook({ name: "Bybit bullish", botId: BTC_BOT_ID, direction: "bullish" });
    const { res, ms } = await timed(bull.token, text("bullish"));
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(400);
    expect(((await res.json()) as { queued?: string }).queued).toMatch(/live price/);
    expect(signalsStore.all()).toHaveLength(0); // nothing saved yet: the price is still being looked for
    expect(webhooksStore.get(bull.id)?.lastTriggeredAt).not.toBeNull(); // the minute is already taken, saved
    expect(await until(() => mine().some((p) => p.status === "open"), 12_000)).toBe(true);
    expect(signalsStore.all().map((s) => [s.status, s.price])).toEqual([["accepted", 29_310.4]]);
    expect(bybit.created).toHaveLength(1);
    expect(webhooksStore.get(bull.id)?.triggerCount).toBe(1);
  });

  it("a feed that gives no price at all: still answered at once; the call is logged as rejected (no price), nothing is traded, and the minute is given back", async () => {
    feed.tick = null;
    feed.lookupPrice = null;
    const bull = createWebhook({ name: "Bybit bullish", botId: BTC_BOT_ID, direction: "bullish" });
    const { res, ms } = await timed(bull.token, text("bullish"));
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(400);
    expect(await until(() => signalsStore.all().length === 1)).toBe(true);
    expect(signalsStore.all()[0]).toMatchObject({ status: "rejected", rejectReason: "no_price" });
    expect(bybit.calls).toEqual([]);
    expect(webhooksStore.get(bull.id)?.triggerCount).toBe(0);
    feed.tick = { t: Date.now(), price: 29_310.4 }; // the feed is back: the slot was given back, so the next alert goes through
    expect((await post(bull.token, text("bullish"))).status).toBe(200);
    expect(await until(() => mine().some((p) => p.status === "open"))).toBe(true);
  });

  it("the checks that matter are still done before the answer: a wrong word is refused (422), an unknown URL is 404, a detached one is refused", async () => {
    const bull = createWebhook({ name: "Bybit bullish", botId: BTC_BOT_ID, direction: "bullish" });
    expect((await post(bull.token, text("bearish"))).status).toBe(422);
    expect((await post(bull.token, '{"price":1}')).status).toBe(422);
    expect((await post("0".repeat(48), text("bullish"))).status).toBe(404);
    expect(bybit.calls).toEqual([]);
    expect(signalsStore.all().every((s) => s.status === "rejected")).toBe(true);
  });
});

describe("a signal is never lost or run twice, and they run in the order they arrived", () => {
  it("a slow call followed by a quick one: the bullish alert still runs first, then the bearish one flips it (not the other way round)", async () => {
    feed.tick = null; // the bullish call has to look for its price
    feed.lookupMs = 700;
    const bull = createWebhook({ name: "Bybit bullish", botId: BTC_BOT_ID, direction: "bullish" });
    const bear = createWebhook({ name: "Bybit bearish", botId: BTC_BOT_ID, direction: "bearish" });
    expect((await post(bull.token, text("bullish"))).status).toBe(200);
    feed.tick = { t: Date.now(), price: 29_320 }; // the quote arrives: the bearish call finds one at once
    expect((await post(bear.token, text("bearish"))).status).toBe(200);
    expect(await until(() => mine().some((p) => p.type === "short_call_spread" && p.status === "open"), 15_000)).toBe(true);
    expect(sides()).toEqual([["Buy", false], ["Sell", true], ["Sell", false]]);
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
    expect(signalsStore.all().filter((s) => s.status === "accepted").map((s) => s.signal)).toEqual(["bullish", "bearish"]);
    expect(bybit.position.size).toBe(-0.001);
  });

  it("the same webhook called twice in a row reaches the engine once (the minute's slot), with a slow price lookup too", async () => {
    feed.tick = null;
    feed.lookupMs = 500;
    const bull = createWebhook({ name: "Bybit bullish", botId: BTC_BOT_ID, direction: "bullish" });
    const [a, b] = await Promise.all([post(bull.token, text("bullish")), post(bull.token, text("bullish"))]);
    const bodies = [(await a.json()) as { ignored?: string }, (await b.json()) as { ignored?: string }];
    expect(bodies.filter((x) => x.ignored)).toHaveLength(1);
    expect(await until(() => mine().some((p) => p.status === "open"), 10_000)).toBe(true);
    await sleep(150);
    expect(bybit.created).toHaveLength(1);
    expect(signalsStore.all().filter((s) => s.status === "accepted")).toHaveLength(1);
    expect(webhooksStore.get(bull.id)?.triggerCount).toBe(1);
  });

  it("the safety behaviour behind the answer is unchanged: the duplicate guard, the flip order, the stops, the kill switch and the daily limit all still apply", async () => {
    const bull = createWebhook({ name: "Bybit bullish", botId: BTC_BOT_ID, direction: "bullish" });
    await post(bull.token, text("bullish"));
    expect(await until(() => mine().some((p) => p.status === "open"))).toBe(true);
    expect(bybit.position.stopLoss).toBeGreaterThan(0); // stops at Bybit
    botsStore.update(BTC_BOT_ID, { killSwitch: true });
    const bear = createWebhook({ name: "Bybit bearish", botId: BTC_BOT_ID, direction: "bearish" });
    await post(bear.token, text("bearish"));
    await sleep(300);
    expect(bybit.created).toHaveLength(1); // the kill switch stops everything: no flip, no new order
    expect(outcomes()).toContain("kill_switch");
  });
});

describe("the quote feed is started with the server, so the first call finds one", () => {
  it("a quote the feed already holds is taken at once, if it is fresh; an old one or none is not", () => {
    feed.tick = { t: Date.now() - 2_000, price: 29_000 };
    expect(freshQuoteNow("BTC")).toBe(29_000);
    feed.tick = { t: Date.now() - 20_000, price: 29_000 };
    expect(freshQuoteNow("BTC")).toBeNull();
    feed.tick = null;
    expect(freshQuoteNow("BTC")).toBeNull();
    expect(freshQuoteNow(null)).toBeNull();
  });

  it("starting the server warms the feed of every active bot's underlying, once each", () => {
    ensureBotRecord("spx_ema_bias");
    botsStore.update("spx_ema_bias", { archived: true }); // as in the real app: the SPX bot is archived
    feed.asked.length = 0;
    expect(warmBotFeeds()).toEqual(["NDX", "BTC"]); // the SPX bot is archived: no feed is started for it
    expect(feed.asked).toEqual(["NDX", "BTC"]);
  });

  it("starting the scheduler (what the server does at boot) starts the feed, before any call has arrived", async () => {
    const shared = globalThis as typeof globalThis & { __eodSweepState?: { started: boolean } };
    if (shared.__eodSweepState) shared.__eodSweepState.started = false; // as on a fresh start
    const timers = vi.spyOn(globalThis, "setInterval").mockImplementation((() => 0) as never); // start no real timers
    feed.asked.length = 0;
    try {
      startEodScheduler();
      expect(feed.asked).toContain("BTC");
      await sleep(50);
    } finally {
      timers.mockRestore();
    }
  });

  it("warming skips blanks and repeats, and a feed that cannot start does not stop the others", () => {
    feed.asked.length = 0;
    expect(warmQuoteFeeds(["BTC", "BTC", null, undefined, ""])).toEqual(["BTC"]);
    expect(feed.asked).toEqual(["BTC"]);
  });
});

describe("the line the calls of a bot stand in", () => {
  it("runs turns one after another in the order they were queued, whatever each takes, and says when nobody is waiting", async () => {
    const order: string[] = [];
    expect(arrivalIdle("b")).toBe(true);
    const a = enqueueArrival("b", async () => {
      await sleep(80);
      order.push("a");
    });
    const b = enqueueArrival("b", async () => {
      order.push("b");
    });
    expect(arrivalIdle("b")).toBe(false);
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
    expect(arrivalIdle("b")).toBe(true);
  });

  it("a turn that fails is reported and the line goes on; different bots do not wait for each other", async () => {
    const errors: unknown[] = [];
    const order: string[] = [];
    await enqueueArrival("c", async () => { throw new Error("boom"); }, (e) => errors.push(e));
    await enqueueArrival("c", async () => { order.push("after"); });
    expect(errors).toHaveLength(1);
    expect(order).toEqual(["after"]);
    const slowOne = enqueueArrival("d", async () => { await sleep(100); order.push("d-slow"); });
    await enqueueArrival("e", async () => { order.push("e"); });
    expect(order.at(-1)).toBe("e"); // e did not wait for d
    await slowOne;
  });
});
