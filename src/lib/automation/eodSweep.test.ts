import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockExecutor } from "./executor";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { runEndOfDaySweep, startEodScheduler } from "./eodSweep";
import { positionsStore } from "./store";
import { BASE_NOW, TEST_BOT_ID, buildPosition, resetAutomationStores, setTestBotEnv } from "./testSupport";

setTestBotEnv();

const YESTERDAY = "2026-10-05"; // BASE_NOW's ET date is 2026-10-06

beforeEach(() => {
  resetAutomationStores();
});

describe("runEndOfDaySweep", () => {
  it("#19 expires every active position, regardless of expiry date", async () => {
    positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open", id: "pos-open" }));
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "opening", id: "pos-opening" }));
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "closing", id: "pos-closing" }));
    positionsStore.insert(buildPosition({ type: "short_put_spread", status: "closed", id: "pos-already-closed" }));

    const count = await runEndOfDaySweep(BASE_NOW, undefined, { underlyingPrice: () => null });

    expect(count).toBe(3);
    expect(positionsStore.get("pos-open")?.status).toBe("expired");
    expect(positionsStore.get("pos-opening")?.status).toBe("expired");
    expect(positionsStore.get("pos-closing")?.status).toBe("expired");
    expect(positionsStore.get("pos-already-closed")?.status).toBe("closed"); // untouched, already terminal
  });
});

describe("stale-position safety net", () => {
  it("#20 expires a stale active position from a prior day before the first signal of the day is processed", async () => {
    positionsStore.insert(
      buildPosition({ type: "short_put_spread", status: "open", id: "pos-stale", expiry: YESTERDAY, openedAt: BASE_NOW - 86_400_000 }),
    );

    const executor = new MockExecutor();
    const signal = receiveAndSaveSignal({
      botId: TEST_BOT_ID,
      signal: "bullish",
      price: 7720,
      barTime: "bar-1",
      interval: "5",
      raw: {},
      now: BASE_NOW,
    });
    await processSignal(signal, { executor, now: BASE_NOW, closeConfirmTimeoutMs: 50, orderFillTimeoutMs: 50, pollIntervalMs: 5 });

    expect(positionsStore.get("pos-stale")?.status).toBe("expired");
    // The stale position no longer blocks a fresh entry of the same type.
    const freshPut = positionsStore.query((p) => p.botId === TEST_BOT_ID && p.id !== "pos-stale");
    expect(freshPut.find((p) => p.status === "open")).toBeDefined();
  });
});

describe("the scheduler's timer", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is never started on Vercel: a serverless function has no process to keep a timer, and a frozen one fires all at once on the next request", () => {
    vi.stubEnv("VERCEL", "1");
    const interval = vi.spyOn(globalThis, "setInterval");
    startEodScheduler();
    startEodScheduler();
    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });
});

