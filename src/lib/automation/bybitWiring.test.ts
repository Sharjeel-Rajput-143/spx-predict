import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountPill, liveChipTip, ordersFooter, routingNote } from "@/components/automation/executorLabels";
import { ensureBotRecord } from "./bots";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { riskTick } from "./eodSweep";
import { executorKind, isBrokerKind } from "./executorKind";
import { positionsStore } from "./store";
import { bybitExecutor, executorStatus, getExecutor, isPaperStatus, sharedExecutor } from "./sharedExecutor";
import { BASE_NOW, BTC_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import type { OpenSpreadRequest } from "./types";

const RISK = { STOP_LOSS_PERCENT: "1", TAKE_PROFIT_PERCENT: "2", POSITION_SIZE: "0.001", DAILY_MAX_LOSS_USD: "10" };
const useBybit = (extra: Record<string, string> = {}) => {
  vi.stubEnv("BROKER", "bybit");
  vi.stubEnv("EXECUTOR", "");
  for (const [k, v] of Object.entries({ BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET, BYBIT_ALWAYS_ON: "true", ...RISK, ...extra })) vi.stubEnv(k, v);
};
const req: OpenSpreadRequest = { botId: BTC_BOT_ID, underlying: "BTC", positionType: "short_put_spread", shortStrike: 29_000, longStrike: 28_990, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06", clientOrderId: "w-1" };

let bybit: FakeBybit;
beforeEach(() => {
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined; // the app keeps one executor per process; each test builds its own
  vi.stubEnv("BROKER", "");
  vi.stubEnv("EXECUTOR", "");
  for (const k of [...Object.keys(RISK), "BYBIT_DEMO_API_KEY", "BYBIT_DEMO_API_SECRET", "BYBIT_ALWAYS_ON", "BYBIT_KILL_SWITCH"]) vi.stubEnv(k, "");
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(BTC_BOT_ID);
  bybit = new FakeBybit();
  bybit.clock = () => Date.now();
  vi.stubGlobal("fetch", (url: string, init: Parameters<typeof bybit.fetch>[1]) => bybit.fetch(String(url), init));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("choosing Bybit", () => {
  it("BROKER=bybit (and the older EXECUTOR=bybit) select it; internal stays the default", () => {
    expect(executorKind({})).toBe("mock");
    expect(executorKind({ BROKER: "bybit" })).toBe("bybit");
    expect(executorKind({ EXECUTOR: "bybit" })).toBe("bybit");
    expect(isBrokerKind({ BROKER: "bybit" })).toBe(true);
    expect(() => executorKind({ BROKER: "bybit", EXECUTOR: "deriv" })).toThrow(/disagree/);
  });

  it("with everything set it is a demo (paper) broker that serves the BTC bot only, and says so on the screens", () => {
    useBybit();
    const s = executorStatus();
    expect(s).toMatchObject({ kind: "bybit", venue: "bybit", error: null, baseUrl: "https://api-demo.bybit.com", sandbox: true, bridgeSymbols: ["BTC"] });
    expect(isPaperStatus(s)).toBe(true);
    expect(sharedExecutor.venue).toBe("bybit");
    expect(accountPill({ venue: "bybit", sandbox: true })).toEqual({ text: "Paper · Bybit (demo)", tone: "ok" });
    expect(ordersFooter({ venue: "bybit", sandbox: true, bridgeSymbols: ["BTC"] })).toMatch(/BTC orders go to the Bybit paper account/);
    expect(routingNote({ venue: "bybit", sandbox: true, bridgeSymbols: ["BTC"] })).toMatch(/go to Bybit/);
    expect(liveChipTip({ venue: "bybit", sandbox: true })).toMatch(/Bybit paper account/);
    expect(bybitExecutor()).not.toBeNull();
    expect(getExecutor().tradingWindowFor!("BTC")).toMatchObject({ alwaysOn: true });
  });

  it("finds the Bybit executor even when another copy of the code built it (Next compiles each route separately and shares one executor between them)", () => {
    useBybit();
    // an executor made by "another copy": plain objects, not instances of this copy's classes
    const foreign = { venue: "bybit", getAccountPosition: async () => ({ side: null }), dailyMaxLossUsd: 3 };
    const routed = { venue: "bybit", primaryExecutor: foreign };
    (globalThis as { __automationExecutor?: unknown }).__automationExecutor = { key: "bybit:false", executor: routed };
    expect(getExecutor()).toBe(routed);
    expect(bybitExecutor()).toBe(foreign);
    // and one that is not Bybit's, or cannot read the account, is not taken for it
    (globalThis as { __automationExecutor?: unknown }).__automationExecutor = { key: "bybit:false", executor: { primaryExecutor: { venue: "deriv", getAccountPosition: async () => ({}) } } };
    expect(bybitExecutor()).toBeNull();
    (globalThis as { __automationExecutor?: unknown }).__automationExecutor = { key: "bybit:false", executor: { primaryExecutor: { venue: "bybit" } } };
    expect(bybitExecutor()).toBeNull();
  });

  it("with another broker selected there is no Bybit executor for the panel", () => {
    expect(bybitExecutor()).toBeNull();
  });
});

describe("it refuses to trade unless the four risk settings (and the key) are all set", () => {
  for (const name of ["STOP_LOSS_PERCENT", "TAKE_PROFIT_PERCENT", "POSITION_SIZE", "DAILY_MAX_LOSS_USD", "BYBIT_DEMO_API_KEY", "BYBIT_DEMO_API_SECRET"]) {
    it(`without ${name}: the status is an error naming it, no executor exists, and an order throws before any request is made`, async () => {
      useBybit({ [name]: "" });
      const s = executorStatus();
      expect(s.error).toContain(name);
      expect(s.error).toMatch(/will not trade until these are set/);
      expect(bybitExecutor()).toBeNull();
      expect(() => sharedExecutor.placeOpenOrder(req)).toThrow(new RegExp(name));
      expect(bybit.calls).toEqual([]);
    });
  }

  it("an alert reaching the bot with a setting missing opens nothing, loudly", async () => {
    useBybit({ DAILY_MAX_LOSS_USD: "" });
    const signal = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: "bullish", price: 29_284.55, barTime: "m1", interval: "5", raw: { symbol: "BTC" }, now: BASE_NOW });
    await processSignal(signal, { executor: sharedExecutor, now: BASE_NOW, closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 }).catch(() => undefined);
    expect(bybit.calls).toEqual([]);
    expect(positionsStore.all().filter((p) => p.status === "open")).toEqual([]);
  });
});

describe("the risk monitor on the clock", () => {
  it("riskTick finds a trade Bybit closed by its stop, and closes everything when the kill switch is on", async () => {
    useBybit();
    const exec = {
      executor: sharedExecutor,
      closeConfirmTimeoutMs: 1000,
      orderFillTimeoutMs: 1000,
      pollIntervalMs: 5,
      ladderStepMs: 20,
    };
    // (an identical alert within 120 seconds is the engine's own duplicate, so the second one is stamped later)
    const alert = (barTime: string, laterMs = 0) => receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: "bullish", price: 29_284.55, barTime, interval: "5", raw: { symbol: "BTC" }, now: Date.now() + laterMs });
    await processSignal(alert("t1"), { ...exec, now: Date.now() });
    expect(positionsStore.all().map((p) => p.status)).toEqual(["open"]);

    bybit.movePrice(75_000);
    await riskTick(Date.now());
    expect(positionsStore.all().map((p) => [p.status, p.closeReason])).toEqual([["closed", "stop_loss"]]);

    await processSignal(alert("t2", 5 * 60_000), { ...exec, now: Date.now() });
    expect(positionsStore.all().filter((p) => p.status === "open")).toHaveLength(1);
    vi.stubEnv("BYBIT_KILL_SWITCH", "true");
    await riskTick(Date.now());
    expect(positionsStore.all().filter((p) => p.status === "open")).toHaveLength(0);
    expect(positionsStore.all().map((p) => p.closeReason).sort()).toEqual(["kill_switch", "stop_loss"]);
    expect(bybit.position.size).toBe(0);
  });

  it("with nothing open, or Bybit not the broker, it asks Bybit nothing", async () => {
    expect(await riskTick(Date.now())).toBe(0);
    useBybit();
    expect(await riskTick(Date.now())).toBe(0);
    expect(bybit.calls).toEqual([]);
  });
});
