import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as status } from "@/app/api/automation/status/route";
import { GET as settings } from "@/app/api/automation/settings/route";
import { ensureBotRecord, updateBot } from "./bots";
import { botsStore } from "./store";
import { summarizeAllBots } from "./summary";
import { BTC_BOT_ID, NDX_BOT_ID, TEST_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";

setTestBotEnv();
setNdxTestEnv();

// The SPX bot is kept out of sight for now: archived and switched off by default, restorable from Bot Archive.

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  vi.stubEnv("BOT_SPX_EMA_BIAS_HIDDEN", ""); // unset = the app's default: hidden
});
afterEach(() => vi.unstubAllEnvs());

describe("the SPX bot is hidden by default", () => {
  it("starts archived and switched off; NDX is unaffected", () => {
    expect(ensureBotRecord(TEST_BOT_ID)).toMatchObject({ archived: true, enabled: false });
    expect(ensureBotRecord(NDX_BOT_ID)).toMatchObject({ enabled: true });
    expect(ensureBotRecord(NDX_BOT_ID).archived).toBeFalsy();
  });

  it("is archived in the bot list, so the Automation list hides it (and Bot Archive shows it)", () => {
    const all = summarizeAllBots();
    expect(all.find((b) => b.id === TEST_BOT_ID)?.archived).toBe(true);
    expect(all.find((b) => b.id === NDX_BOT_ID)?.archived).toBe(false);
  });

  it("is left off the Testing page and off the webhook bot choices", async () => {
    const s = await (await status(new NextRequest("http://localhost/api/automation/status"))).json();
    expect(s.bots.map((b: { id: string }) => b.id)).toEqual([NDX_BOT_ID, BTC_BOT_ID, LIVE_BOT_ID]); // the live bot is listed (off), but never offered as a webhook choice
    const set = await (await settings(new NextRequest("http://localhost/api/automation/settings"))).json();
    expect(set.webhook.bots.map((b: { id: string }) => b.id)).toEqual([NDX_BOT_ID, BTC_BOT_ID]);
  });

  it("a record from before it was hidden is archived once", () => {
    botsStore.insert({ id: TEST_BOT_ID, enabled: true, needsAttention: false, needsAttentionReason: null, createdAt: 0 });
    expect(ensureBotRecord(TEST_BOT_ID)).toMatchObject({ archived: true, enabled: false });
  });

  it("restoring it brings it back for good: visible, and not hidden again", () => {
    ensureBotRecord(TEST_BOT_ID);
    updateBot(TEST_BOT_ID, { archived: false });
    expect(ensureBotRecord(TEST_BOT_ID)).toMatchObject({ archived: false });
    expect(summarizeAllBots().find((b) => b.id === TEST_BOT_ID)?.archived).toBe(false);
  });

  it("BOT_SPX_EMA_BIAS_HIDDEN=false shows it from the start", () => {
    vi.stubEnv("BOT_SPX_EMA_BIAS_HIDDEN", "false");
    expect(ensureBotRecord(TEST_BOT_ID)).toMatchObject({ enabled: true });
    expect(ensureBotRecord(TEST_BOT_ID).archived).toBeFalsy();
  });

  it("a hidden bot never acts on a signal that reaches it", async () => {
    const { processSignal, receiveAndSaveSignal } = await import("./engine");
    const { MockExecutor } = await import("./executor");
    const { decisionsStore, positionsStore } = await import("./store");
    const { BASE_NOW } = await import("./testSupport");
    const signal = receiveAndSaveSignal({ botId: TEST_BOT_ID, signal: "bullish", price: 7720, barTime: "b", interval: "5", raw: { symbol: "SPX" }, now: BASE_NOW });
    await processSignal(signal, { executor: new MockExecutor(), now: BASE_NOW });
    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["automations_off"]);
    expect(positionsStore.all()).toHaveLength(0);
  });
});
