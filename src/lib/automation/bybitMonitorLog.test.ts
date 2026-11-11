import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord } from "./bots";
import { BybitExecutor, type BybitConfig } from "./bybitExecutor";
import { runBybitRiskCheck, watchLine } from "./bybitRisk";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { getExecutor } from "./sharedExecutor";
import { BASE_NOW, BTC_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";

/**
 * What the running app says about itself, so a restart can be CHECKED instead of assumed: which daily loss limit it loaded, and what the risk monitor is watching (the open
 * position, and whether its stop loss and take profit are in place at Bybit). Only those facts are said; never the key, the secret or any other setting.
 */

const config: BybitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 0.3, takeProfitPercent: 0.6, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0.12, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 5000 };
let info: { mock: { calls: unknown[][] }; mockRestore: () => void };
let error: { mock: { calls: unknown[][] }; mockRestore: () => void };
const said = (): string[] => info.mock.calls.map((c) => String(c[0])).filter((l: string) => l.startsWith("[bybit]"));
const errors = (): string[] => error.mock.calls.map((c) => String(c[0])).filter((l: string) => l.startsWith("[bybit]"));

beforeEach(() => {
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  (globalThis as { __bybitWatching?: Map<string, string> }).__bybitWatching?.clear();
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
});
afterEach(() => {
  info.mockRestore();
  error.mockRestore();
  vi.unstubAllEnvs();
});

describe("the app says which daily loss limit it loaded", () => {
  it("when the executor is built it names the limit from the settings, and nothing else of them", () => {
    vi.stubEnv("BROKER", "bybit");
    vi.stubEnv("EXECUTOR", "");
    for (const [k, v] of Object.entries({ BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET, STOP_LOSS_PERCENT: "0.3", TAKE_PROFIT_PERCENT: "0.6", POSITION_SIZE: "0.001", DAILY_MAX_LOSS_USD: "10" })) vi.stubEnv(k, v);
    getExecutor();
    expect(said()).toEqual(["[bybit] demo executor ready: daily loss limit $10"]);
    const all = said().join(" ");
    for (const secret of [API_KEY, API_SECRET, "0.3", "0.6", "0.001"]) expect(all).not.toContain(secret);
  });

  it("it follows the setting: 10 says 10, 3 says 3, and it is said once however often the executor is asked for", () => {
    vi.stubEnv("BROKER", "bybit");
    vi.stubEnv("EXECUTOR", "");
    for (const [k, v] of Object.entries({ BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET, STOP_LOSS_PERCENT: "0.3", TAKE_PROFIT_PERCENT: "0.6", POSITION_SIZE: "0.001", DAILY_MAX_LOSS_USD: "3" })) vi.stubEnv(k, v);
    getExecutor();
    getExecutor();
    getExecutor();
    expect(said()).toEqual(["[bybit] demo executor ready: daily loss limit $3"]);
  });
});

describe("the risk monitor says what it is watching", () => {
  it("a short with both stops at Bybit: said once, with its side, size, stops and the limit; not said again while it does not change", () => {
    const held = { side: "Sell" as const, size: 0.001, stopLoss: 75_900.5, takeProfit: 74_800.1 };
    watchLine("b", held, 10);
    watchLine("b", held, 10);
    watchLine("b", held, 10);
    expect(said()).toEqual(["[bybit] risk monitor: watching the open position: short 0.001, stop loss 75900.5, take profit 74800.1, daily loss limit $10"]);
    expect(errors()).toEqual([]);
  });

  it("a long is called a long; a change in the stops is said again", () => {
    watchLine("b", { side: "Buy", size: 0.001, stopLoss: 74_000, takeProfit: 76_000 }, 10);
    watchLine("b", { side: "Buy", size: 0.001, stopLoss: 74_500, takeProfit: 76_000 }, 10);
    expect(said()).toHaveLength(2);
    expect(said()[0]).toContain("long 0.001");
    expect(said()[1]).toContain("stop loss 74500");
  });

  it("a position WITHOUT a stop at Bybit is an error line, in capitals, naming which is missing", () => {
    watchLine("b", { side: "Sell", size: 0.001, stopLoss: null, takeProfit: 74_800 }, 10);
    watchLine("b", { side: "Buy", size: 0.001, stopLoss: 74_000, takeProfit: null }, 10);
    expect(errors()).toEqual([
      "[bybit] risk monitor: WATCHING A POSITION WITHOUT ITS STOPS AT BYBIT: short 0.001, stop loss NONE, take profit 74800, daily loss limit $10",
      "[bybit] risk monitor: WATCHING A POSITION WITHOUT ITS STOPS AT BYBIT: long 0.001, stop loss 74000, take profit NONE, daily loss limit $10",
    ]);
    expect(said()).toEqual([]);
  });

  it("flat: silent until it has been watching something, then it says so once", () => {
    watchLine("b", { side: null, size: 0, stopLoss: null, takeProfit: null }, 10);
    expect(said()).toEqual([]);
    watchLine("b", { side: "Buy", size: 0.001, stopLoss: 1, takeProfit: 2 }, 10);
    watchLine("b", { side: null, size: 0, stopLoss: null, takeProfit: null }, 10);
    watchLine("b", { side: null, size: 0, stopLoss: null, takeProfit: null }, 10);
    expect(said().filter((l: string) => l.includes("flat"))).toEqual(["[bybit] risk monitor: the account is flat (daily loss limit $10)"]);
  });

  it("through the real monitor: with an open position on record it reads Bybit and says what it sees, once across several 10-second looks", async () => {
    setNdxTestEnv();
    resetAutomationStores();
    ensureBotRecord(BTC_BOT_ID);
    const bybit = new FakeBybit();
    bybit.price = 75_300;
    bybit.clock = () => Date.now();
    const executor = new BybitExecutor(config, bybit.fetch, () => {}, () => Date.now());
    executor.sleep = async () => {};
    const signal = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: "bearish", price: 29_310, barTime: "m1", interval: "5", raw: { symbol: "BTC" }, now: BASE_NOW });
    await processSignal(signal, { executor, now: Date.now(), closeConfirmTimeoutMs: 2000, orderFillTimeoutMs: 2000, pollIntervalMs: 5, ladderStepMs: 20 });
    expect(bybit.position.size).toBe(-0.001);
    for (let i = 0; i < 3; i++) await runBybitRiskCheck(BTC_BOT_ID, executor, executor, Date.now());
    expect(said()).toEqual(["[bybit] risk monitor: watching the open position: short 0.001, stop loss 75525.9, take profit 74848.2, daily loss limit $10"]);
    expect(errors()).toEqual([]);
  });

  it("with nothing open on record the monitor does not even read Bybit, and says nothing", async () => {
    setNdxTestEnv();
    resetAutomationStores();
    ensureBotRecord(BTC_BOT_ID);
    const bybit = new FakeBybit();
    bybit.clock = () => Date.now();
    const executor = new BybitExecutor(config, bybit.fetch, () => {}, () => Date.now());
    await runBybitRiskCheck(BTC_BOT_ID, executor, executor, Date.now());
    expect(bybit.calls).toEqual([]);
    expect(said()).toEqual([]);
  });
});
