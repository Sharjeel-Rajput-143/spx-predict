import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BTC_BOT_ID, ensureBotRecord } from "./bots";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { resetDerivResultAttempts } from "./derivResults";
import { riskTick } from "./eodSweep";
import { positionsStore } from "./store";
import { BASE_NOW, buildPosition, resetAutomationStores } from "./testSupport";

/** The 10-second Bybit monitor fetches Bybit's own after-fees result for a trade that has just closed, so the Bybit page and the limit stop using the estimate within seconds. */

let bybit: FakeBybit;
beforeEach(() => {
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  vi.stubEnv("BROKER", "bybit");
  vi.stubEnv("EXECUTOR", "");
  for (const [k, v] of Object.entries({ BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET, BYBIT_ALWAYS_ON: "true", STOP_LOSS_PERCENT: "1", TAKE_PROFIT_PERCENT: "2", POSITION_SIZE: "0.001", DAILY_MAX_LOSS_USD: "10" })) vi.stubEnv(k, v);
  vi.stubEnv("AUTOMATION_DRY_RUN", "");
  resetAutomationStores();
  resetDerivResultAttempts();
  bybit = new FakeBybit();
  vi.stubGlobal("fetch", (url: string, init: Parameters<FakeBybit["fetch"]>[1]) => bybit.fetch(String(url), init));
  ensureBotRecord(BTC_BOT_ID);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const closed = (id: string, closedAt: number) =>
  positionsStore.insert(buildPosition({ id, botId: BTC_BOT_ID, underlying: "BTC", venue: "bybit", type: "short_call_spread", status: "closed", requestedQuantity: 1, filledQuantity: 1, credit: 0.751999, closePrice: 0.751432, closedAt, brokerOrderRef: `bybit-close-${id}` }));

describe("the Bybit monitor settles a fresh close", () => {
  it("a trade closed a moment ago gets Bybit's own result (net of fees) on the next monitor pass, and a stale one is left alone", async () => {
    const now = Date.now();
    closed("fresh", now - 20_000);
    closed("stale", now - 3_600_000);
    bybit.closedPnl.push({ orderId: "fresh", closedPnl: "-0.0312" }, { orderId: "stale", closedPnl: "-5" });
    await riskTick(now);
    expect(positionsStore.get("fresh")?.settlement).toMatchObject({ kind: "broker", pl: -0.03 });
    expect(positionsStore.get("stale")?.settlement).toBeUndefined();
  });

  it("when Bybit has not listed it yet, the next pass a few seconds later tries again", async () => {
    const now = Date.now();
    closed("late", now - 5_000);
    await riskTick(now); // not listed yet
    expect(positionsStore.get("late")?.settlement).toBeUndefined();
    bybit.closedPnl.push({ orderId: "late", closedPnl: "-0.03" });
    await riskTick(now + 3_000); // too soon to ask again
    expect(positionsStore.get("late")?.settlement).toBeUndefined();
    await riskTick(now + 9_000);
    expect(positionsStore.get("late")?.settlement).toMatchObject({ kind: "broker", pl: -0.03 });
  });
});

void BASE_NOW;
