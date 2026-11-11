import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BTC_BOT_ID, ensureBotRecord } from "./bots";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { MockExecutor } from "./executor";
import { signalsStore } from "./store";
import { resetAutomationStores, setNdxTestEnv } from "./testSupport";
import { ingestWebhook } from "./webhookIngest";

// The live bot can be reached through ONE door: the mirror. Not by an outside call that knows the shared secret, not by a test alert, not by a named webhook pointed at it.

setNdxTestEnv();
const body = (over: Record<string, unknown> = {}) => ({ bot: LIVE_BOT_ID, signal: "bullish", price: 76_000, bar_time: "t-1", interval: "", ...over });
const executor = () => new MockExecutor();

const lg = globalThis as typeof globalThis & { __liveBybit?: { executor: unknown; error: string | null } };
const keptLive = lg.__liveBybit;
afterEach(() => {
  lg.__liveBybit = keptLive as never;
});
beforeEach(() => {
  lg.__liveBybit = { executor: null, error: null }; // a live key that loaded (the executor itself is not used by these tests); the live bot is held to its own executor
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(BTC_BOT_ID);
  ensureBotRecord(LIVE_BOT_ID);
});

describe("who can send the live bot a signal", () => {
  it("with no live key the mirror's own door is refused in words (503), and an outside call still just hears 'Unknown bot'", () => {
    lg.__liveBybit = { executor: null, error: "no live key" };
    expect(ingestWebhook(body(), { executor: executor(), trusted: true, mirrorOf: BTC_BOT_ID })).toMatchObject({ status: 503 });
    expect(ingestWebhook(body(), { executor: executor(), trusted: true })).toMatchObject({ status: 400, body: { error: "Unknown bot." } });
  });

  it("a misconfigured DEMO executor refuses the demo bot's alert (503) but NOT the live bot's own copy: each bot is held to its own executor", () => {
    process.env.BROKER = "nonsense";
    try {
      expect(ingestWebhook(body({ bot: BTC_BOT_ID, bar_time: "t-demo" }), { executor: executor(), trusted: true })).toMatchObject({ status: 503 });
      const live = ingestWebhook(body({ bar_time: "t-live" }), { executor: executor(), trusted: true, mirrorOf: BTC_BOT_ID });
      expect(live.status).toBe(200);
    } finally {
      delete process.env.BROKER;
    }
  });

  it("an outside call that names it (even a trusted one, even with a test flag) is told the bot does not exist, and is logged as rejected", () => {
    for (const options of [{ executor: executor(), trusted: true }, { executor: executor(), trusted: true, test: true }, { executor: executor(), trusted: true, mirrorOf: "ndx_ema_bias" }, { executor: executor(), trusted: true, mirrorOf: LIVE_BOT_ID }]) {
      const r = ingestWebhook(body(), options);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "Unknown bot." });
      expect(r.processing).toBeUndefined();
    }
    const rows = signalsStore.query(() => true);
    expect(rows.length).toBe(4);
    expect(rows.every((s) => s.status === "rejected" && s.rejectReason === "unknown_bot")).toBe(true);
  });

  it("the mirror's own door works: a signal marked as the BTC demo bot's copy is accepted (the live bot is held to its OWN executor, not the demo's)", async () => {
    const r = ingestWebhook(body(), { executor: executor(), trusted: true, mirrorOf: BTC_BOT_ID });
    expect(r.status).toBe(200);
    await r.processing;
    const saved = signalsStore.query((s) => s.botId === LIVE_BOT_ID);
    expect(saved).toHaveLength(1);
    expect(saved[0].status).not.toBe("rejected");
  });

  it("the live bot is born OFF: a mirrored signal reaches it but opens nothing (an off bot only closes)", async () => {
    const r = ingestWebhook(body(), { executor: executor(), trusted: true, mirrorOf: BTC_BOT_ID });
    await r.processing;
    const { positionsStore } = await import("./store");
    expect(positionsStore.query((p) => p.botId === LIVE_BOT_ID)).toHaveLength(0);
  });
});
