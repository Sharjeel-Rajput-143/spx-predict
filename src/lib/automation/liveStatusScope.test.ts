import { beforeEach, describe, expect, it } from "vitest";
import { BTC_BOT_ID, ensureBotRecord } from "./bots";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { __resetLastCheck, liveStatus } from "./liveControl";
import { __resetLiveSettings } from "./liveSettings";
import { positionsStore } from "./store";
import { buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";

// THE LIVE PAGE'S DATA: what liveStatus() hands the Live page (its Status and Trades tabs) comes from the live bot's records only. Demo positions sit right next to them here.

setNdxTestEnv();
const NOW = Date.UTC(2026, 10, 11, 12, 0);
const MIN = 60_000;
const trade = (id: string, botId: string, over: object = {}) =>
  buildPosition({ id, botId, underlying: "BTC", venue: "bybit", type: "short_put_spread", status: "closed", requestedQuantity: 1, filledQuantity: 1, credit: 0.75, closePrice: 0.75, openedAt: NOW - 30 * MIN, closedAt: NOW - 5 * MIN, closeReason: "stop_loss", settlement: { kind: "broker", pl: -1.11, at: NOW }, ...over });
const sdeps = () => ({ executor: () => null, problem: () => "no key", now: () => NOW });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  __resetLiveSettings();
  __resetLastCheck();
  ensureBotRecord(BTC_BOT_ID);
  ensureBotRecord(LIVE_BOT_ID);
});

describe("liveStatus feeds the Live page from the live bot only", () => {
  it("with only demo trades and a demo position open, the live page sees no trade and no open position", () => {
    positionsStore.insert(trade("demo-closed", BTC_BOT_ID));
    positionsStore.insert(trade("demo-open", BTC_BOT_ID, { status: "open", closedAt: undefined, closeReason: undefined, settlement: undefined }));
    const s = liveStatus(sdeps());
    expect(s.recent).toEqual([]);
    expect(s.position).toBeNull();
  });
  it("with both, the live page lists the live trade and its position, never the demo's", () => {
    positionsStore.insert(trade("demo-closed", BTC_BOT_ID, { settlement: { kind: "broker", pl: 9.99, at: NOW } }));
    positionsStore.insert(trade("demo-open", BTC_BOT_ID, { status: "open", closedAt: undefined, closeReason: undefined, settlement: undefined, openedAt: NOW - MIN }));
    positionsStore.insert(trade("live-closed", LIVE_BOT_ID));
    positionsStore.insert(trade("live-open", LIVE_BOT_ID, { status: "open", closedAt: undefined, closeReason: undefined, settlement: undefined, openedAt: NOW - 2 * MIN }));
    const s = liveStatus(sdeps());
    expect(s.recent.map((r) => r.pl)).toEqual([-1.11]);
    expect(s.position?.openedAt).toBe(NOW - 2 * MIN);
    expect(JSON.stringify(s)).not.toContain("9.99");
  });
});
