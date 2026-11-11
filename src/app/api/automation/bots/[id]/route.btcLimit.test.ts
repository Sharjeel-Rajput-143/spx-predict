import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BTC_BOT_ID, ensureBotRecord } from "@/lib/automation/bots";
import { API_KEY, API_SECRET } from "@/lib/automation/bybitTestSupport";
import { positionsStore } from "@/lib/automation/store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "@/lib/automation/testSupport";
import { GET } from "./route";

/**
 * The Safeguards card used to say "Daily loss limit: Off" for the BTC bot because it showed the engine's limit (off for this bot) while Bybit's own $10 limit was working.
 * The bot's answer now carries the real one, and today's result after fees. Other bots are answered exactly as before.
 */

const RISK = { STOP_LOSS_PERCENT: "1", TAKE_PROFIT_PERCENT: "2", POSITION_SIZE: "0.001", DAILY_MAX_LOSS_USD: "10" };
const UNIT = 0.001;
const urlFor = (id: string) => `http://localhost/api/automation/bots/${id}`;
const get = async (id: string) => (await GET(new NextRequest(urlFor(id)), { params: Promise.resolve({ id }) })).json();

function bybitBroker(over: Record<string, string> = {}) {
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  vi.stubEnv("BROKER", "bybit");
  vi.stubEnv("EXECUTOR", "");
  for (const [k, v] of Object.entries({ BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET, BYBIT_ALWAYS_ON: "true", BREAKEVEN_TRIGGER_PERCENT: "0", BYBIT_KILL_SWITCH: "", ...RISK, ...over })) vi.stubEnv(k, v);
}

/** A Bybit trade closed today, with the result Bybit reported (after fees). */
const closedBybit = (pl: number, closedAt = BASE_NOW - 3_600_000) =>
  positionsStore.insert(
    buildPosition({
      botId: BTC_BOT_ID,
      underlying: "BTC",
      venue: "bybit",
      type: "short_put_spread",
      status: "closed",
      requestedQuantity: 1,
      filledQuantity: 1,
      credit: (75_000 * UNIT) / 100,
      closePrice: (75_000 * UNIT) / 100,
      closedAt,
      settlement: { kind: "broker", pl, at: closedAt },
    }),
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_NOW);
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(BTC_BOT_ID);
  ensureBotRecord(NDX_BOT_ID);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
});

describe("the BTC bot's answer carries Bybit's real daily loss limit", () => {
  it("brokerDailyLossLimit is DAILY_MAX_LOSS_USD, and the engine's own limit stays off", async () => {
    bybitBroker();
    const body = await get(BTC_BOT_ID);
    expect(body.limits.brokerDailyLossLimit).toBe(10);
    expect(body.limits.dailyLossLimit).toBe(0); // unchanged: this is a display field, no rule moved
    expect(body.dayLoss.limit).toBe(10);
  });

  it("it follows the setting (25 -> 25), it is not fixed at 10", async () => {
    bybitBroker({ DAILY_MAX_LOSS_USD: "25" });
    expect((await get(BTC_BOT_ID)).limits.brokerDailyLossLimit).toBe(25);
  });

  it("today's result is Bybit's figure after fees, wins and losses together", async () => {
    bybitBroker();
    closedBybit(0.37);
    closedBybit(-0.03);
    closedBybit(0.5, BASE_NOW - 40 * 3_600_000); // an earlier day: not today
    const body = await get(BTC_BOT_ID);
    expect(body.dayLoss).toEqual({ limit: 10, realized: 0.34, closedToday: 2, unpriced: 0, lastCheck: null, afterFees: true });
  });

  it("until Bybit lists a trade, the fills less estimated fees are used (a +$0.06 gross short is -$0.03)", async () => {
    bybitBroker();
    const entryU = (75_199.9 * UNIT) / 100;
    const exitU = (75_143.2 * UNIT) / 100;
    positionsStore.insert(
      buildPosition({ botId: BTC_BOT_ID, underlying: "BTC", venue: "bybit", type: "short_call_spread", status: "closed", requestedQuantity: 1, filledQuantity: 1, credit: entryU, closePrice: exitU, closedAt: BASE_NOW - 60_000 }),
    );
    expect((await get(BTC_BOT_ID)).dayLoss.realized).toBeCloseTo(-0.03, 2);
  });
});

describe("every other case is answered as before", () => {
  it("the NDX Bias Bot has no Bybit limit, even with Bybit as the broker", async () => {
    bybitBroker();
    const body = await get(NDX_BOT_ID);
    expect(body.limits.brokerDailyLossLimit).toBeNull();
    expect(body.dayLoss.afterFees).toBeUndefined();
  });

  it("with the internal simulation as the broker, the BTC bot has no Bybit limit either (nothing is made up)", async () => {
    vi.stubEnv("BROKER", "internal");
    (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
    const body = await get(BTC_BOT_ID);
    expect(body.limits.brokerDailyLossLimit).toBeNull();
    expect(body.dayLoss.afterFees).toBeUndefined();
  });

  it("with Bybit chosen but not configured, the page still answers (a display never breaks it)", async () => {
    vi.stubEnv("BROKER", "bybit");
    vi.stubEnv("BYBIT_DEMO_API_KEY", "");
    vi.stubEnv("BYBIT_DEMO_API_SECRET", "");
    (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
    const res = await GET(new NextRequest(urlFor(BTC_BOT_ID)), { params: Promise.resolve({ id: BTC_BOT_ID }) });
    expect(res.status).toBe(200);
    expect((await res.json()).limits.brokerDailyLossLimit).toBeNull();
  });

  it("each Bybit bot's answer carries its OWN pullback values: the same defaults, separate saved values, nothing for any other bot", async () => {
    const { updateBot } = await import("@/lib/automation/bots");
    const { LIVE_BOT_ID } = await import("@/lib/automation/bybitLiveLimits");
    ensureBotRecord(LIVE_BOT_ID);
    const defaults = { enabled: true, fallUsd: 0.03, minPeakUsd: 0.12, chainEnabled: false, chainStopUsd: 0.03, chainMax: 10 };
    expect((await get(BTC_BOT_ID)).bot.pullback).toEqual(defaults);
    expect((await get(LIVE_BOT_ID)).bot.pullback).toEqual(defaults);
    updateBot(LIVE_BOT_ID, { pullback: { minPeakUsd: 0.4, chainEnabled: true } });
    expect((await get(LIVE_BOT_ID)).bot.pullback).toMatchObject({ minPeakUsd: 0.4, chainEnabled: true });
    expect((await get(BTC_BOT_ID)).bot.pullback).toEqual(defaults); // the demo bot is unchanged
    updateBot(BTC_BOT_ID, { pullback: { fallUsd: 0.07 } });
    expect((await get(LIVE_BOT_ID)).bot.pullback).toMatchObject({ fallUsd: 0.03 }); // and the other way round
    expect((await get(NDX_BOT_ID)).bot.pullback).toBeNull();
  });
});
