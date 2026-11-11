import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BTC_BOT_ID, botDisplayName, ensureBotRecord, getBotStaticConfig, isBuiltInBot, listBotIds } from "./bots";
import { BybitExecutor, type BybitConfig } from "./bybitExecutor";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { getExecutor } from "./sharedExecutor";
import { botsStore, decisionsStore, positionsStore, webhooksStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import { createWebhook, repointWebhook, webhookForTrigger } from "./webhooks";
import { fetchBybitPrice, BYBIT_FEED_URL } from "@/lib/marketData/bybitFeed";
import { fetchPrice } from "@/lib/marketData/tickStore";

/**
 * The BTC Bybit Bot is its own bot. It is the only one whose orders reach Bybit; the NDX Bias Bot has no link to Bybit (it stays on the internal simulation whatever the broker
 * setting and whatever its switch says); BTC signals never make NDX option spreads; the BTC bot's price is Bybit's own.
 */

const RISK = { STOP_LOSS_PERCENT: "1", TAKE_PROFIT_PERCENT: "2", POSITION_SIZE: "0.001", DAILY_MAX_LOSS_USD: "10" };
const fast = { closeConfirmTimeoutMs: 2000, orderFillTimeoutMs: 2000, pollIntervalMs: 5, ladderStepMs: 20 };
let bybit: FakeBybit;
let n = 0;
const alert = (botId: string, direction: "bullish" | "bearish", price: number, symbol: string) => {
  const at = BASE_NOW + ++n * 5 * 60_000; // spread out, so the duplicate guard never hides what is tested
  return receiveAndSaveSignal({ botId, signal: direction, price, barTime: `t-${n}`, interval: "5", raw: { symbol }, now: at });
};
const run = (botId: string, direction: "bullish" | "bearish", price: number, symbol: string) => processSignal(alert(botId, direction, price, symbol), { executor: getExecutor(), now: BASE_NOW + n * 5 * 60_000, ...fast });

beforeEach(() => {
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  setNdxTestEnv();
  vi.stubEnv("BROKER", "bybit");
  vi.stubEnv("EXECUTOR", "");
  for (const [k, v] of Object.entries({ BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET, BYBIT_ALWAYS_ON: "true", BREAKEVEN_TRIGGER_PERCENT: "0", ...RISK })) vi.stubEnv(k, v);
  vi.stubEnv("BYBIT_KILL_SWITCH", "");
  resetAutomationStores();
  bybit = new FakeBybit();
  bybit.clock = () => Date.now();
  vi.stubGlobal("fetch", (url: string, init: Parameters<FakeBybit["fetch"]>[1]) => bybit.fetch(String(url), init));
  ensureBotRecord(NDX_BOT_ID);
  ensureBotRecord(BTC_BOT_ID);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the bot", () => {
  it("is a built-in bot called BTC Bybit Bot, on the BTC underlying, separate from the NDX Bias Bot", () => {
    expect(isBuiltInBot(BTC_BOT_ID)).toBe(true);
    expect(listBotIds()).toEqual(expect.arrayContaining([BTC_BOT_ID, NDX_BOT_ID]));
    expect(botDisplayName(BTC_BOT_ID)).toBe("BTC Bybit Bot");
    expect(botDisplayName(NDX_BOT_ID)).toBe("NDX Bias Bot");
    expect(getBotStaticConfig(BTC_BOT_ID)).toMatchObject({ id: BTC_BOT_ID, name: "BTC Bybit Bot", underlying: "BTC", quantity: 1 });
    expect(getBotStaticConfig(NDX_BOT_ID).underlying).toBe("NDX");
    expect(BTC_BOT_ID).not.toBe(NDX_BOT_ID);
  });
});

describe("only the BTC bot reaches Bybit", () => {
  it("a BTC signal opens a long at Bybit (BTCUSDT) and records a BTC position: no NDX spread is created", async () => {
    await run(BTC_BOT_ID, "bullish", 75_123.4, "BTC");
    expect(bybit.created).toHaveLength(1);
    expect(bybit.created[0].params).toMatchObject({ symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: "0.001" });
    const all = positionsStore.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ botId: BTC_BOT_ID, underlying: "BTC", venue: "bybit", status: "open" });
    expect(all.filter((p) => p.underlying === "NDX")).toEqual([]);
    expect(positionsStore.all().filter((p) => p.botId === NDX_BOT_ID)).toEqual([]);
  });

  it("the NDX Bias Bot runs on the internal simulation: its signal sends NOTHING to Bybit, and its position is a simulated one", async () => {
    await run(NDX_BOT_ID, "bullish", 21_003.7, "NDX");
    expect(bybit.calls).toEqual([]);
    const mine = positionsStore.all().filter((p) => p.botId === NDX_BOT_ID);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ underlying: "NDX", venue: "mock" });
    expect(positionsStore.all().filter((p) => p.venue === "bybit")).toEqual([]);
  });

  it("turning the NDX bot ON (off, then on) and sending it signals never places a Bybit order, a flip included", async () => {
    botsStore.update(NDX_BOT_ID, { enabled: false });
    botsStore.update(NDX_BOT_ID, { enabled: true });
    await run(NDX_BOT_ID, "bullish", 21_003.7, "NDX");
    await run(NDX_BOT_ID, "bearish", 21_010.2, "NDX");
    await run(NDX_BOT_ID, "bullish", 21_020.9, "NDX");
    expect(bybit.calls).toEqual([]);
    expect(bybit.created).toEqual([]);
    expect(positionsStore.all().every((p) => p.venue === "mock")).toBe(true);
  });

  it("the NDX bot and the BTC bot trade side by side without touching each other", async () => {
    await run(BTC_BOT_ID, "bearish", 75_000, "BTC");
    await run(NDX_BOT_ID, "bullish", 21_003.7, "NDX");
    expect(bybit.created.map((c) => c.params.side)).toEqual(["Sell"]); // one order at Bybit: the BTC bot's
    expect(positionsStore.all().find((p) => p.botId === NDX_BOT_ID)?.venue).toBe("mock");
    expect(positionsStore.all().find((p) => p.botId === BTC_BOT_ID)).toMatchObject({ venue: "bybit", underlying: "BTC", type: "short_call_spread" });
    expect(bybit.position.size).toBe(-0.001);
  });

  it("even called directly, the Bybit executor refuses an order for another underlying and sends nothing", async () => {
    const config: BybitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0.12, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 5000 };
    const ex = new BybitExecutor(config, bybit.fetch, () => {});
    await expect(ex.placeOpenOrder({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", expiry: "2026-10-06", positionType: "short_put_spread", shortStrike: 21_000, longStrike: 20_990, quantity: 1, price: 3.5, clientOrderId: "x" } as never)).rejects.toThrow(/BTC Bybit Bot only/);
    expect(bybit.calls).toEqual([]);
    expect(ex.tradingWindowFor("NDX")).toBeNull();
    expect(ex.tradingWindowFor("BTC")).not.toBeNull();
  });

  it("the router says which bot Bybit serves", () => {
    const routed = getExecutor() as unknown as { venueFor(u: string): string };
    expect(routed.venueFor("BTC")).toBe("bybit");
    expect(routed.venueFor("NDX")).toBe("mock");
    expect(routed.venueFor("SPX")).toBe("mock");
  });
});

describe("the BTC bot's price is Bybit's", () => {
  it("BTC is read from Bybit's own ticker (the mark price), not from the Google or Yahoo index feed", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ retCode: 0, result: { list: [{ markPrice: "75123.40", lastPrice: "75120.00" }] } }) };
    });
    expect(await fetchPrice("BTC")).toEqual({ price: 75_123.4, source: "bybit" });
    expect(urls).toEqual([BYBIT_FEED_URL]);
    expect(BYBIT_FEED_URL).toMatch(/^https:\/\/api-demo\.bybit\.com\//); // the demo host only
  });

  it("falls back to the last price when there is no mark price, and gives nothing for a refusal or a broken answer", async () => {
    const answer = (body: unknown, ok = true) => async () => ({ ok, json: async () => body }) as never;
    expect(await fetchBybitPrice(1000, answer({ retCode: 0, result: { list: [{ markPrice: "", lastPrice: "74999.5" }] } }))).toBe(74_999.5);
    expect(await fetchBybitPrice(1000, answer({ retCode: 10016, result: {} }))).toBeNull();
    expect(await fetchBybitPrice(1000, answer({ retCode: 0, result: { list: [] } }))).toBeNull();
    expect(await fetchBybitPrice(1000, answer({}, false))).toBeNull();
    expect(await fetchBybitPrice(1000, (async () => { throw new Error("down"); }) as never)).toBeNull();
  });
});

describe("re-pointing the webhooks", () => {
  it("moves a webhook to the same trigger of the BTC bot, keeping its token, name and URL, and logs both steps (no token in the log)", () => {
    const bull = createWebhook({ name: "Bybit bullish", botId: NDX_BOT_ID, direction: "bullish" });
    const bear = createWebhook({ name: "Bybit bearish", botId: NDX_BOT_ID, direction: "bearish" });
    const tokens = [bull.token, bear.token];
    const a = repointWebhook(bull.id, BTC_BOT_ID);
    const b = repointWebhook(bear.id, BTC_BOT_ID);
    expect(a.changed && b.changed).toBe(true);
    expect(webhooksStore.get(bull.id)).toMatchObject({ botId: BTC_BOT_ID, direction: "bullish", active: true, name: "Bybit bullish", token: tokens[0] });
    expect(webhooksStore.get(bear.id)).toMatchObject({ botId: BTC_BOT_ID, direction: "bearish", active: true, name: "Bybit bearish", token: tokens[1] });
    expect(webhookForTrigger(BTC_BOT_ID, "bullish")?.id).toBe(bull.id);
    expect(webhookForTrigger(NDX_BOT_ID, "bullish")).toBeUndefined();
    expect(webhookForTrigger(NDX_BOT_ID, "bearish")).toBeUndefined();
    const logged = decisionsStore.all().map((d) => d.outcome);
    expect(logged).toEqual(expect.arrayContaining(["webhook_detached", "webhook_attached"]));
    expect(JSON.stringify(decisionsStore.all())).not.toContain(tokens[0]);
    expect(JSON.stringify(decisionsStore.all())).not.toContain(tokens[1]);
  });

  it("is safe to run twice: the second time nothing changes", () => {
    const bull = createWebhook({ name: "Bybit bullish", botId: NDX_BOT_ID, direction: "bullish" });
    repointWebhook(bull.id, BTC_BOT_ID);
    const before = decisionsStore.all().length;
    expect(repointWebhook(bull.id, BTC_BOT_ID).changed).toBe(false);
    expect(decisionsStore.all()).toHaveLength(before);
  });

  it("refuses a webhook that is not attached to a trigger", () => {
    const loose = createWebhook({ name: "Loose" });
    expect(() => repointWebhook(loose.id, BTC_BOT_ID)).toThrow(/not attached/);
  });
});
