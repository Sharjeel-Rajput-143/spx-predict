import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord } from "./bots";
import { BybitExecutor, type BybitConfig, type BybitTrace } from "./bybitExecutor";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { runBybitRiskCheck } from "./bybitRisk";
import { botsStore, decisionsStore } from "./store";
import { buildBybitView, bybitBotId, clearBybitHistory, resetBybitToday } from "./bybitView";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { BASE_NOW, BTC_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";

// What the site shows for Bybit: the open trade straight from Bybit's position data, the closed trades, the totals and the room before the daily limit.

setNdxTestEnv();
const MIN = 60_000;
const fast = { closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 };
const config: BybitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0.12, alwaysOn: false, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 5000 };

let bybit: FakeBybit;
let executor: BybitExecutor;
let nowMs = BASE_NOW;
let traces: BybitTrace[];
const run = (direction: "bullish" | "bearish", barTime: string, now = BASE_NOW) => {
  nowMs = now;
  vi.setSystemTime(now); // the engine stamps a close with the real clock: pinned to the test's time
  const signal = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: direction, price: 29_284.55, barTime, interval: "5", raw: { symbol: "BTC" }, now });
  return processSignal(signal, { executor, now, ...fast });
};
const view = () => buildBybitView(executor, BTC_BOT_ID, "BTCUSDT", nowMs);

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_NOW);
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(BTC_BOT_ID);
  bybit = new FakeBybit();
  bybit.clock = () => nowMs;
  nowMs = BASE_NOW;
  traces = [];
  delete process.env.BYBIT_KILL_SWITCH;
  executor = new BybitExecutor(config, bybit.fetch, () => {}, () => nowMs);
  executor.sleep = async () => {};
  executor.onCall = (t) => traces.push(t);
});

describe("the open trade is Bybit's own position data", () => {
  it("flat: nothing open, and the day starts at zero with the whole limit in hand", async () => {
    const v = await view();
    expect(v.open).toBeNull();
    expect(v.openError).toBeNull();
    expect(v.mismatch).toBeNull();
    expect(v.totals).toMatchObject({ dayResult: 0, running: 0, limit: 10, room: 10, reached: false });
    expect(v.closed).toEqual([]);
  });

  it("long: side, entry, current (mark) price, size and the live profit or loss are what Bybit's position list says, to the cent", async () => {
    await run("bullish", "b1");
    for (const price of [76_000, 76_500, 75_400]) {
      bybit.price = price;
      traces.length = 0;
      const v = await view();
      const raw = traces.find((t) => t.path === "/v5/position/list")!.result as { list: { avgPrice: string; markPrice: string; unrealisedPnl: string; size: string }[] };
      expect(v.open).toMatchObject({ side: "Long", size: 0.001, stopLoss: 75240, takeProfit: 77520 });
      expect(v.open!.entryPrice).toBe(Number(raw.list[0].avgPrice));
      expect(v.open!.currentPrice).toBe(Number(raw.list[0].markPrice));
      expect(v.open!.pnl).toBe(Number(raw.list[0].unrealisedPnl));
    }
    expect(v_pnl(await view())).toBeCloseTo(-0.6, 6);
  });

  it("short: a rising price is a loss", async () => {
    await run("bearish", "b1");
    bybit.price = 76_400;
    const v = await view();
    expect(v.open).toMatchObject({ side: "Short" });
    expect(v.open!.pnl).toBeCloseTo(-0.4, 6);
  });

  it("when Bybit cannot be read it says so and shows no stale trade", async () => {
    await run("bullish", "b1");
    bybit.fail("/v5/position/list", { kind: "http", status: 500, msg: "down", times: 3 });
    const v = await view();
    expect(v.open).toBeNull();
    expect(v.openError).toMatch(/HTTP 500/);
    expect(v.mismatch).toBeNull();
  });

  it("says so when the bot and the account disagree", async () => {
    await run("bullish", "b1");
    bybit.hold(0);
    expect((await view()).mismatch).toMatch(/does not hold/);
    bybit.hold(0.001);
    resetAutomationStores();
    setNdxTestEnv();
    ensureBotRecord(BTC_BOT_ID);
    expect((await view()).mismatch).toMatch(/not opened by the bot/);
  });
});

describe("closed trades and totals", () => {
  it("a flip: entry, exit, how it closed, the final profit and the time, and the day's and running totals", async () => {
    await run("bullish", "b1");
    bybit.price = 77_000;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    const v = await view();
    expect(v.closed).toHaveLength(1);
    expect(v.closed[0]).toMatchObject({ side: "Long", size: 0.001, entryPrice: 76_000, exitPrice: 77_000, closedBy: "signal_flip", pl: 0.92, plSource: "estimated" }); // $1 on the fills, less about $0.08 of fees until Bybit lists the trade
    expect(v.closed[0].closedAt).toBeGreaterThan(0);
    expect(v.totals).toMatchObject({ realizedToday: 0.92, running: 0.92 });
    expect(v.totals.room).toBe(10.92); // a realized win (after fees) leaves the day with more than the limit of room: wins and losses of the day are added together
  });

  it("a short's closed row has its own entry and exit", async () => {
    await run("bearish", "b1");
    bybit.price = 75_000;
    await run("bullish", "b2", BASE_NOW + 5 * MIN);
    expect((await view()).closed[0]).toMatchObject({ side: "Short", entryPrice: 76_000, exitPrice: 75_000, pl: 0.92, closedBy: "signal_flip" });
  });

  it("a stop loss: 'stop_loss', the loss, and less room before the daily limit", async () => {
    await run("bullish", "b1");
    bybit.movePrice(75_000);
    await runBybitRiskCheck(BTC_BOT_ID, executor, executor, nowMs + MIN);
    const v = await view();
    expect(v.closed[0]).toMatchObject({ closedBy: "stop_loss", entryPrice: 76_000, exitPrice: 75_000, pl: -1.08 });
    expect(v.totals).toMatchObject({ dayResult: -1.08, running: -1.08, room: 8.92, reached: false });
  });

  it("the running total adds every closed trade", async () => {
    await run("bullish", "b1");
    bybit.price = 77_000;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    bybit.price = 76_000;
    await run("bullish", "b3", BASE_NOW + 10 * MIN);
    const v = await view();
    expect(v.closedCount).toBe(2);
    expect(v.totals.running).toBe(1.83); // the long 76,000 to 77,000 and the short 77,000 to 76,000: +1 each on the fills, less fees
  });

  it("open profit or loss is part of the day's result, but only an open LOSS uses up room", async () => {
    await run("bullish", "b1");
    bybit.price = 76_500;
    let v = await view();
    expect(v.totals).toMatchObject({ dayResult: 0.5, openLoss: 0, room: 10 });
    bybit.price = 75_500;
    v = await view();
    expect(v.totals).toMatchObject({ dayResult: -0.5, openLoss: -0.5, room: 9.5 });
  });

  it("when the limit is reached the view says so", async () => {
    executor = new BybitExecutor({ ...config, dailyMaxLossUsd: 0.5 }, bybit.fetch, () => {}, () => nowMs);
    executor.sleep = async () => {};
    await run("bullish", "b1");
    bybit.price = 75_300;
    const v = await view();
    expect(v.totals).toMatchObject({ reached: true, room: 0 });
  });

  it("the kill switch shows", async () => {
    process.env.BYBIT_KILL_SWITCH = "true";
    expect((await view()).killSwitch).toBe(true);
  });
});

function v_pnl(v: Awaited<ReturnType<typeof view>>): number {
  return v.open!.pnl!;
}

describe("the open trade, in words and numbers", () => {
  it("worth, percent, and what each stop would do, from Bybit's own position fields", async () => {
    await run("bullish", "b1");
    bybit.price = 76_760; // +1% on a 76,000 entry
    const o = (await view()).open!;
    expect(o.valueUsd).toBe(76.76);
    expect(o.pnl).toBeCloseTo(0.76, 6);
    expect(o.pnlPercent).toBe(1);
    expect(o.ifStopLoss).toBe(-0.76); // 75,240 against a 76,000 entry, 0.001 BTC
    expect(o.ifTakeProfit).toBe(1.52);
  });

  it("a short's stops are worked the other way round", async () => {
    await run("bearish", "b1");
    const o = (await view()).open!;
    expect(o.side).toBe("Short");
    expect(o.ifStopLoss).toBe(-0.76);
    expect(o.ifTakeProfit).toBe(1.52);
  });

  it("says in plain words what the header shows: the trading mode, the size, the kill switch", async () => {
    const v = await view();
    expect(v.mode).toBe("09:35 to 15:55 New York time, Monday to Friday");
    const always = new BybitExecutor({ ...config, alwaysOn: true }, bybit.fetch, () => {}, () => nowMs);
    expect((await buildBybitView(always, BTC_BOT_ID, "BTCUSDT", nowMs)).mode).toBe("24 hours a day, every day");
    expect(v.positionSize).toBe(0.001);
  });

  it("a trade that was not opened by the bot is explained as that, not as an error", async () => {
    bybit.hold(0.001);
    const v = await view();
    expect(v.mismatch).toMatch(/not opened by the bot.*placed by hand or by a script/);
    expect(v.open).toMatchObject({ side: "Long" });
  });
});

describe("the trade history is Bybit's own list of closed trades", () => {
  it("a flip: the bot's closed trade, net of fees, with how it closed, entry, exit and percent", async () => {
    await run("bullish", "b1");
    bybit.price = 77_000;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    const v = await view();
    expect(v.history).toHaveLength(1);
    const r = v.history[0];
    expect(r).toMatchObject({ side: "Long", size: 0.001, entryPrice: 76_000, exitPrice: 77_000, closedBy: "signal_flip", byBot: true });
    expect(r.pnl).toBeCloseTo(1 - 76 * 0.00055 - 77 * 0.00055, 2); // Bybit's net figure: the fill difference less both fees
    expect(r.fees).toBeCloseTo(76 * 0.00055 + 77 * 0.00055, 4);
    expect(r.pnlPercent).toBeCloseTo((r.pnl / 76) * 100, 1);
    expect(v.historyTotals).toMatchObject({ count: 1, wins: 1, losses: 0 });
    expect(v.historyTotals.total).toBe(r.pnl);
    // what the details popup shows
    expect(r.openFee).toBeCloseTo(76 * 0.00055, 4);
    expect(r.closeFee).toBeCloseTo(77 * 0.00055, 4);
    expect(r.grossPnl).toBeCloseTo(1, 2); // before fees: (77,000 - 76,000) x 0.001
    expect(r.grossPnl + (r.fees ?? 0) - (r.fees ?? 0)).toBe(r.grossPnl);
    expect(r.pnl).toBeCloseTo(r.grossPnl - (r.fees ?? 0), 2);
    expect(r.leverage).toBe(10);
    expect(r.entryValue).toBeCloseTo(76, 6);
    expect(r.exitValue).toBeCloseTo(77, 6);
    expect(r.openedAt).toBe(BASE_NOW); // the bot opened it, so when is known
  });

  it("a stop loss and a take profit at Bybit are labelled as such", async () => {
    await run("bullish", "b1");
    bybit.movePrice(75_000);
    await runBybitRiskCheck(BTC_BOT_ID, executor, executor, nowMs + MIN);
    bybit.price = 76_000;
    await run("bullish", "b2", BASE_NOW + 10 * MIN);
    bybit.movePrice(78_000);
    await runBybitRiskCheck(BTC_BOT_ID, executor, executor, nowMs + MIN);
    const v = await view();
    expect(v.history.map((r) => r.closedBy).sort()).toEqual(["stop_loss", "take_profit"]);
    expect(v.historyTotals).toMatchObject({ count: 2, wins: 1, losses: 1 });
  });

  it("a trade closed by hand at Bybit, which the bot has no record of, is still in the history, said to be by hand", async () => {
    // placed and closed directly through the executor, with nothing recorded by the bot (as a person or a script would)
    await executor.placeOpenOrder({ botId: BTC_BOT_ID, underlying: "BTC", positionType: "short_put_spread", shortStrike: 1, longStrike: 0, quantity: 1, limitCredit: 1, expiry: "2026-10-06", clientOrderId: "hand-1" });
    bybit.price = 76_200;
    await executor.placeCloseOrder({ id: "x", botId: BTC_BOT_ID, type: "short_put_spread", filledQuantity: 1, requestedQuantity: 1, brokerOrderRef: "bybit-open-1001" } as never, { manual: true, clientOrderId: "hand-1-close" });
    const v = await view();
    expect(v.history).toHaveLength(1);
    expect(v.history[0]).toMatchObject({ closedBy: "closed_at_broker", byBot: false, entryPrice: 76_000, exitPrice: 76_200, openedAt: null }); // not the bot's: no opening time to show
  });

  it("newest first, and 'today' counts the day's closed trades plus the open one", async () => {
    await run("bullish", "b1");
    bybit.price = 77_000;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    bybit.price = 76_000;
    await run("bullish", "b3", BASE_NOW + 10 * MIN);
    bybit.price = 76_500;
    const v = await view();
    expect(v.history.map((r) => r.side)).toEqual(["Short", "Long"]);
    expect(v.history[0].closedAt).toBeGreaterThanOrEqual(v.history[1].closedAt);
    expect(v.historyTotals.todayResult).toBeCloseTo(v.historyTotals.total + 0.5, 1);
  });

  it("when Bybit's history cannot be read it says so, and the rest of the page still works", async () => {
    await run("bullish", "b1");
    bybit.fail("/v5/position/closed-pnl", { kind: "http", status: 500, msg: "down", times: 3 });
    const v = await view();
    expect(v.history).toEqual([]);
    expect(v.historyError).toMatch(/HTTP 500/);
    expect(v.open).not.toBeNull();
  });

  it("asks Bybit for the latest 100 closed trades, so there are several pages of 20 to look through", async () => {
    await view();
    expect(bybit.of("/v5/position/closed-pnl")[0].params).toMatchObject({ limit: "100" });
  });

  it("is read from Bybit at most every 10 seconds when the page asks for it to be cached, and a clear forces a fresh read", async () => {
    const calls = () => bybit.of("/v5/position/closed-pnl").length;
    await buildBybitView(executor, BTC_BOT_ID, "BTCUSDT", nowMs, { cacheHistory: true });
    await buildBybitView(executor, BTC_BOT_ID, "BTCUSDT", nowMs + 3_000, { cacheHistory: true });
    expect(calls()).toBe(1);
    await buildBybitView(executor, BTC_BOT_ID, "BTCUSDT", nowMs + 11_000, { cacheHistory: true });
    expect(calls()).toBe(2);
    clearBybitHistory(BTC_BOT_ID, nowMs);
    await buildBybitView(executor, BTC_BOT_ID, "BTCUSDT", nowMs + 12_000, { cacheHistory: true });
    expect(calls()).toBe(3);
  });
});

describe("Reset today", () => {
  it("restarts the Today figure from $0 and deletes nothing; the daily loss limit keeps counting exactly as before", async () => {
    await run("bullish", "b1");
    bybit.movePrice(75_000);
    await runBybitRiskCheck(BTC_BOT_ID, executor, executor, nowMs + MIN); // a stop loss: a loss today
    const before = await view();
    expect(before.historyTotals.todayResult).toBeLessThan(0);
    expect(before.totals.room).toBe(8.92);
    const historyBefore = JSON.stringify(before.history);

    resetBybitToday(BTC_BOT_ID, nowMs + 2 * MIN);
    nowMs += 3 * MIN;
    const after = await view();
    expect(after.historyTotals.todayResult).toBe(0);
    expect(after.todayResetAt).toBe(nowMs - MIN);
    expect(JSON.stringify(after.history)).toBe(historyBefore); // the history is untouched
    expect(after.historyTotals.total).toBe(before.historyTotals.total); // so is the total since cleared
    expect(after.totals.room).toBe(8.92); // the daily loss limit still counts the loss
    expect(after.totals.dayResult).toBe(before.totals.dayResult);
    expect(after.closedCount).toBe(1);
  });

  it("a trade closed after the reset counts again; the open trade's live result always counts", async () => {
    await run("bullish", "b1");
    bybit.price = 77_000;
    await run("bearish", "b2", BASE_NOW + 5 * MIN); // closes the long at a profit, opens a short
    resetBybitToday(BTC_BOT_ID, nowMs + MIN);
    nowMs += 2 * MIN;
    bybit.price = 77_300; // the short is down $0.30 live
    const during = await view();
    expect(during.historyTotals.todayResult).toBeCloseTo(-0.3, 1);
    bybit.price = 76_000;
    await run("bullish", "b3", BASE_NOW + 10 * MIN); // closes the short at a profit
    const v = await view();
    expect(v.historyTotals.todayResult).toBeCloseTo(v.history[0].pnl + (v.open?.pnl ?? 0), 1); // only trades closed since the reset
  });

  it("a reset made on an earlier day does not apply to today", async () => {
    await run("bullish", "b1");
    bybit.price = 77_000;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    const before = await view();
    resetBybitToday(BTC_BOT_ID, nowMs - 3 * 24 * 3_600_000);
    const after = await view();
    expect(after.todayResetAt).toBeNull();
    expect(after.historyTotals.todayResult).toBe(before.historyTotals.todayResult);
  });
});

describe("Clear history", () => {
  it("hides the list and restarts 'total since cleared', but deletes nothing and leaves the daily loss limit exactly as it was", async () => {
    await run("bullish", "b1");
    bybit.movePrice(75_000);
    await runBybitRiskCheck(BTC_BOT_ID, executor, executor, nowMs + MIN); // a $1 stop loss, counted against the day
    const before = await view();
    expect(before.history).toHaveLength(1);
    expect(before.totals.room).toBe(8.92);
    const recordsBefore = JSON.stringify(botsStore.all());

    clearBybitHistory(BTC_BOT_ID, nowMs + 2 * MIN);
    nowMs += 3 * MIN;
    const after = await view();
    expect(after.history).toEqual([]);
    expect(after.historyClearedAt).toBe(nowMs - MIN);
    expect(after.historyTotals).toMatchObject({ count: 0, total: 0 });
    expect(after.totals.room).toBe(8.92); // the day's loss still counts
    expect(after.totals.dayResult).toBe(before.totals.dayResult);
    expect(after.historyTotals.todayResult).toBe(before.historyTotals.todayResult); // today is what happened today, cleared or not
    expect(after.closedCount).toBe(1); // the bot's own record is still there
    expect(JSON.parse(recordsBefore).length).toBe(botsStore.all().length);
  });

  it("a trade closed after the clear shows again, and only that one counts in the total", async () => {
    await run("bullish", "b1");
    bybit.price = 77_000;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    clearBybitHistory(BTC_BOT_ID, nowMs + MIN);
    nowMs += 2 * MIN;
    bybit.price = 76_000;
    await run("bullish", "b3", BASE_NOW + 10 * MIN);
    const v = await view();
    expect(v.history).toHaveLength(1);
    expect(v.history[0].side).toBe("Short");
    expect(v.historyTotals.count).toBe(1);
  });

  it("the daily loss limit still blocks after a clear (clearing cannot be used to get round it)", async () => {
    const tiny = new BybitExecutor({ ...config, dailyMaxLossUsd: 0.5 }, bybit.fetch, () => {}, () => nowMs);
    tiny.sleep = async () => {};
    executor = tiny;
    await run("bullish", "b1");
    bybit.movePrice(75_000); // -$1.00 realized, over the $0.50 limit
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    clearBybitHistory(BTC_BOT_ID, nowMs + MIN);
    await run("bullish", "b3", BASE_NOW + 10 * MIN);
    expect(decisionsOutcomes()).toContain("daily_loss_limit_reached");
    expect(bybit.created).toHaveLength(1);
  });

  it("finds the bot whose orders go to Bybit", () => {
    expect(bybitBotId(executor)).toBe(BTC_BOT_ID);
  });
});

const decisionsOutcomes = (): string[] => decisionsStore.all().filter((d) => d.signalId !== null).map((d) => d.outcome);
