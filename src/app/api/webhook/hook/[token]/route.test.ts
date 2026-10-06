import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebhook, deleteWebhook, findWebhookByToken, parseHookBody, updateWebhook } from "@/lib/automation/webhooks";
import { createEmptyBot, deleteBot, ensureBotRecord } from "@/lib/automation/bots";
import { decisionsStore, positionsStore, signalsStore, webhooksStore } from "@/lib/automation/store";
import { BASE_NOW, NDX_BOT_ID, TEST_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "@/lib/automation/testSupport";
import { GET as list, POST as create } from "../../../automation/webhooks/route";
import { DELETE as remove, PATCH as patch } from "../../../automation/webhooks/[id]/route";
import { POST } from "./route";

// Named webhooks, through the route handlers, on the mock executor. No network.

setTestBotEnv();
setNdxTestEnv();

const call = (token: string, body?: string) => POST(new NextRequest(`http://localhost/api/webhook/hook/${token}`, { method: "POST", body, headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token }) });
const settle = () => new Promise((r) => setTimeout(r, 80));

beforeEach(() => {
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
    expect(findWebhookByToken(w.token.slice(0, -1) + "0")).toBeUndefined();
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
  it("a bullish webhook with the price in the message becomes a bullish signal for its bot, with that bot's own symbol", async () => {
    const w = createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
    const res = await call(w.token, '{"price":21003.7,"bar_time":"2026-10-06T14:40:00Z","interval":"5"}');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true });
    const [signal] = signalsStore.all();
    expect(signal).toMatchObject({ botId: NDX_BOT_ID, signal: "bullish", price: 21_003.7, barTime: "2026-10-06T14:40:00Z", interval: "5", status: "accepted" });
    expect((signal.raw as { symbol: string }).symbol).toBe("NDX");
    await settle();
    expect(decisionsStore.all().length).toBeGreaterThan(0); // the engine ran it through its decisions
    expect(webhooksStore.get(w.id)).toMatchObject({ triggerCount: 1 });
    expect(webhooksStore.get(w.id)?.lastTriggeredAt).toBeGreaterThan(0);
  });

  it("a bearish webhook is a bearish signal", async () => {
    const w = createWebhook({ name: "BearishSPX", botId: TEST_BOT_ID, direction: "bearish" });
    await call(w.token, '{"price":7720.5}');
    expect(signalsStore.all()[0]).toMatchObject({ botId: TEST_BOT_ID, signal: "bearish", price: 7720.5 });
  });

  it("the message can be just a number, a quoted number, or use `close`", async () => {
    for (const [i, body] of ['21003.7', '"21,003.7"', '{"close":"21003.7"}'].entries()) {
      resetAutomationStores();
      const w = createWebhook({ name: `H${i}`, botId: NDX_BOT_ID, direction: "bullish" });
      expect((await call(w.token, body)).status, body).toBe(200);
      expect(signalsStore.all()[0].price, body).toBe(21_003.7);
    }
  });

  it("with no price anywhere (and no fresh quote) it is refused with a message, and nothing is saved", async () => {
    const w = createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bullish" });
    const res = await call(w.token, "");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No price/);
    expect((await call(w.token, '{"bar_time":"x"}')).status).toBe(400);
    expect(signalsStore.all()).toHaveLength(0);
    expect(webhooksStore.get(w.id)?.triggerCount).toBe(0);
  });

  it("a price that makes no sense is refused by the same checks as any signal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE_NOW); // inside trading hours, so it is the price that gets refused
    const w = createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bullish" });
    await call(w.token, '{"price":7720}'); // an SPX-sized price on the NDX bot
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
    await call(w.token, '{"price":21003.7,"bot":"spx_ema_bias","signal":"bearish","secret":"whatever","test":true}');
    expect(signalsStore.all()[0]).toMatchObject({ botId: NDX_BOT_ID, signal: "bullish" });
    expect(signalsStore.all()[0].raw).not.toHaveProperty("test");
  });
});

describe("parsing the message", () => {
  it.each([
    ['{"price":21003.7,"bar_time":"t","interval":"5"}', { price: 21_003.7, barTime: "t", interval: "5" }],
    ['{"price":"21,003.7"}', { price: 21_003.7, barTime: null, interval: null }],
    ['{"price":5,"interval":15}', { price: 5, barTime: null, interval: "15" }],
    ["21003.7", { price: 21_003.7, barTime: null, interval: null }],
    ["", { price: null, barTime: null, interval: null }],
    ["Bullish crossing", { price: null, barTime: null, interval: null }],
    ['{"price":"abc"}', { price: null, barTime: null, interval: null }],
    ["[1,2]", { price: null, barTime: null, interval: null }],
  ])("%s", (body, expected) => {
    expect(parseHookBody(body)).toEqual(expected);
  });
});

describe("managing webhooks through the API", () => {
  const json = (method: string, body?: unknown) => new NextRequest("http://localhost/api/automation/webhooks", { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("creates, lists (newest first, with the bot's name, symbol and URL path), switches off and deletes", async () => {
    ensureBotRecord(NDX_BOT_ID);
    const made = await create(json("POST", { name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" }));
    expect(made.status).toBe(201);
    const hook = (await made.json()).webhook;
    expect(hook).toMatchObject({ name: "BullishNDX", botName: "NDX EMA 9/20 Bias", underlying: "NDX", path: `/api/webhook/hook/${hook.token}` });

    await create(json("POST", { name: "BearishNDX", botId: NDX_BOT_ID, direction: "bearish" }));
    expect((await (await list(json("GET"))).json()).webhooks.map((w: { name: string }) => w.name)).toEqual(["BearishNDX", "BullishNDX"]);

    expect((await patch(json("PATCH", { active: false }), ctx(hook.id))).status).toBe(200);
    expect((await call(hook.token, '{"price":21003.7}')).status).toBe(404);

    expect((await remove(json("DELETE"), ctx(hook.id))).status).toBe(200);
    expect(webhooksStore.get(hook.id)).toBeUndefined();
    expect((await remove(json("DELETE"), ctx(hook.id))).status).toBe(400);
  });

  it("says what's wrong with a bad request", async () => {
    const res = await create(json("POST", { name: "", botId: NDX_BOT_ID, direction: "bullish" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name/);
    expect(deleteWebhook).toBeDefined();
  });
});
