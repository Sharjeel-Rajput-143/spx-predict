import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The bot as it runs on Vercel: the records live in a database (a local SQLite file here, the same client Turso uses), every call
// lands on a "cold instance" with nothing in memory, the answer goes out first, and the decision is made behind it. These tests run
// the flip and the guards on that path, and read the result back from the database itself - what a person would find there.
// No network, and nothing touches a real webhook or broker.

const BASE_NOW = Date.UTC(2026, 9, 6, 14, 40); // Tuesday 10:40am New York
const MIN = 60_000;

let dir: string;
let url: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "turso-guards-"));
  url = `file:${path.join(dir, "db.sqlite")}`;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.resetModules();
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Rec {
  id: string;
  [k: string]: unknown;
}

async function boot(options: { price?: number; env?: Record<string, string> } = {}) {
  vi.resetModules();
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("AUTOMATION_STORAGE", "");
  vi.stubEnv("TURSO_DB_URL", url);
  vi.stubEnv("TURSO_DB_TOKEN", "test-token");
  vi.stubEnv("EXECUTOR", "mock");
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
  vi.stubEnv("AUTOMATION_DRY_RUN", "");
  for (const [k, v] of Object.entries(options.env ?? {})) vi.stubEnv(k, v);
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  const price = options.price ?? 21_003.7;
  vi.doMock("@/lib/marketData/tickStore", () => ({ waitForTick: async () => ({ t: Date.now(), price }), getLastTick: () => null, isLiveSymbol: () => false }));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_NOW - 2 * MIN);

  const { storage } = await import("../store");
  expect(storage.remote).toBe(true);
  const { POST: hook } = await import("@/app/api/webhook/hook/[token]/route");
  const { GET: barrier } = await import("@/app/api/automation/webhooks/route");
  const { createWebhook, attachWebhook } = await import("../webhooks");
  const { ensureBotRecord } = await import("../bots");
  const { setNdxTestEnv } = await import("../testSupport");
  setNdxTestEnv();
  ensureBotRecord("ndx_ema_bias");
  const bull = createWebhook({ name: "BullishNDX", botId: null, direction: null });
  attachWebhook(bull.id, "ndx_ema_bias", "bullish");
  const bear = createWebhook({ name: "BearishNDX", botId: null, direction: null });
  attachWebhook(bear.id, "ndx_ema_bias", "bearish");
  await storage.flush?.();

  const { createClient } = await import("@libsql/client");
  const db = createClient({ url });
  /** What is really in the database for one collection. */
  const rows = async (collection: string): Promise<Rec[]> => (await db.execute({ sql: "SELECT json FROM records WHERE collection = ? ORDER BY rowid", args: [collection] })).rows.map((r) => JSON.parse(String(r.json)) as Rec);

  let clock = BASE_NOW - 2 * MIN;
  /** One alert on a cold instance, at a fresh minute (or `at`), waiting until the bot has finished behind its answer and everything is saved. */
  async function alert(hook_: { token: string }, text: string, at?: number) {
    clock = at ?? clock + 2 * MIN;
    vi.setSystemTime(clock);
    storage.dropCaches?.(); // a new serverless instance: nothing in memory
    const res = await hook(new NextRequest(`http://localhost/api/webhook/hook/${hook_.token}`, { method: "POST", body: text, headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token: hook_.token }) });
    // Anything that asks next waits its turn behind the work still going on, then everything has been saved.
    await barrier(new NextRequest("http://localhost/api/automation/webhooks", { method: "GET" }));
    return res;
  }
  const positions = async () => (await rows("positions")).filter((p) => p.botId === "ndx_ema_bias");
  const active = async () => (await positions()).filter((p) => ["open", "opening", "closing"].includes(String(p.status)));
  const outcomes = async () => (await rows("decisions")).filter((d) => d.signalId !== null).map((d) => String(d.outcome));
  const bot = async () => (await rows("bots")).find((b) => b.id === "ndx_ema_bias")!;
  const orders = async () => (await rows("orders")).map((o) => `${o.kind}:${o.status}`);
  return { storage, alert, rows, positions, active, outcomes, bot, orders, bull, bear, at: (ms: number) => ms };
}

describe("the flip, on Vercel's path", () => {
  it("Bullish opens a put spread and it is in the database, fully filled; the answer was a plain 200", async () => {
    const t = await boot();
    const res = await t.alert(t.bull, "bullish");
    expect(res.status).toBe(200);
    expect((await t.positions()).map((p) => [p.type, p.status, p.filledQuantity])).toEqual([["short_put_spread", "open", 1]]);
    expect(await t.orders()).toEqual(["open:filled"]);
    expect(await t.outcomes()).toEqual(["opened"]);
  });

  it("each call on a cold instance: bull, bear, bull flips cleanly, one position at a time, every order saved", async () => {
    const t = await boot();
    for (const [hook, word, want] of [[t.bull, "bullish", "short_put_spread"], [t.bear, "bearish", "short_call_spread"], [t.bull, "bullish", "short_put_spread"]] as const) {
      await t.alert(hook, word);
      const now = await t.active();
      expect(now.map((p) => p.type)).toEqual([want]);
      expect(now[0].status).toBe("open");
    }
    expect(await t.orders()).toEqual(["open:filled", "close:filled", "open:filled", "close:filled", "open:filled"]);
    expect((await t.positions()).map((p) => p.status)).toEqual(["closed", "closed", "open"]);
    expect(await t.outcomes()).toEqual(["opened", "closed", "opened", "closed", "opened"]);
  });

  it("the same side again opens nothing and sends no order", async () => {
    const t = await boot();
    await t.alert(t.bull, "bullish");
    await t.alert(t.bull, "bullish");
    expect((await t.positions())).toHaveLength(1);
    expect(await t.orders()).toEqual(["open:filled"]);
    expect(await t.outcomes()).toEqual(["opened", "already_in_position"]);
  });

  it("both alerts arriving at the very same moment are handled one after the other: never a put and a call held together", async () => {
    const t = await boot();
    await t.alert(t.bull, "bullish");
    // TradingView fires both at once (it should not, but the platform must stay consistent if it does).
    vi.setSystemTime(BASE_NOW + 5 * MIN);
    const { POST: hook } = await import("@/app/api/webhook/hook/[token]/route");
    const { GET: barrier } = await import("@/app/api/automation/webhooks/route");
    const call = (h: { token: string }, w: string) => hook(new NextRequest(`http://localhost/api/webhook/hook/${h.token}`, { method: "POST", body: w }), { params: Promise.resolve({ token: h.token }) });
    const answers = await Promise.all([call(t.bear, "bearish"), call(t.bull, "bullish")]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]); // both answered
    await barrier(new NextRequest("http://localhost/api/automation/webhooks", { method: "GET" })); // waits behind the work, then everything is saved
    const now = await t.active();
    expect(now.length).toBeLessThanOrEqual(1);
    expect(new Set(now.map((p) => p.type)).size).toBeLessThanOrEqual(1);
    // every order that was sent was filled and every position row is settled (nothing stuck half-way)
    expect((await t.orders()).every((o) => o.endsWith(":filled"))).toBe(true);
    expect((await t.positions()).every((p) => p.status === "open" || p.status === "closed")).toBe(true);
  });
});

describe("the guards, on Vercel's path", () => {
  it("an alert outside the trading window trades nothing and is logged", async () => {
    const t = await boot();
    await t.alert(t.bull, "bullish", Date.UTC(2026, 9, 6, 22, 0)); // 6pm New York
    expect(await t.positions()).toHaveLength(0);
    expect(await t.orders()).toEqual([]);
    expect(await t.outcomes()).toEqual(["outside_hours"]);
  });

  it("a price outside the range is refused", async () => {
    const t = await boot({ price: 7_700 });
    await t.alert(t.bull, "bullish");
    expect(await t.positions()).toHaveLength(0);
    expect(await t.outcomes()).toEqual(["price_out_of_range"]);
  });

  it("an alert whose words disagree with its address is refused with a 422, saved as rejected, and nothing trades", async () => {
    const t = await boot();
    const res = await t.alert(t.bull, "NDX bearish signal");
    expect(res.status).toBe(422);
    expect(await t.positions()).toHaveLength(0);
    expect((await t.rows("signals")).at(-1)).toMatchObject({ status: "rejected", rejectReason: "alert_text_mismatch" });
    // and the right alert a moment later still goes through
    await t.alert(t.bull, "bullish");
    expect((await t.active()).map((p) => p.type)).toEqual(["short_put_spread"]);
  });

  it("the once-a-minute limit holds across cold instances: the minute taken by one is respected by the next", async () => {
    const t = await boot();
    await t.alert(t.bull, "bullish");
    await t.alert(t.bull, "bullish", BASE_NOW - 2 * MIN + 2 * MIN + 20_000); // 20 seconds later, on another instance
    const signals = await t.rows("signals");
    expect(signals.filter((s) => s.rejectReason === "webhook_rate_limited")).toHaveLength(1);
    expect((await t.positions())).toHaveLength(1);
  });

  it("the kill switch, saved in the database, stops a later call on a fresh instance, closes included", async () => {
    const t = await boot();
    await t.alert(t.bull, "bullish");
    t.storage.dropCaches?.();
    await t.storage.hydrate?.();
    const { botsStore } = await import("../store");
    botsStore.update("ndx_ema_bias", { killSwitch: true });
    await t.storage.flush?.();
    await t.alert(t.bear, "bearish");
    expect(await t.orders()).toEqual(["open:filled"]); // nothing new
    expect((await t.active()).map((p) => p.type)).toEqual(["short_put_spread"]);
    expect((await t.outcomes()).at(-1)).toBe("kill_switch");
  });

  it("the daily limit counts across instances and switches the bot off, saved, with a reason", async () => {
    const t = await boot();
    t.storage.dropCaches?.();
    await t.storage.hydrate?.();
    const { botsStore } = await import("../store");
    botsStore.update("ndx_ema_bias", { safeguards: { dailyNewPositionLimit: 2 } });
    await t.storage.flush?.();
    await t.alert(t.bull, "bullish");
    await t.alert(t.bear, "bearish");
    await t.alert(t.bull, "bullish"); // the third new position
    expect((await t.orders()).filter((o) => o.startsWith("open"))).toHaveLength(2);
    expect((await t.outcomes()).at(-1)).toBe("daily_limit_reached");
    expect(await t.bot()).toMatchObject({ enabled: false, needsAttention: true });
    expect(await t.active()).toHaveLength(0);
  });

  it("a switched-off bot stays off on the next instance and opens nothing", async () => {
    const t = await boot();
    t.storage.dropCaches?.();
    await t.storage.hydrate?.();
    const { botsStore } = await import("../store");
    botsStore.update("ndx_ema_bias", { enabled: false });
    await t.storage.flush?.();
    await t.alert(t.bull, "bullish");
    expect(await t.positions()).toHaveLength(0);
    expect(await t.outcomes()).toEqual(["automations_off"]);
  });
});
