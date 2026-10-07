import { beforeEach, describe, expect, it } from "vitest";
import { checkInterruptedRuns, INTERRUPTED_AFTER_MS } from "./interrupted";
import { alertsStore, botsStore, decisionsStore, positionsStore, runsStore, signalsStore, webhooksStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import { ensureBotRecord } from "./bots";

// A run the server stopped partway through is noticed and said once; a run that only took a while is left alone.

setTestBotEnv();
setNdxTestEnv();

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(NDX_BOT_ID);
});

const signal = (id: string, ageMs: number, extra: Partial<Parameters<typeof signalsStore.insert>[0]> = {}) =>
  signalsStore.insert({ id, botId: NDX_BOT_ID, signal: "bullish", barTime: "b", price: 21_000, interval: "", receivedAt: BASE_NOW - ageMs, status: "accepted", raw: {}, ...extra });

describe("a run that never finished", () => {
  it("a flip that closed one side and never opened the other is said so, in the Log, as an error alert, and on the bot", async () => {
    signal("s1", INTERRUPTED_AFTER_MS + 60_000);
    positionsStore.insert({ ...buildPosition({ type: "short_call_spread", status: "closed", botId: NDX_BOT_ID, closeSignalId: "s1", underlying: "NDX" }) });

    expect(await checkInterruptedRuns(BASE_NOW)).toBe(1);
    const d = decisionsStore.all().find((x) => x.outcome === "run_interrupted")!;
    expect(d.signalId).toBe("s1");
    expect(d.reason).toMatch(/flip was interrupted/);
    expect(d.reason).toMatch(/Short Put Spread was never opened/i);
    expect(d.reason).toMatch(/not opened it by itself/);
    expect(alertsStore.all().map((a) => [a.kind, a.outcome])).toEqual([["error", "run_interrupted"]]);
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ needsAttention: true });
  });

  it("any other run with no record of finishing is also said, without claiming a flip", async () => {
    signal("s2", INTERRUPTED_AFTER_MS + 1000);
    await checkInterruptedRuns(BASE_NOW);
    const d = decisionsStore.all().find((x) => x.outcome === "run_interrupted")!;
    expect(d.reason).toMatch(/never finished/);
    expect(d.reason).not.toMatch(/flip/);
  });

  it("says it once, however many times it looks", async () => {
    signal("s3", INTERRUPTED_AFTER_MS + 1000);
    await checkInterruptedRuns(BASE_NOW);
    expect(await checkInterruptedRuns(BASE_NOW + 60_000)).toBe(0);
    expect(decisionsStore.all().filter((x) => x.outcome === "run_interrupted")).toHaveLength(1);
  });

  it("leaves alone a run that finished, a recent one that is still working, and signals that were never accepted", async () => {
    signal("done", INTERRUPTED_AFTER_MS + 1000);
    runsStore.insert({ id: "done", botId: NDX_BOT_ID, signalId: "done", source: "webhook", automation: "Bullish signal", trigger: "TradingView", startedAt: BASE_NOW, nodes: [] });
    signal("recent", 2 * 60_000);
    signal("rejected", INTERRUPTED_AFTER_MS + 1000, { status: "rejected", rejectReason: "webhook_rate_limited" });
    expect(await checkInterruptedRuns(BASE_NOW)).toBe(0);
    expect(decisionsStore.all().filter((x) => x.outcome === "run_interrupted")).toHaveLength(0);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(false);
  });
});

describe("a call that was answered but never reached the bot", () => {
  const hook = (claimedAt: number | null) =>
    webhooksStore.insert({ id: "w1", name: "BearishNDX", token: "t".repeat(48), botId: NDX_BOT_ID, direction: "bearish", active: true, createdAt: 1, lastTriggeredAt: claimedAt, triggerCount: 1 });

  it("is said once: the minute was taken, no signal followed", async () => {
    hook(BASE_NOW - INTERRUPTED_AFTER_MS - 1000);
    expect(await checkInterruptedRuns(BASE_NOW)).toBe(1);
    const d = decisionsStore.all().find((x) => x.outcome === "run_interrupted")!;
    expect(d.reason).toMatch(/BearishNDX.*never reached the bot/);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);
    expect(await checkInterruptedRuns(BASE_NOW + 60_000)).toBe(0); // not again
  });

  it("is not said when a signal from that webhook followed, however it ended (even rejected), or when the call is recent", async () => {
    const at = BASE_NOW - INTERRUPTED_AFTER_MS - 5000;
    hook(at);
    signal("after", INTERRUPTED_AFTER_MS + 5000 - 1500, { signal: "bearish", status: "rejected", rejectReason: "no_price", raw: { webhook: "BearishNDX" } });
    expect(await checkInterruptedRuns(BASE_NOW)).toBe(0);
    webhooksStore.update("w1", { lastTriggeredAt: BASE_NOW - 60_000 }); // a minute ago: still being worked on
    expect(await checkInterruptedRuns(BASE_NOW)).toBe(0);
    expect(decisionsStore.all().filter((x) => x.outcome === "run_interrupted")).toHaveLength(0);
  });
});
