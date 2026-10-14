import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NDX and SPX alerts arriving at the same moment. TradingView must get an answer from both at once, and both bots must finish their
// trade correctly: neither lost, neither mixed up with the other. Two paths are checked, as they run in real life:
//  - a server that stays up (records in files): the bots are independent, a slow fill on one never holds the other up;
//  - Vercel (records in a database): one queue per instance, so the second bot waits for the first to finish - never lost, never refused.
// No network; nothing touches a real webhook or broker.

const BASE_NOW = Date.UTC(2026, 9, 6, 14, 40); // Tuesday 10:40am New York
const NDX = "ndx_ema_bias";
const SPX = "spx_ema_bias";

let dir: string;
let url: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "two-bots-"));
  url = `file:${path.join(dir, "db.sqlite")}`;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.resetModules();
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function boot(remote: boolean, slow: { ndxFillMs?: number; spxFillMs?: number } = {}) {
  vi.resetModules();
  if (remote) {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("TURSO_DB_URL", url);
    vi.stubEnv("TURSO_DB_TOKEN", "test-token");
  } else {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TURSO_DB_URL", "");
    vi.stubEnv("AUTOMATION_DATA_DIR", dir);
  }
  vi.stubEnv("AUTOMATION_STORAGE", "");
  vi.stubEnv("EXECUTOR", "mock");
  vi.stubEnv("BROKER", "");
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
  vi.stubEnv("AUTOMATION_DRY_RUN", "");
  vi.stubEnv("BOT_SPX_EMA_BIAS_HIDDEN", "false");
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  vi.doMock("@/lib/marketData/tickStore", () => ({ waitForTick: async (s: string) => ({ t: Date.now(), price: s === "SPX" ? 7805.45 : 21_003.7 }), getLastTick: () => null, isLiveSymbol: () => false }));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_NOW);

  const store = await import("../store");
  const { POST: hook } = await import("@/app/api/webhook/hook/[token]/route");
  const { createWebhook, attachWebhook } = await import("../webhooks");
  const { ensureBotRecord } = await import("../bots");
  const { setNdxTestEnv } = await import("../testSupport");
  const { getExecutor } = await import("../sharedExecutor");
  setNdxTestEnv();
  ensureBotRecord(NDX);
  ensureBotRecord(SPX);
  const hooks: Record<string, { token: string }> = {};
  for (const [name, bot, dir_] of [["BullishNDX", NDX, "bullish"], ["BearishNDX", NDX, "bearish"], ["BullishSPX", SPX, "bullish"], ["BearishSPX", SPX, "bearish"]] as const) {
    const h = createWebhook({ name, botId: null, direction: null });
    attachWebhook(h.id, bot, dir_);
    hooks[name] = h;
  }
  await store.storage.flush?.();
  const broker = getExecutor() as unknown as { queueScenario(bot: string, s: unknown): void };
  if (slow.ndxFillMs) broker.queueScenario(NDX, { kind: "delayed", delayMs: slow.ndxFillMs });
  if (slow.spxFillMs) broker.queueScenario(SPX, { kind: "delayed", delayMs: slow.spxFillMs });

  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  /** One TradingView call; resolves with how long TradingView waited for its answer, and what the answer was. */
  const fire = async (name: string, text: string) => {
    const h = hooks[name];
    const res = await hook(new NextRequest(`http://localhost/api/webhook/hook/${h.token}`, { method: "POST", body: text, headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token: h.token }) });
    return { status: res.status, answeredAt: ms() };
  };
  /** When each bot's position first showed as open (ms since the alerts), waiting up to `limit`. */
  const watch = async (bots: string[], limit = 15_000) => {
    const at: Record<string, number> = {};
    while (bots.some((b) => at[b] === undefined) && ms() < limit) {
      for (const p of store.positionsStore.all()) if (p.status === "open" && at[p.botId] === undefined && bots.includes(p.botId)) at[p.botId] = ms();
      await new Promise((r) => setTimeout(r, 20));
    }
    return at;
  };
  const positions = (bot: string) => store.positionsStore.all().filter((p) => p.botId === bot);
  const outcomes = (bot: string) => store.decisionsStore.all().filter((d) => d.botId === bot && d.signalId !== null).map((d) => d.outcome);
  return { store, fire, watch, positions, outcomes, ms };
}

describe("a server that stays up (records in files): the bots never wait for each other", () => {
  it("a slow NDX fill does not hold SPX up: SPX is open long before NDX is", async () => {
    const t = await boot(false, { ndxFillMs: 3000 });
    const [ndx, spx] = await Promise.all([t.fire("BullishNDX", "bullish"), t.fire("BullishSPX", "bullish")]);
    expect([ndx.status, spx.status]).toEqual([200, 200]);
    expect(Math.max(ndx.answeredAt, spx.answeredAt)).toBeLessThan(600); // TradingView is answered at once
    const open = await t.watch([NDX, SPX]);
    expect(open[SPX]).toBeLessThan(1500);
    expect(open[NDX]).toBeGreaterThanOrEqual(2900);
    expect(open[SPX]).toBeLessThan(open[NDX] / 2);
    expect(t.outcomes(NDX)).toEqual(["opened"]);
    expect(t.outcomes(SPX)).toEqual(["opened"]);
  }, 30_000);

  it("and the other way round: a slow SPX fill does not hold NDX up", async () => {
    const t = await boot(false, { spxFillMs: 3000 });
    await Promise.all([t.fire("BullishNDX", "bullish"), t.fire("BullishSPX", "bullish")]);
    const open = await t.watch([NDX, SPX]);
    expect(open[NDX]).toBeLessThan(1500);
    expect(open[SPX]).toBeGreaterThanOrEqual(2900);
  }, 30_000);

  it("opposite directions at the same moment: each bot gets its own trade, on its own underlying", async () => {
    const t = await boot(false);
    await Promise.all([t.fire("BullishNDX", "bullish"), t.fire("BearishSPX", "bearish")]);
    await t.watch([NDX, SPX]);
    const [n] = t.positions(NDX);
    const [s] = t.positions(SPX);
    expect([n.type, n.underlying, n.status]).toEqual(["short_put_spread", "NDX", "open"]);
    expect([s.type, s.underlying, s.status]).toEqual(["short_call_spread", "SPX", "open"]);
    expect(n.shortStrike).toBeGreaterThan(20_000); // NDX strikes come from NDX's price, never SPX's
    expect(s.shortStrike).toBeGreaterThan(7_000);
    expect(s.shortStrike).toBeLessThan(8_500);
    expect(t.positions(NDX)).toHaveLength(1);
    expect(t.positions(SPX)).toHaveLength(1);
  }, 30_000);

  it("a flip on one bot while the other opens: both finish, nothing crossed", async () => {
    const t = await boot(false);
    await t.fire("BullishNDX", "bullish");
    await t.watch([NDX]);
    vi.setSystemTime(BASE_NOW + 2 * 60_000);
    await Promise.all([t.fire("BearishNDX", "bearish"), t.fire("BullishSPX", "bullish")]);
    for (let i = 0; i < 300 && !(t.positions(SPX)[0]?.status === "open" && t.positions(NDX).filter((p) => p.status === "open")[0]?.type === "short_call_spread"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(t.positions(NDX).map((p) => [p.type, p.status])).toEqual([["short_put_spread", "closed"], ["short_call_spread", "open"]]);
    expect(t.positions(SPX).map((p) => [p.type, p.status])).toEqual([["short_put_spread", "open"]]);
  }, 30_000);
});

describe("Vercel (records in a database): both are answered at once and both finish, the second after the first", () => {
  it("normal (instant) fills: both answered, both open within a couple of seconds", async () => {
    const t = await boot(true);
    const [ndx, spx] = await Promise.all([t.fire("BullishNDX", "bullish"), t.fire("BullishSPX", "bullish")]);
    expect([ndx.status, spx.status]).toEqual([200, 200]);
    expect(Math.max(ndx.answeredAt, spx.answeredAt)).toBeLessThan(1500); // inside TradingView's limit
    const open = await t.watch([NDX, SPX]);
    expect(Math.max(open[NDX], open[SPX])).toBeLessThan(5000);
    expect(t.outcomes(NDX)).toEqual(["opened"]);
    expect(t.outcomes(SPX)).toEqual(["opened"]);
  }, 30_000);

  it("a slow NDX fill: TradingView still gets both answers in time, and SPX is not lost - it goes through once NDX is done", async () => {
    const t = await boot(true, { ndxFillMs: 2000 });
    const [ndx, spx] = await Promise.all([t.fire("BullishNDX", "bullish"), t.fire("BullishSPX", "bullish")]);
    expect([ndx.status, spx.status]).toEqual([200, 200]);
    expect(Math.max(ndx.answeredAt, spx.answeredAt)).toBeLessThan(1500);
    const open = await t.watch([NDX, SPX]);
    expect(open[NDX]).toBeDefined();
    expect(open[SPX]).toBeDefined(); // neither dropped
    expect(t.positions(NDX)).toHaveLength(1);
    expect(t.positions(SPX)).toHaveLength(1);
    expect(t.positions(SPX)[0].underlying).toBe("SPX");
  }, 30_000);

  it("opposite directions at the same moment: each bot gets its own trade, on its own underlying", async () => {
    const t = await boot(true);
    await Promise.all([t.fire("BearishNDX", "bearish"), t.fire("BullishSPX", "bullish")]);
    await t.watch([NDX, SPX]);
    expect(t.positions(NDX).map((p) => [p.type, p.underlying])).toEqual([["short_call_spread", "NDX"]]);
    expect(t.positions(SPX).map((p) => [p.type, p.underlying])).toEqual([["short_put_spread", "SPX"]]);
  }, 30_000);
});
