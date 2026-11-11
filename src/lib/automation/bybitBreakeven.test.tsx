import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BybitPanelView, CLOSED_BY, CLOSED_BY_EXPLAINED, TradeDetails } from "@/components/automation/BybitPanel";
import { ensureBotRecord } from "./bots";
import { BybitExecutor, readBybitConfig, type BybitConfig } from "./bybitExecutor";
import { runBybitRiskCheck } from "./bybitRisk";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { buildBybitView, type BybitView, type HistoryRow } from "./bybitView";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { botsStore, decisionsStore, positionsStore } from "./store";
import { BASE_NOW, BTC_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";

/**
 * The breakeven stop: once an open Bybit trade is BREAKEVEN_TRIGGER_PERCENT in profit, the risk monitor moves its stop loss at Bybit to BREAKEVEN_LOCK_PERCENT past the entry.
 * All offline, against the fake Bybit exchange. The entry is 76,000; the stop loss is 1% away and the take profit 2%; the trigger is 0.3% (a price of 76,228 for a long) and
 * the lock 0.12% (so a long's stop goes to 76,091.2 and a short's to 75,908.8).
 */

setNdxTestEnv();
const MIN = 60_000;
const fast = { closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 };
const config: BybitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0.3, breakevenLockPercent: 0.12, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 5000 };

let bybit: FakeBybit;
let executor: BybitExecutor;
let logs: string[];
let nowMs = BASE_NOW;
let errors: { mockRestore: () => void };
const build = (over: Partial<BybitConfig> = {}) => {
  const ex = new BybitExecutor({ ...config, ...over }, bybit.fetch, (l) => logs.push(l), () => nowMs);
  ex.sleep = async () => {};
  return ex;
};
const mine = () => positionsStore.all().filter((p) => p.botId === BTC_BOT_ID);
const alert = (direction: "bullish" | "bearish", barTime: string, now: number) => receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: direction, price: 29_284.55, barTime, interval: "5", raw: { symbol: "BTC" }, now });
const signal = (direction: "bullish" | "bearish", barTime: string, now = BASE_NOW) => {
  nowMs = now;
  return processSignal(alert(direction, barTime, now), { executor, now, ...fast });
};
const monitor = (now = BASE_NOW + MIN) => {
  nowMs = now;
  return runBybitRiskCheck(BTC_BOT_ID, executor, executor, now, { closeConfirmTimeoutMs: 1000, pollIntervalMs: 5 });
};
const stopCalls = () => bybit.of("/v5/position/trading-stop");

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  bybit = new FakeBybit();
  logs = [];
  nowMs = BASE_NOW;
  bybit.clock = () => nowMs;
  delete process.env.BYBIT_KILL_SWITCH;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  executor = build();
  ensureBotRecord(BTC_BOT_ID);
});
afterEach(() => errors.mockRestore());

describe("the settings", () => {
  const base = { BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET, STOP_LOSS_PERCENT: "1", TAKE_PROFIT_PERCENT: "2", POSITION_SIZE: "0.001", DAILY_MAX_LOSS_USD: "10" };
  it("unset: 0.3 and 0.12 (the defaults)", () => {
    expect(readBybitConfig(base)).toMatchObject({ breakevenTriggerPercent: 0.3, breakevenLockPercent: 0.12 });
  });
  it("set: the user's own values are used; 0 turns the trigger off", () => {
    expect(readBybitConfig({ ...base, BREAKEVEN_TRIGGER_PERCENT: "0.5", BREAKEVEN_LOCK_PERCENT: "0.2" })).toMatchObject({ breakevenTriggerPercent: 0.5, breakevenLockPercent: 0.2 });
    expect(readBybitConfig({ ...base, BREAKEVEN_TRIGGER_PERCENT: "0" })).toMatchObject({ breakevenTriggerPercent: 0 });
  });
  it("a lock at or past the trigger, or something that is not a number, is refused with a clear message", () => {
    expect(() => readBybitConfig({ ...base, BREAKEVEN_TRIGGER_PERCENT: "0.3", BREAKEVEN_LOCK_PERCENT: "0.3" })).toThrow(/BREAKEVEN_LOCK_PERCENT.*below.*BREAKEVEN_TRIGGER_PERCENT/);
    expect(() => readBybitConfig({ ...base, BREAKEVEN_TRIGGER_PERCENT: "abc" })).toThrow(/BREAKEVEN_TRIGGER_PERCENT/);
    expect(() => readBybitConfig({ ...base, BREAKEVEN_LOCK_PERCENT: "-1" })).toThrow(/BREAKEVEN_LOCK_PERCENT/);
  });
  it("with the trigger off, the lock is not compared to it", () => {
    expect(readBybitConfig({ ...base, BREAKEVEN_TRIGGER_PERCENT: "0", BREAKEVEN_LOCK_PERCENT: "0.5" })).toMatchObject({ breakevenTriggerPercent: 0 });
  });
});

describe("the trigger", () => {
  it("a long that is not far enough in profit is left alone (0.26% against a trigger of 0.3%)", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_200;
    const r = await monitor();
    expect(r.actions).toEqual([]);
    expect(stopCalls()).toHaveLength(0);
    expect(mine()[0].breakevenStop).toBeUndefined();
    expect(bybit.position.stopLoss).toBe(75_240);
  });

  it("a long that reaches the trigger gets its stop moved AT BYBIT to 0.12% past the entry; the take profit is untouched and not even sent", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    const r = await monitor();
    expect(stopCalls()).toHaveLength(1);
    expect(stopCalls()[0].params).toMatchObject({ category: "linear", symbol: "BTCUSDT", stopLoss: "76091.2", slTriggerBy: "MarkPrice", tpslMode: "Full", positionIdx: 0 });
    expect(stopCalls()[0].params).not.toHaveProperty("takeProfit");
    expect(bybit.position.stopLoss).toBe(76_091.2);
    expect(bybit.position.takeProfit).toBe(77_520);
    expect(mine()[0].breakevenStop).toEqual({ price: 76_091.2, at: BASE_NOW + MIN });
    expect(r.actions.join(" ")).toMatch(/Breakeven.*moved at Bybit from 75240 to 76091.2/);
    expect(decisionsStore.all().filter((d) => d.outcome === "breakeven_stop")).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/breakeven: stop loss moved from 75240 to 76091.2/);
  });

  it("a short is the mirror: the stop goes to 0.12% below the entry", async () => {
    await signal("bearish", "b1");
    expect(bybit.position.stopLoss).toBe(76_760);
    bybit.price = 75_770; // 0.30% in profit
    await monitor();
    expect(stopCalls()[0].params).toMatchObject({ stopLoss: "75908.8" });
    expect(bybit.position.stopLoss).toBe(75_908.8);
    expect(bybit.position.takeProfit).toBe(74_480);
    expect(mine()[0].breakevenStop?.price).toBe(75_908.8);
  });

  it("exactly at the trigger counts (0.3% of 76,000 is 228)", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_228.1;
    await monitor();
    expect(stopCalls()).toHaveLength(1);
  });

  it("a trade in LOSS is never touched", async () => {
    await signal("bullish", "b1");
    bybit.price = 75_500; // 0.66% down
    const r = await monitor();
    expect(stopCalls()).toHaveLength(0);
    expect(r.actions).toEqual([]);
    expect(bybit.created).toHaveLength(1); // only the entry: nothing was closed
    expect(bybit.position.size).toBe(0.001);
    expect(mine()[0]).toMatchObject({ status: "open" });
  });

  it("BREAKEVEN_TRIGGER_PERCENT=0 turns it off: even a big profit moves nothing", async () => {
    executor = build({ breakevenTriggerPercent: 0 });
    await signal("bullish", "b1");
    bybit.price = 77_000;
    await monitor();
    expect(stopCalls()).toHaveLength(0);
    expect(bybit.position.stopLoss).toBe(75_240);
  });

  it("the user's own numbers are used (trigger 0.5%, lock 0.2%)", async () => {
    executor = build({ breakevenTriggerPercent: 0.5, breakevenLockPercent: 0.2 });
    await signal("bullish", "b1");
    bybit.price = 76_300; // 0.39%: not yet
    await monitor();
    expect(stopCalls()).toHaveLength(0);
    bybit.price = 76_400; // 0.53%
    await monitor();
    expect(stopCalls()[0].params).toMatchObject({ stopLoss: "76152.0" });
  });
});

describe("only tightens, and only once", () => {
  it("once per trade: later passes, even with a bigger profit, send nothing more", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    await monitor();
    bybit.price = 76_500;
    await monitor(BASE_NOW + 2 * MIN);
    await monitor(BASE_NOW + 3 * MIN);
    expect(stopCalls()).toHaveLength(1);
    expect(bybit.position.stopLoss).toBe(76_091.2);
  });

  it("once per trade means once: if the stop is moved away by hand afterwards, the bot does not move it again", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    await monitor();
    bybit.position.stopLoss = 75_000;
    await monitor(BASE_NOW + 2 * MIN);
    expect(stopCalls()).toHaveLength(1);
    expect(bybit.position.stopLoss).toBe(75_000);
  });

  it("a stop that is already TIGHTER (someone moved it by hand) is never loosened, and nothing is sent or marked", async () => {
    await signal("bullish", "b1");
    bybit.position.stopLoss = 76_150;
    bybit.price = 76_300;
    await monitor();
    expect(stopCalls()).toHaveLength(0);
    expect(bybit.position.stopLoss).toBe(76_150);
    expect(mine()[0].breakevenStop).toBeUndefined();
  });

  it("the same for a short (a stop below the new one is already tighter)", async () => {
    await signal("bearish", "b1");
    bybit.position.stopLoss = 75_850;
    bybit.price = 75_700;
    await monitor();
    expect(stopCalls()).toHaveLength(0);
    expect(bybit.position.stopLoss).toBe(75_850);
  });

  it("safe to run twice: if the record was lost after Bybit moved the stop, the next pass sees the stop is already there, sends nothing and re-marks the trade", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    await monitor();
    positionsStore.update(mine()[0].id, { breakevenStop: undefined });
    await monitor(BASE_NOW + 2 * MIN);
    expect(stopCalls()).toHaveLength(1);
    expect(mine()[0].breakevenStop?.price).toBe(76_091.2);
  });

  it("two passes at the same moment (overlapping) still move it once: the bot's lock serialises them", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    await Promise.all([monitor(), monitor(), monitor()]);
    expect(stopCalls()).toHaveLength(1);
  });
});

describe("a move that Bybit refuses", () => {
  it("retCode 10001 (the price is already beyond the new stop): the trade is closed with a reduce-only market order instead, and it says so", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    bybit.fail("/v5/position/trading-stop", { kind: "ret", code: 10001, msg: "StopLoss:76091.2 set for Buy position should lower than base_price" });
    const r = await monitor();
    expect(bybit.position.size).toBe(0);
    const last = bybit.created.at(-1)!;
    expect(last.params).toMatchObject({ side: "Sell", reduceOnly: true, orderType: "Market" });
    expect(mine()[0]).toMatchObject({ status: "closed", closeReason: "breakeven_close" });
    expect(r.actions.join(" ")).toMatch(/Closing the trade instead \(reduce only\)/);
    const said = decisionsStore.all().filter((d) => d.outcome === "breakeven_stop");
    expect(said).toHaveLength(1);
    expect(said[0].reason).toMatch(/already|Bybit refused/);
  });

  it("any other failure (a timeout, a busy Bybit) does NOT close the trade: it is said, nothing is marked, and the next pass tries again and succeeds", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    bybit.fail("/v5/position/trading-stop", { kind: "ret", code: 10016, msg: "Server Error" });
    const r = await monitor();
    expect(r.actions.join(" ")).toMatch(/Could not move the stop loss to breakeven \(will try again\)/);
    expect(bybit.position.size).toBe(0.001);
    expect(mine()[0]).toMatchObject({ status: "open" });
    expect(mine()[0].breakevenStop).toBeUndefined();
    expect(bybit.position.stopLoss).toBe(75_240);
    await monitor(BASE_NOW + 2 * MIN);
    expect(bybit.position.stopLoss).toBe(76_091.2);
    expect(mine()[0].breakevenStop?.price).toBe(76_091.2);
  });

  it("if Bybit says yes but the position does not show the new stop, that is an error (not a mark), and the trade stays open for the next pass", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    bybit.overrides.set("/v5/position/trading-stop", () => ({ ok: true, status: 200, text: async () => JSON.stringify({ retCode: 0, retMsg: "OK", result: {} }) }));
    const r = await monitor();
    expect(r.actions.join(" ")).toMatch(/Could not move the stop/);
    expect(mine()[0].breakevenStop).toBeUndefined();
    expect(mine()[0].status).toBe("open");
  });
});

describe("the other rules still come first", () => {
  it("the kill switch closes the trade and no stop is moved", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    botsStore.update(BTC_BOT_ID, { killSwitch: true });
    await monitor();
    expect(stopCalls()).toHaveLength(0);
    expect(mine()[0]).toMatchObject({ status: "closed", closeReason: "kill_switch" });
  });

  it("a trade that is in profit but whose bot day has hit the daily loss limit is closed by the limit, not moved", async () => {
    executor = build({ dailyMaxLossUsd: 0.5 });
    await signal("bullish", "b1");
    // an earlier loss today, already realised, puts the day past the limit
    positionsStore.insert({ ...mine()[0], id: "earlier", status: "closed", closedAt: BASE_NOW + 30_000, closePrice: 1.26, closeReason: "stop_loss", breakevenStop: undefined });
    bybit.price = 76_230;
    await monitor();
    expect(stopCalls()).toHaveLength(0);
    expect(mine().find((p) => p.id !== "earlier")).toMatchObject({ closeReason: "daily_limit" });
  });
});

describe("a flip, a close or a new trade starts fresh", () => {
  it("the flip: the long's move is its own; the new short has none until it earns it, and then gets its own", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    await monitor();
    const long = mine()[0];
    expect(long.breakevenStop).toBeDefined();
    await signal("bearish", "b2", BASE_NOW + 5 * MIN); // flips at 76,230
    const [first, second] = [mine().find((p) => p.type === "short_put_spread")!, mine().find((p) => p.type === "short_call_spread")!];
    expect(first).toMatchObject({ status: "closed", closeReason: "signal_flip" });
    expect(second.status).toBe("open");
    expect(second.breakevenStop).toBeUndefined();
    expect(bybit.position.stopLoss).toBeGreaterThan(76_230); // the new short has its normal stop above the entry
    await monitor(BASE_NOW + 6 * MIN);
    expect(stopCalls()).toHaveLength(1); // nothing yet for the short
    bybit.price = 76_230 * 0.9965; // short entered at 76,230 is 0.35% in profit
    await monitor(BASE_NOW + 7 * MIN);
    expect(stopCalls()).toHaveLength(2);
    expect(mine().find((p) => p.type === "short_call_spread")!.breakevenStop).toBeDefined();
    expect(mine().find((p) => p.type === "short_put_spread")!.breakevenStop?.price).toBe(76_091.2); // unchanged
  });

  it("after a close, a new trade on the same side begins unmoved and can be moved again", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    await monitor();
    // Bybit's own stop fires at the breakeven stop
    expect(bybit.movePrice(76_080)).toBe("StopLoss");
    await monitor(BASE_NOW + 2 * MIN);
    expect(mine()[0]).toMatchObject({ status: "closed", closeReason: "breakeven_stop" });
    bybit.price = 76_000;
    await signal("bullish", "b3", BASE_NOW + 20 * MIN);
    const fresh = mine().find((p) => p.status === "open")!;
    expect(fresh.breakevenStop).toBeUndefined();
    bybit.price = 76_240;
    await monitor(BASE_NOW + 21 * MIN);
    expect(stopCalls()).toHaveLength(2);
    expect(mine().find((p) => p.id === fresh.id)!.breakevenStop).toBeDefined();
  });
});

describe("how the closed trade is labelled", () => {
  it("a trade stopped out at the moved stop is recorded as a breakeven stop; a plain stop loss stays a stop loss", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    await monitor();
    expect(bybit.movePrice(76_080)).toBe("StopLoss");
    await monitor(BASE_NOW + 2 * MIN);
    expect(mine()[0].closeReason).toBe("breakeven_stop");
    expect(decisionsStore.all().some((d) => d.outcome === "closed" && /breakeven stop/.test(d.reason))).toBe(true);

    // a second trade that is stopped out without ever being moved
    bybit.price = 76_000;
    await signal("bearish", "b2", BASE_NOW + 20 * MIN);
    expect(bybit.movePrice(76_760)).toBe("StopLoss");
    await monitor(BASE_NOW + 21 * MIN);
    expect(mine().find((p) => p.type === "short_call_spread")!.closeReason).toBe("stop_loss");
  });

  it("the take profit is not relabelled: a moved trade that reaches its take profit is a take profit", async () => {
    await signal("bullish", "b1");
    bybit.price = 76_230;
    await monitor();
    expect(bybit.movePrice(77_600)).toBe("TakeProfit");
    await monitor(BASE_NOW + 2 * MIN);
    expect(mine()[0].closeReason).toBe("take_profit");
  });

  it("the history says 'Breakeven stop' under How it closed, never plain 'Stop loss', and the details explain it", () => {
    expect(CLOSED_BY.breakeven_stop.label).toBe("Breakeven stop");
    expect(CLOSED_BY.breakeven_close.label).toBe("Breakeven close");
    expect(CLOSED_BY_EXPLAINED.breakeven_stop).toMatch(/moved its stop loss/);
    expect(CLOSED_BY_EXPLAINED.breakeven_close).toBeTruthy();
    const row: HistoryRow = { orderId: "o9", side: "Long", size: 0.001, entryPrice: 76_000, exitPrice: 76_080, pnl: 0.03, pnlPercent: 0.04, fees: 0.05, openFee: 0.025, closeFee: 0.025, grossPnl: 0.08, leverage: 10, entryValue: 76, exitValue: 76.08, openedAt: null, closedBy: "breakeven_stop", byBot: true, manual: false, closedAt: Date.UTC(2026, 9, 6, 15, 0) };
    const page = renderToStaticMarkup(<BybitPanelView v={emptyView({ history: [row], historyTotals: { count: 1, wins: 1, losses: 0, total: 0.03, todayResult: 0.03 } })} />);
    expect(page).toContain("Breakeven stop");
    expect(page).not.toMatch(/>Stop loss</);
    const details = renderToStaticMarkup(<TradeDetails r={row} symbol="BTCUSDT" />);
    expect(details).toContain("Breakeven stop");
    expect(details).toContain("moved its stop loss");
  });
});

describe("the Bybit page's open trade", () => {
  it("before the move it shows the normal stop; after, it says the stop was moved to breakeven and shows the new price", async () => {
    await signal("bullish", "b1");
    const before = await buildBybitView(executor, BTC_BOT_ID, "BTCUSDT", BASE_NOW + 30_000);
    expect(before.open?.breakeven).toBeNull();
    expect(renderToStaticMarkup(<BybitPanelView v={before} />)).not.toContain("moved to breakeven");
    bybit.price = 76_230;
    await monitor();
    const after = await buildBybitView(executor, BTC_BOT_ID, "BTCUSDT", BASE_NOW + 2 * MIN);
    expect(after.open).toMatchObject({ stopLoss: 76_091.2, takeProfit: 77_520, breakeven: { price: 76_091.2 } });
    const html = renderToStaticMarkup(<BybitPanelView v={after} />);
    expect(html).toContain("Stop loss: moved to breakeven");
    expect(html).toMatch(/Moved to breakeven at 76,091\.20/);
    expect(html).toContain("77,520.00"); // the take profit is still shown where it was
  });
});

const emptyView = (over: Partial<BybitView>): BybitView => ({
  symbol: "BTCUSDT",
  positionSize: 0.001,
  mode: "24 hours a day, every day",
  killSwitch: false,
  open: null,
  openError: null,
  mismatch: null,
  history: [],
  historyError: null,
  historyClearedAt: null,
  todayResetAt: null,
  historyTotals: { count: 0, wins: 0, losses: 0, total: 0, todayResult: 0 },
  closed: [],
  closedCount: 0,
  totals: { day: "2026-10-06", dayResult: 0, realizedToday: 0, openLoss: 0, running: 0, limit: 10, room: 10, reached: false, tripped: false },
  asOf: 0,
  ...over,
});
