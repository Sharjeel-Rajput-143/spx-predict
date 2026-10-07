import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebhook, deleteWebhook, findWebhookByToken, updateWebhook } from "@/lib/automation/webhooks";
import { createEmptyBot, deleteBot, ensureBotRecord } from "@/lib/automation/bots";
import { decisionsStore, positionsStore, signalsStore, webhooksStore } from "@/lib/automation/store";
import { BASE_NOW, NDX_BOT_ID, TEST_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "@/lib/automation/testSupport";
import { GET as list, POST as create } from "../../../automation/webhooks/route";
import { DELETE as remove, PATCH as patch } from "../../../automation/webhooks/[id]/route";
import { POST } from "./route";

// The live feed is never reached from a test: a cold server has no quote, unless a test gives one.
const feed = vi.hoisted(() => ({ tick: null as { t: number; price: number } | null, slowTick: null as { t: number; price: number } | null }));
// A short wait (the quick one) sees `tick`; a long wait (the background one) also sees `slowTick`: a quote that arrives late.
vi.mock("@/lib/marketData/tickStore", () => ({ waitForTick: async (_s: string, ms: number) => feed.tick ?? (ms >= 5000 ? feed.slowTick : null), getLastTick: () => feed.tick, isLiveSymbol: () => false }));

// Named webhooks, through the route handlers, on the mock executor. No network.

setTestBotEnv();
setNdxTestEnv();

const call = (token: string, body?: string) => POST(new NextRequest(`http://localhost/api/webhook/hook/${token}`, { method: "POST", body, headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token }) });
const settle = () => new Promise((r) => setTimeout(r, 80));

beforeEach(() => {
  feed.tick = { t: Date.now(), price: 21_003.7 }; // the live quote the bot works from
  
  feed.slowTick = null;
  resetAutomationStores();
  setNdxTestEnv();
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("creating a webhook", () => {
  it("gives a unique secret URL for one bot and one direction", () => {
    const a = createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
    const b = createWebhook({ name: "BearishNDX", botId: NDX_BOT_ID, direction: "bearish" });
    expect(a.token).toMatch(/^[0-9a-f]{48}$/);
    expect(a.token).not.toBe(b.token);
    expect(a).toMatchObject({ botId: NDX_BOT_ID, direction: "bullish", active: true, triggerCount: 0, lastTriggeredAt: null });
  });

  it("refuses a blank or duplicate name, an unknown bot, and a bad direction", () => {
    createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
    expect(() => createWebhook({ name: "  ", botId: NDX_BOT_ID, direction: "bullish" })).toThrow(/name/);
    expect(() => createWebhook({ name: "bullishndx", botId: NDX_BOT_ID, direction: "bullish" })).toThrow(/already exists/);
    expect(() => createWebhook({ name: "X", botId: "nope", direction: "bullish" })).toThrow(/bot that exists/);
    expect(() => createWebhook({ name: "Y", botId: NDX_BOT_ID, direction: "sideways" as never })).toThrow(/bullish/);
  });

  it("is found by its token and nothing else", () => {
    const w = createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bullish" });
    expect(findWebhookByToken(w.token)?.id).toBe(w.id);
    const last = w.token.at(-1) === "0" ? "1" : "0"; // always a different last character
    expect(findWebhookByToken(w.token.slice(0, -1) + last)).toBeUndefined();
    expect(findWebhookByToken("")).toBeUndefined();
  });

  it("goes away with its bot", () => {
    const bot = createEmptyBot({ name: "Temp", accountId: "paper-1", allocationLimit: 1000 });
    const w = createWebhook({ name: "A", botId: bot.id, direction: "bullish" });
    expect(webhooksStore.get(w.id)).toBeDefined();
    deleteBot(bot.id);
    expect(webhooksStore.get(w.id)).toBeUndefined();
  });
});

describe("calling a webhook", () => {
  it("a bullish webhook becomes a bullish signal for its bot, at the bot's own live quote, with that bot's own symbol", async () => {
    const w = createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
    const res = await call(w.token, "");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true });
    const [signal] = signalsStore.all();
    expect(signal).toMatchObject({ botId: NDX_BOT_ID, signal: "bullish", price: 21_003.7, interval: "", status: "accepted" });
    expect((signal.raw as { symbol: string }).symbol).toBe("NDX");
    await settle();
    expect(decisionsStore.all().length).toBeGreaterThan(0); // the engine ran it through its decisions
    expect(webhooksStore.get(w.id)).toMatchObject({ triggerCount: 1 });
    expect(webhooksStore.get(w.id)?.lastTriggeredAt).toBeGreaterThan(0);
  });

  it("a bearish webhook is a bearish signal", async () => {
    feed.tick = { t: Date.now(), price: 7720.5 };
    const w = createWebhook({ name: "BearishSPX", botId: TEST_BOT_ID, direction: "bearish" });
    await call(w.token, "");
    expect(signalsStore.all()[0]).toMatchObject({ botId: TEST_BOT_ID, signal: "bearish", price: 7720.5 });
  });

  it("the call is only a trigger, as in Option Alpha: nothing in the message is read, a price in it least of all", async () => {
    for (const [i, body] of ['{"price":99999,"bar_time":"x","interval":"5"}', "12345.6", '{"close":"1.5"}', "Bullish signal, confirmed cross"].entries()) {
      resetAutomationStores();
      const w = createWebhook({ name: `H${i}`, botId: NDX_BOT_ID, direction: "bullish" });
      expect((await call(w.token, body)).status, body).toBe(200);
      expect(signalsStore.all()[0], body).toMatchObject({ price: 21_003.7, interval: "" }); // the bot's own quote, not the message's
      expect(signalsStore.all()[0].barTime, body).not.toBe("x");
    }
  });

  it("a bare call, with no message at all (as Option Alpha's is), runs on the live quote", async () => {
    feed.tick = { t: Date.now(), price: 21_050.5 };
    const w = createWebhook({ name: "Bare", botId: NDX_BOT_ID, direction: "bullish" });
    expect((await call(w.token, "")).status).toBe(200);
    expect((await call(w.token, "Bullish signal, confirmed cross or opening bias")).status).toBe(200);
    expect(signalsStore.all()[0].price).toBe(21_050.5);
  });

  it("a plain-text alert message with no price, and only a stale quote, is answered at once and logged as rejected (no price)", async () => {
    feed.tick = { t: Date.now() - 10 * 60_000, price: 21_050.5 };
    const w = createWebhook({ name: "Stale", botId: NDX_BOT_ID, direction: "bullish" });
    expect((await call(w.token, "Bullish signal")).status).toBe(202); // TradingView is not kept waiting
    await settle();
    expect(signalsStore.all().map((s) => [s.status, s.rejectReason])).toEqual([["rejected", "no_price"]]);
  });

  it("two calls arriving at the same moment (a double delivery) reach the engine once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE_NOW); // inside trading hours
    feed.tick = { t: Date.now(), price: 21_050.5 };
    const w = createWebhook({ name: "Twice", botId: NDX_BOT_ID, direction: "bullish" });
    const [a, b] = await Promise.all([call(w.token, ""), call(w.token, "")]);
    await settle();
    await settle();
    const bodies = [await a.json(), await b.json()];
    expect(bodies.filter((x) => x.ignored)).toHaveLength(1);
    expect(signalsStore.all().filter((x) => x.status === "accepted")).toHaveLength(1); // only one reached the engine
    expect(signalsStore.all().filter((x) => x.rejectReason === "webhook_rate_limited")).toHaveLength(1);
    expect(webhooksStore.get(w.id)?.triggerCount).toBe(1);
  });

  it("a call that found no price does not use up the minute", async () => {
    feed.tick = null;
    const w = createWebhook({ name: "NoQuote", botId: NDX_BOT_ID, direction: "bullish" });
    expect((await call(w.token, "")).status).toBe(202);
    await settle();
    feed.tick = { t: Date.now(), price: 21_050.5 };
    expect((await call(w.token, "")).status).toBe(200);
    await settle(); // let the bot finish before the next test starts
  });

  it("with no live quote the call is answered at once; once the wait is over it is logged as rejected and nothing is run", async () => {
    feed.tick = null;
    const w = createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bullish" });
    const res = await call(w.token, "");
    expect(res.status).toBe(202);
    expect((await res.json()).queued).toMatch(/live price/);
    await settle();
    expect(signalsStore.all()).toHaveLength(1);
    expect(signalsStore.all()[0]).toMatchObject({ status: "rejected", rejectReason: "no_price", botId: NDX_BOT_ID, signal: "bullish" });
    expect(decisionsStore.all().filter((d) => d.signalId !== null)).toHaveLength(0);
    expect(webhooksStore.get(w.id)?.triggerCount).toBe(0);
  });

  it("a slow quote: the call is answered before the quote arrives, and runs when it does", async () => {
    feed.tick = null;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE_NOW); // inside trading hours
    feed.slowTick = { t: BASE_NOW, price: 21_050.5 }; // not there for the quick look, there for the longer one
    const w = createWebhook({ name: "Slow", botId: NDX_BOT_ID, direction: "bullish" });
    expect((await call(w.token, "")).status).toBe(202);
    await settle();
    await settle();
    expect(signalsStore.all().map((s) => [s.status, s.price])).toEqual([["accepted", 21_050.5]]);
    expect(webhooksStore.get(w.id)?.triggerCount).toBe(1);
    expect(decisionsStore.all().filter((d) => d.signalId !== null).length).toBeGreaterThan(0);
  });

  it("a price that makes no sense is refused by the same checks as any signal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE_NOW); // inside trading hours, so it is the price that gets refused
    const w = createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bullish" });
    feed.tick = { t: Date.now(), price: 7720 }; // an SPX-sized price on the NDX bot
    await call(w.token, "");
    await settle();
    expect(decisionsStore.all().map((d) => d.outcome)).toContain("price_out_of_range");
    expect(positionsStore.all()).toHaveLength(0);
  });

  it("an unknown URL and a switched-off webhook both answer 404, the same way", async () => {
    const w = createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bullish" });
    const unknown = await call("0".repeat(48), '{"price":21003.7}');
    updateWebhook(w.id, { active: false });
    const off = await call(w.token, '{"price":21003.7}');
    expect([unknown.status, off.status]).toEqual([404, 404]);
    expect(await unknown.json()).toEqual(await off.json());
    expect(signalsStore.all()).toHaveLength(0);
  });

  it("is ignored when called again within a minute, and the log says why", async () => {
    const w = createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bullish" });
    expect((await call(w.token, '{"price":21003.7}')).status).toBe(200);
    const second = await call(w.token, '{"price":21010}');
    expect(second.status).toBe(200);
    expect((await second.json()).ignored).toMatch(/once a minute/);
    expect(signalsStore.all().map((s) => [s.status, s.rejectReason])).toEqual([["accepted", undefined], ["rejected", "webhook_rate_limited"]]);
    expect(webhooksStore.get(w.id)?.triggerCount).toBe(1);
  });

  it("two different webhooks are limited separately", async () => {
    const a = createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bullish" });
    const b = createWebhook({ name: "B", botId: NDX_BOT_ID, direction: "bearish" });
    await call(a.token, '{"price":21003.7}');
    const r = await call(b.token, '{"price":21003.7}');
    expect(((await r.json()) as { ignored?: string }).ignored).toBeUndefined();
  });

  it("the URL is the only credential: no shared secret is needed, and a body can't pick another bot or signal", async () => {
    const w = createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bullish" });
    await call(w.token, '{"bot":"spx_ema_bias","signal":"bearish","secret":"whatever","test":true}');
    expect(signalsStore.all()[0]).toMatchObject({ botId: NDX_BOT_ID, signal: "bullish" });
    expect(signalsStore.all()[0].raw).not.toHaveProperty("test");
  });
});

describe("a host that can't keep records", () => {
  it("answers 503 with the reason, not a 500", async () => {
    const store = await import("@/lib/automation/store");
    const spy = vi.spyOn(store, "storageProblem").mockReturnValue("This host can't write the bots' records");
    const res = await call("0".repeat(48), '{"price":21003.7}');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/can't write/);
    spy.mockRestore();
  });
});
