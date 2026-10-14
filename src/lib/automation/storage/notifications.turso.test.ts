import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The bell on Vercel's path: the records live in a database (a local SQLite file here, the same client Turso uses), each call lands on a
// "cold instance" with nothing in memory, and what a person reads back is what the database really holds. No network, and nothing
// touches a real webhook or broker.

const BASE_NOW = Date.UTC(2026, 9, 6, 14, 40);
const MIN = 60_000;

let dir: string;
let url: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "turso-bell-"));
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

async function boot() {
  vi.resetModules();
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("AUTOMATION_STORAGE", "");
  vi.stubEnv("TURSO_DB_URL", url);
  vi.stubEnv("TURSO_DB_TOKEN", "test-token");
  vi.stubEnv("EXECUTOR", "mock");
  vi.stubEnv("BROKER", "");
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
  vi.stubEnv("AUTOMATION_DRY_RUN", "");
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  vi.doMock("@/lib/marketData/tickStore", () => ({ waitForTick: async () => ({ t: Date.now(), price: 21_003.7 }), getLastTick: () => null, isLiveSymbol: () => false }));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_NOW - 2 * MIN);

  const { storage } = await import("../store");
  expect(storage.remote).toBe(true);
  const { POST: hook } = await import("@/app/api/webhook/hook/[token]/route");
  const { GET: barrier } = await import("@/app/api/automation/webhooks/route");
  const bell = await import("@/app/api/automation/notifications/route");
  const { createWebhook, attachWebhook } = await import("../webhooks");
  const { ensureBotRecord } = await import("../bots");
  const { setNdxTestEnv } = await import("../testSupport");
  const { getExecutor } = await import("../sharedExecutor");
  setNdxTestEnv();
  ensureBotRecord("ndx_ema_bias");
  const bull = createWebhook({ name: "BullishNDX", botId: null, direction: null });
  attachWebhook(bull.id, "ndx_ema_bias", "bullish");
  await storage.flush?.();

  const { createClient } = await import("@libsql/client");
  const db = createClient({ url });
  const rows = async (collection: string): Promise<Rec[]> => (await db.execute({ sql: "SELECT json FROM records WHERE collection = ? ORDER BY rowid", args: [collection] })).rows.map((r) => JSON.parse(String(r.json)) as Rec);

  let clock = BASE_NOW - 2 * MIN;
  async function alert(text: string) {
    clock += 2 * MIN;
    vi.setSystemTime(clock);
    storage.dropCaches?.(); // a new serverless instance: nothing in memory
    await hook(new NextRequest(`http://localhost/api/webhook/hook/${bull.token}`, { method: "POST", body: text, headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token: bull.token }) });
    await barrier(new NextRequest("http://localhost/api/automation/webhooks", { method: "GET" })); // waits behind the work, then everything is saved
  }
  const call = async (method: "GET" | "PATCH" | "DELETE", body?: unknown) => {
    storage.dropCaches?.(); // and a different cold instance for the bell's own call
    const req = new NextRequest("http://localhost/api/automation/notifications", { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
    const handler = bell[method];
    const res = await handler(req);
    return { status: res.status, body: await res.json() };
  };
  return { alert, call, rows, executor: getExecutor() as unknown as { queueScenario(bot: string, s: unknown): void } };
}

describe("a failure on Vercel's path reaches the bell", () => {
  it("a rejected open is saved as an error notification in the database, and a cold instance's bell shows it", async () => {
    const t = await boot();
    t.executor.queueScenario("ndx_ema_bias", { kind: "reject", reason: "Insufficient margin" });
    await t.alert("bullish");
    const saved = await t.rows("notifications");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ severity: "error", outcome: "open_rejected", botId: "ndx_ema_bias", readAt: null, repeats: 1 });
    expect(String(saved[0].message)).toContain("Insufficient margin");

    const list = await t.call("GET");
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ unread: 1, total: 1 });
    expect(list.body.notifications[0]).toMatchObject({ severity: "error", botName: "NDX Bias Bot", link: expect.stringContaining("/automation/bots/ndx_ema_bias?tab=") });
  });

  it("mark as read, mark all, and clear are saved in the database", async () => {
    const t = await boot();
    t.executor.queueScenario("ndx_ema_bias", { kind: "reject", reason: "one" });
    await t.alert("bullish");
    t.executor.queueScenario("ndx_ema_bias", { kind: "reject", reason: "two" });
    await t.alert("bullish");
    expect((await t.rows("notifications")).map((n) => n.readAt)).toEqual([null, null]);

    const [first] = (await t.call("GET")).body.notifications;
    expect((await t.call("PATCH", { ids: [first.id] })).body).toMatchObject({ changed: 1, unread: 1 });
    expect((await t.rows("notifications")).filter((n) => n.readAt !== null)).toHaveLength(1);

    expect((await t.call("PATCH", { all: true })).body).toMatchObject({ changed: 1, unread: 0 });
    expect((await t.rows("notifications")).every((n) => typeof n.readAt === "number")).toBe(true);

    expect((await t.call("DELETE", { ids: [first.id] })).body).toMatchObject({ removed: 1, total: 1 });
    expect(await t.rows("notifications")).toHaveLength(1);
    expect((await t.call("DELETE", { all: true })).body).toMatchObject({ removed: 1, total: 0 });
    expect(await t.rows("notifications")).toHaveLength(0);
  });

  it("the same rejection repeated is one saved row that counts its repeats", async () => {
    const t = await boot();
    for (let i = 0; i < 3; i++) {
      t.executor.queueScenario("ndx_ema_bias", { kind: "reject", reason: "Insufficient margin" });
      await t.alert("bullish");
    }
    const saved = await t.rows("notifications");
    expect(saved).toHaveLength(1);
    expect(saved[0].repeats).toBe(3);
  });

  it("a normal open saves no notification at all, and the bell stays empty", async () => {
    const t = await boot();
    await t.alert("bullish");
    expect(await t.rows("notifications")).toHaveLength(0);
    expect((await t.call("GET")).body).toMatchObject({ total: 0, unread: 0 });
  });
});
