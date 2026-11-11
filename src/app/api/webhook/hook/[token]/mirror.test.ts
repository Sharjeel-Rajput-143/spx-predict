import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BTC_BOT_ID, ensureBotRecord } from "@/lib/automation/bots";
import { decisionsStore, positionsStore, signalsStore } from "@/lib/automation/store";
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv } from "@/lib/automation/testSupport";
import { createWebhook } from "@/lib/automation/webhooks";
import { POST } from "./route";

// THE DEMO ANSWER DOES NOT CHANGE when the live side works, fails, throws or hangs, and THE LIVE JOB DOES NOT DEPEND ON THE DEMO JOB (release 7: both start together). The live mirror (liveMirror.ts) is replaced here by one that misbehaves in each way,
// and everything the demo call produces (the HTTP answer, the signal, the decisions, the position) is compared with a run where there is no mirror at all.

const feed = vi.hoisted(() => ({ tick: null as { t: number; price: number } | null }));
vi.mock("@/lib/marketData/tickStore", () => ({ waitForTick: async () => feed.tick, getLastTick: () => feed.tick, isLiveSymbol: () => false, startTickFeed: () => undefined, stopTickFeed: () => undefined }));
const mirror = vi.hoisted(() => ({ impl: null as null | ((arg: Record<string, unknown>) => unknown), calls: [] as Record<string, unknown>[], settled: 0 }));
vi.mock("@/lib/automation/liveMirror", () => ({
  runMirror: (arg: Record<string, unknown>) => {
    mirror.calls.push(arg);
    return mirror.impl ? mirror.impl(arg) : Promise.resolve();
  },
}));

setNdxTestEnv();
const settle = () => new Promise((r) => setTimeout(r, 120));

async function run(impl: null | ((arg: Record<string, unknown>) => unknown), direction: "bullish" | "bearish" = "bullish", botId = BTC_BOT_ID) {
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(botId);
  feed.tick = { t: Date.now(), price: 76_000.5 };
  mirror.impl = impl;
  mirror.calls = [];
  const w = createWebhook({ name: "HookX", botId, direction });
  const t0 = performance.now();
  const res = await POST(new NextRequest(`http://localhost/api/webhook/hook/${w.token}`, { method: "POST", body: `${direction} alert`, headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token: w.token }) });
  const ms = performance.now() - t0;
  const json = await res.json();
  await settle();
  return {
    ms,
    answer: { status: res.status, json },
    signals: signalsStore.query((s) => s.botId === botId).map((s) => [s.signal, s.status, s.price]),
    decisions: decisionsStore.query((d) => d.botId === botId).map((d) => d.outcome),
    positions: positionsStore.query((p) => p.botId === botId).map((p) => [p.type, p.status]),
  };
}
const demoPart = (r: Awaited<ReturnType<typeof run>>) => ({ answer: r.answer, signals: r.signals, decisions: r.decisions, positions: r.positions });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  mirror.impl = null;
});

describe("the demo call is the same whatever the live side does", () => {
  it("baseline: the BTC hook is answered, the demo bot gets its signal, and the live job is handed the SAME price and bar time, with nothing of the demo bot's to wait for", async () => {
    const r = await run(null);
    expect(r.answer.status).toBe(200);
    expect(r.answer.json).toEqual({ received: true });
    expect(r.signals).toEqual([["bullish", "accepted", 76_000.5]]);
    expect(r.positions.length).toBeGreaterThan(0);
    expect(mirror.calls).toHaveLength(1);
    expect(mirror.calls[0]).toMatchObject({ direction: "bullish", price: 76_000.5, hook: { name: "HookX", botId: BTC_BOT_ID } });
    expect(String(mirror.calls[0].barTime)).toMatch(/^[0-9a-f-]+-2026-10-06T14:40$|-2026-10-06T14:40/);
    expect(mirror.calls[0]).not.toHaveProperty("demoDone"); // the live job waits for nothing the demo bot does
  });

  it("a live side that THROWS at once: the answer, signal, decisions and position are identical", async () => {
    const base = await run(null);
    const r = await run(() => {
      throw new Error("live exploded");
    });
    expect(demoPart(r)).toEqual(demoPart(base));
    expect(r.ms).toBeLessThan(base.ms + 300);
  });

  it("a live side that REJECTS: identical", async () => {
    const base = await run(null);
    const r = await run(() => Promise.reject(new Error("live rejected")));
    expect(demoPart(r)).toEqual(demoPart(base));
  });

  it("a live side that HANGS FOR EVER: the answer still goes out at the same speed and everything else is identical", async () => {
    const base = await run(null);
    const r = await run(() => new Promise(() => undefined));
    expect(demoPart(r)).toEqual(demoPart(base));
    expect(r.ms).toBeLessThan(base.ms + 300);
    expect(r.ms).toBeLessThan(1000);
  });

  it("a live side that is SLOW (a second): the answer does not wait for it", async () => {
    const base = await run(null);
    const r = await run(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    expect(demoPart(r)).toEqual(demoPart(base));
    expect(r.ms).toBeLessThan(500);
  });

  it("a bearish hook behaves the same way", async () => {
    const base = await run(null, "bearish");
    const r = await run(() => Promise.reject(new Error("x")), "bearish");
    expect(demoPart(r)).toEqual(demoPart(base));
    expect(r.signals).toEqual([["bearish", "accepted", 76_000.5]]);
  });

  it("a hook that is not the BTC bot's is still handed to the mirror, which ignores it (the decision is the mirror's, the demo call is unchanged)", async () => {
    const base = await run(null, "bullish", NDX_BOT_ID);
    const r = await run(() => {
      throw new Error("x");
    }, "bullish", NDX_BOT_ID);
    expect(demoPart(r)).toEqual(demoPart(base));
  });
});

describe("the live job is independent of the demo job: both start together, each on its own", () => {
  it("the demo executor is misconfigured (the demo job is refused with a 503): the live job is STILL started, and the answer says what the demo side said", async () => {
    vi.stubEnv("BROKER", "nonsense");
    try {
      const r = await run(null);
      expect(r.answer.status).toBe(503);
      expect(mirror.calls).toHaveLength(1);
      expect(mirror.calls[0]).toMatchObject({ direction: "bullish", price: 76_000.5, hook: { botId: BTC_BOT_ID } });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("the demo job THROWS while its signal is saved: the live job was started first, and TradingView hears a 500 built from the demo side alone", async () => {
    const real = signalsStore.insert.bind(signalsStore);
    const spy = vi.spyOn(signalsStore, "insert").mockImplementation(((row: { botId: string }) => {
      if (row.botId === BTC_BOT_ID) throw new Error("demo disk broke");
      return real(row as never);
    }) as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const r = await run(null);
      expect(r.answer.status).toBe(500);
      expect(mirror.calls).toHaveLength(1);
    } finally {
      spy.mockRestore();
      log.mockRestore();
    }
  });
  it("the demo bot is OFF, in error, tripped or killed: its alert is still accepted (200), so the live job is started, and what the demo bot does with it is its own business", async () => {
    for (const patch of [{ enabled: false }, { needsAttention: true, needsAttentionReason: "error" }, { killSwitch: true }, { riskTrip: { day: "2026-10-06", reason: "daily_loss_limit_reached", at: BASE_NOW } as never }]) {
      resetAutomationStores();
      setNdxTestEnv();
      ensureBotRecord(BTC_BOT_ID);
      const { botsStore } = await import("@/lib/automation/store");
      botsStore.update(BTC_BOT_ID, patch);
      feed.tick = { t: Date.now(), price: 76_000.5 };
      mirror.impl = null;
      mirror.calls = [];
      const w = createWebhook({ name: "HookX", botId: BTC_BOT_ID, direction: "bullish" });
      const res = await POST(new NextRequest(`http://localhost/api/webhook/hook/${w.token}`, { method: "POST", body: "bullish alert", headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token: w.token }) });
      await settle();
      expect(res.status, JSON.stringify(patch)).toBe(200);
      expect(mirror.calls, JSON.stringify(patch)).toHaveLength(1);
    }
  });
  it("what both jobs share stays shared, on purpose: a hook that is switched off, or an alert refused, reaches neither bot", async () => {
    resetAutomationStores();
    setNdxTestEnv();
    ensureBotRecord(BTC_BOT_ID);
    feed.tick = { t: Date.now(), price: 76_000.5 };
    mirror.calls = [];
    const w = createWebhook({ name: "HookY", botId: BTC_BOT_ID, direction: "bullish" });
    const { webhooksStore } = await import("@/lib/automation/store");
    webhooksStore.update(w.id, { active: false });
    const off = await POST(new NextRequest(`http://localhost/api/webhook/hook/${w.token}`, { method: "POST", body: "bullish alert", headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token: w.token }) });
    expect(off.status).toBe(404);
    webhooksStore.update(w.id, { active: true });
    const wrongText = await POST(new NextRequest(`http://localhost/api/webhook/hook/${w.token}`, { method: "POST", body: "bearish alert", headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token: w.token }) });
    expect(wrongText.status).toBe(422);
    await settle();
    expect(mirror.calls).toHaveLength(0);
  });
});
