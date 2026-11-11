import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureBotRecord } from "./bots";
import { BybitExecutor, type BybitConfig } from "./bybitExecutor";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { expireStalePositions } from "./expiry";
import { MockExecutor } from "./executor";
import { positionPL, positionPLKind } from "./pnl";
import { RoutedExecutor } from "./routedExecutor";
import { UNKNOWN_RESULT, settleDerivResults, resetDerivResultAttempts } from "./derivResults";
import { hasNoEndOfDay, runDueSweeps, sweepMinutesFor, sweepModeFor } from "./eodSweep";
import { botsStore, decisionsStore, ordersStore, positionsStore } from "./store";
import { BASE_NOW, BTC_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import { hoursFor } from "./tradingWindow";
import { runBybitRiskCheck } from "./bybitRisk";
import { isWithinTradingHours } from "./tradingHours";

// The bot, end to end, on the Bybit executor against a fake Bybit demo exchange. Nothing touches a network or a real webhook address.
// The decision engine is unchanged: only the executor behind it is different.

setNdxTestEnv();
const MIN = 60_000;
const SATURDAY = Date.UTC(2026, 9, 10, 15, 0);
const fast = { closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 };
const config: BybitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0.12, alwaysOn: false, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 5000 };

let bybit: FakeBybit;
let logs: string[];
let executor: BybitExecutor;
let nowMs = BASE_NOW;
const build = (over: Partial<BybitConfig> = {}) => {
  const ex = new BybitExecutor({ ...config, ...over }, bybit.fetch, (l) => logs.push(l), () => nowMs);
  ex.sleep = async () => {};
  return ex;
};
const mine = () => positionsStore.all().filter((p) => p.botId === BTC_BOT_ID);
const outcomes = () => decisionsStore.all().filter((d) => d.signalId !== null).map((d) => d.outcome);
const alert = (direction: "bullish" | "bearish", barTime: string, now: number, botId = BTC_BOT_ID, symbol = "BTC") =>
  receiveAndSaveSignal({ botId, signal: direction, price: 29_284.55, barTime, interval: "5", raw: { symbol }, now });
const run = (direction: "bullish" | "bearish", barTime: string, now = BASE_NOW, ex: BybitExecutor | RoutedExecutor = executor) => {
  nowMs = now;
  return processSignal(alert(direction, barTime, now), { executor: ex, now, ...fast });
};

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  resetDerivResultAttempts();
  bybit = new FakeBybit();
  logs = [];
  nowMs = BASE_NOW;
  bybit.clock = () => nowMs;
  delete process.env.BYBIT_KILL_SWITCH;
  executor = build();
  ensureBotRecord(BTC_BOT_ID);
});

describe("a confirmed signal opens the perpetual", () => {
  it("bullish buys 0.001 BTCUSDT at market: one open position tied to the Bybit order, and the order row is filled", async () => {
    await run("bullish", "b1");
    expect(outcomes()).toEqual(["opened"]);
    const [p] = mine();
    expect(p).toMatchObject({ type: "short_put_spread", status: "open", venue: "bybit", brokerOrderRef: "bybit-open-1001", filledQuantity: 1 });
    expect(p.credit).toBe(0.76); // $76 of BTC, in the engine's units (a hundredth of a dollar)
    expect(ordersStore.all().map((o) => [o.kind, o.status, o.ref])).toEqual([["open", "filled", "bybit-open-1001"]]);
    expect(bybit.created).toHaveLength(1);
    expect(bybit.created[0].params).toMatchObject({ side: "Buy", orderType: "Market", qty: "0.001", symbol: "BTCUSDT", category: "linear" });
    expect(bybit.position.size).toBe(0.001);
  });

  it("bearish sells short", async () => {
    await run("bearish", "b1");
    expect(bybit.created[0].params).toMatchObject({ side: "Sell", qty: "0.001" });
    expect(mine()[0]).toMatchObject({ type: "short_call_spread", status: "open", venue: "bybit" });
    expect(bybit.position.size).toBe(-0.001);
  });
});

describe("the duplicate guard", () => {
  it("the same side again sends nothing", async () => {
    await run("bullish", "b1");
    bybit.calls.length = 0;
    await run("bullish", "b2", BASE_NOW + 5 * MIN);
    expect(bybit.created).toHaveLength(0);
    expect(outcomes().at(-1)).toBe("already_in_position");
  });

  it("the very same alert twice (a repeat of the webhook) is one order", async () => {
    await run("bullish", "b1");
    bybit.calls.length = 0;
    await run("bullish", "b1");
    expect(bybit.created).toHaveLength(0);
    expect(mine()).toHaveLength(1);
    expect(bybit.position.size).toBe(0.001);
  });
});

describe("a flip: close the old side reduce only, then open the other", () => {
  it("long to short: Sell reduce-only first, then Sell to open, and the result is the real fill difference", async () => {
    await run("bullish", "b1");
    bybit.price = 77_000;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
    expect(bybit.created.map((c) => [c.params.side, c.params.reduceOnly ?? false])).toEqual([["Buy", false], ["Sell", true], ["Sell", false]]);
    const long = mine().find((p) => p.type === "short_put_spread")!;
    const short = mine().find((p) => p.type === "short_call_spread")!;
    expect(long.status).toBe("closed");
    expect(positionPL(long)).toBeCloseTo(1, 6); // (77,000 - 76,000) x 0.001
    expect(positionPLKind(long)).toBe("fill");
    expect(short).toMatchObject({ status: "open", brokerOrderRef: "bybit-open-1003" });
    expect(bybit.position.size).toBe(-0.001);
    expect(botsStore.get(BTC_BOT_ID)?.needsAttention).toBe(false);
    expect(long.closeReason).toBe("signal_flip");
    expect(bybit.created[1].params).toMatchObject({ side: "Sell", reduceOnly: true });
  });

  it("short to long: a fall is a profit for the short", async () => {
    await run("bearish", "b1");
    bybit.price = 75_000;
    await run("bullish", "b2", BASE_NOW + 5 * MIN);
    expect(bybit.created.map((c) => [c.params.side, c.params.reduceOnly ?? false])).toEqual([["Sell", false], ["Buy", true], ["Buy", false]]);
    expect(positionPL(mine().find((p) => p.type === "short_call_spread")!)).toBeCloseTo(1, 6);
    expect(bybit.position.size).toBe(0.001);
  });

  it("a losing flip is a loss in the engine's own numbers", async () => {
    await run("bullish", "b1");
    bybit.price = 74_500;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(positionPL(mine().find((p) => p.type === "short_put_spread")!)).toBeCloseTo(-1.5, 6);
  });

  it("the account never holds both: after every step it is long, flat for no time, or short", async () => {
    await run("bullish", "b1");
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    await run("bullish", "b3", BASE_NOW + 10 * MIN);
    expect(bybit.position.size).toBe(0.001);
    expect(bybit.created.filter((c) => c.params.reduceOnly === true)).toHaveLength(2);
  });

  it("if the close is refused the old position stays open, nothing new is opened, and the bot is flagged", async () => {
    await run("bullish", "b1");
    bybit.overrides.set("/v5/order/create", () => ({ ok: true, status: 200, text: async () => JSON.stringify({ retCode: 110017, retMsg: "Reduce-only rule not satisfied", result: {} }) }));
    bybit.calls.length = 0;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(mine().map((p) => `${p.type}:${p.status}`)).toEqual(["short_put_spread:open"]);
    expect(bybit.created).toHaveLength(1);
    expect(botsStore.get(BTC_BOT_ID)?.needsAttention).toBe(true);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).toMatch(/Reduce-only rule not satisfied/);
  });

  it("if the account no longer holds the position (closed by hand at Bybit), the bot notices, marks it closed, and the flip simply opens the new side", async () => {
    await run("bullish", "b1");
    bybit.hold(0); // a person closed it at Bybit
    bybit.orders.delete("1001");
    bybit.calls.length = 0;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(bybit.created.map((c) => [c.params.side, c.params.reduceOnly ?? false])).toEqual([["Sell", false]]);
    expect(mine().find((p) => p.type === "short_put_spread")).toMatchObject({ status: "closed", closeReason: "closed_at_broker", resultUnknown: "unknown, check Bybit" });
    expect(mine().find((p) => p.type === "short_call_spread")?.status).toBe("open");
    expect(botsStore.get(BTC_BOT_ID)?.needsAttention).toBe(false);
  });

  it("if Bybit cannot be asked, the flip does not guess: the close checks the account itself, sends nothing, and the position waits for Resolve", async () => {
    await run("bullish", "b1");
    bybit.hold(0);
    bybit.fail("/v5/position/list", { kind: "http", status: 500, msg: "down", times: 6 }); // the sync read and the close's own check both fail (each read is asked 3 times)
    bybit.calls.length = 0;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(bybit.created).toHaveLength(0);
    expect(mine().map((p) => `${p.type}:${p.status}`)).toEqual(["short_put_spread:open"]);
    expect(botsStore.get(BTC_BOT_ID)?.needsAttention).toBe(true);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).toMatch(/could not be checked first, so nothing was sent/);
  });
});

describe("when Bybit refuses or cannot be reached, it is loud and nothing is left half-open", () => {
  it("an open Bybit refuses (not enough balance) is rejected and flagged, with Bybit's words", async () => {
    bybit.overrides.set("/v5/order/create", () => ({ ok: true, status: 200, text: async () => JSON.stringify({ retCode: 110007, retMsg: "ab not enough for new order", result: {} }) }));
    await run("bullish", "b1");
    expect(mine().map((p) => p.status)).toEqual(["rejected"]);
    expect(outcomes()).toEqual(["open_rejected"]);
    expect(botsStore.get(BTC_BOT_ID)?.needsAttention).toBe(true);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).toMatch(/ab not enough for new order/);
  });

  it("a wrong key is refused by Bybit before anything is held", async () => {
    executor = new BybitExecutor({ ...config, apiKey: "wrong-key-0000" }, bybit.fetch, (l) => logs.push(l), () => nowMs);
    executor.sleep = async () => {};
    await run("bullish", "b1");
    expect(mine().map((p) => p.status)).toEqual(["rejected"]);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).toMatch(/retCode 10003/);
    expect(bybit.position.size).toBe(0);
  });

  it("an account that already holds something stops a new open, with nothing sent", async () => {
    bybit.hold(0.01);
    await run("bullish", "b1");
    expect(bybit.created).toHaveLength(0);
    expect(mine().map((p) => p.status)).toEqual(["rejected"]);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).toMatch(/already holds a long 0.01 BTCUSDT/);
  });
});

describe("the trading window", () => {
  it("not always on: a Saturday alert is skipped as outside the window and nothing reaches Bybit", async () => {
    await run("bullish", "b1", SATURDAY);
    expect(outcomes()).toEqual(["outside_hours"]);
    expect(bybit.calls).toEqual([]);
    expect(mine()).toHaveLength(0);
  });

  it("always on: the same Saturday alert opens, and a flip the same night closes and opens", async () => {
    executor = build({ alwaysOn: true });
    await run("bullish", "b1", SATURDAY);
    await run("bearish", "b2", SATURDAY + 6 * 60 * MIN);
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
    expect(bybit.created.map((c) => c.params.reduceOnly ?? false)).toEqual([false, true, false]);
  });

  it("the engine's hours for an always-on executor are open at every moment", () => {
    const h = hoursFor(build({ alwaysOn: true }), "BTC");
    for (const at of [SATURDAY, Date.UTC(2026, 9, 11, 3, 0), Date.UTC(2026, 11, 25, 12, 0), BASE_NOW]) expect(isWithinTradingHours(at, h)).toBe(true);
    expect(isWithinTradingHours(SATURDAY, hoursFor(build(), "BTC"))).toBe(false);
  });
});

describe("a perpetual has no expiry and, when always on, no end of day", () => {
  it("a position held from a previous day is never marked expired by the clock", async () => {
    executor = build({ alwaysOn: true });
    await run("bullish", "b1");
    const next = BASE_NOW + 3 * 24 * 60 * MIN;
    expect(expireStalePositions(BTC_BOT_ID, next)).toBe(0);
    expect(mine()[0].status).toBe("open");
    await run("bullish", "b2", next); // the signal that arrives days later still sees the position, and does not buy again
    expect(outcomes().at(-1)).toBe("already_in_position");
    expect(bybit.created).toHaveLength(1);
  });

  it("always on: the end-of-day sweep never runs, so a position survives the 4:15pm sweep time", async () => {
    executor = build({ alwaysOn: true });
    await run("bullish", "b1");
    expect(hasNoEndOfDay(BTC_BOT_ID, executor)).toBe(true);
    const evening = Date.UTC(2026, 9, 6, 22, 30);
    expect(await runDueSweeps(evening, { executor })).not.toContain(BTC_BOT_ID); // (the other bot, on the simulation, still has its own sweep)
    expect(mine()[0].status).toBe("open");
    expect(bybit.created).toHaveLength(1);
  });

  it("windowed: the sweep sits a minute before the window ends and closes the position at market, not expires it", async () => {
    expect(hasNoEndOfDay(BTC_BOT_ID, executor)).toBe(false);
    expect(sweepModeFor(BTC_BOT_ID, executor)).toBe("market");
    expect(sweepMinutesFor(BTC_BOT_ID, executor, BASE_NOW)).toBe(15 * 60 + 54);
    await run("bullish", "b1");
    const sweepAt = Date.UTC(2026, 9, 6, 19, 54); // 3:54pm New York
    nowMs = sweepAt;
    expect(await runDueSweeps(sweepAt, { executor, ...fast })).toEqual([BTC_BOT_ID, LIVE_BOT_ID]);
    expect(mine()[0].status).toBe("closed");
    expect(bybit.created.map((c) => c.params.reduceOnly ?? false)).toEqual([false, true]);
    expect(bybit.position.size).toBe(0);
  });
});

describe("Bybit's own result", () => {
  it("replaces the fill-based figure with Bybit's closed profit and loss (net of fees), once Bybit lists it", async () => {
    await run("bullish", "b1");
    bybit.price = 77_000;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    const long = mine().find((p) => p.type === "short_put_spread")!;
    expect(positionPLKind(long)).toBe("fill");
    expect(await settleDerivResults(executor, BASE_NOW + 10 * MIN)).toBe(1);
    const settled = positionsStore.get(long.id)!;
    expect(settled.settlement).toMatchObject({ kind: "broker" });
    expect(positionPLKind(settled)).toBe("broker");
    expect(positionPL(settled)).toBeCloseTo(1 - 77 * 0.00055 - 76 * 0.00055, 2);
  });

  it("when the demo does not support the endpoint, the real fill figure stays and nothing is made up", async () => {
    bybit.closedPnlSupported = false;
    await run("bullish", "b1");
    bybit.price = 77_000;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    const long = mine().find((p) => p.type === "short_put_spread")!;
    expect(await settleDerivResults(executor, BASE_NOW + 10 * MIN)).toBe(0);
    expect(positionsStore.get(long.id)!.settlement).toBeUndefined();
    expect(positionPL(positionsStore.get(long.id)!)).toBeCloseTo(1, 6);
    expect(positionsStore.get(long.id)!.resultUnknown).toBeUndefined();
    expect(UNKNOWN_RESULT).toBe("unknown, check Deriv"); // Deriv's wording is unchanged
  });
});

describe("only NDX goes to Bybit; the other bot stays on the simulation", () => {
  it("through the router, an SPX alert never reaches Bybit, and an NDX alert does", async () => {
    setTestBotEnv();
    ensureBotRecord("spx_ema_bias");
    const routed = new RoutedExecutor(executor, new MockExecutor(), ["BTC"]);
    const spx = receiveAndSaveSignal({ botId: "spx_ema_bias", signal: "bullish", price: 7_100, barTime: "s1", interval: "5", raw: { symbol: "SPX" }, now: BASE_NOW });
    await processSignal(spx, { executor: routed, now: BASE_NOW, ...fast });
    expect(bybit.calls).toEqual([]);
    expect(positionsStore.all().filter((p) => p.botId === "spx_ema_bias").map((p) => p.venue)).toEqual(["mock"]);

    await run("bullish", "n1", BASE_NOW + 3 * MIN, routed);
    expect(bybit.created).toHaveLength(1);
    expect(mine()[0].venue).toBe("bybit");
  });

  it("the router carries the executor's window and its always-on flag to the engine", () => {
    const routed = new RoutedExecutor(build({ alwaysOn: true }), new MockExecutor(), ["BTC"]);
    expect(routed.tradingWindowFor!("BTC")).toMatchObject({ alwaysOn: true });
    expect(routed.tradingWindowFor!("SPX")).toBeNull();
    expect(routed.getContractResult).toBeTypeOf("function");
  });
});

describe("a stop loss or take profit at Bybit makes the bot flat", () => {
  it("a stop loss closes the trade at Bybit: the next signal on the SAME side opens normally (it is not ignored as a duplicate)", async () => {
    await run("bullish", "b1");
    expect(bybit.movePrice(75_000)).toBe("StopLoss");
    await run("bullish", "b2", BASE_NOW + 10 * MIN);
    expect(outcomes()).toEqual(["opened", "opened"]);
    const [first, second] = mine().sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
    expect(first).toMatchObject({ status: "closed", closeReason: "stop_loss" });
    expect(positionPL(first)).toBeCloseTo(-1, 6);
    expect(second.status).toBe("open");
    expect(bybit.created.map((c) => [c.params.side, c.params.reduceOnly ?? false])).toEqual([["Buy", false], ["Buy", false]]);
    expect(bybit.position).toMatchObject({ size: 0.001 });
  });

  it("a take profit the same, and the opposite signal then simply opens (no close order is sent for what is already closed)", async () => {
    await run("bullish", "b1");
    bybit.movePrice(78_000);
    bybit.price = 78_000;
    await run("bearish", "b2", BASE_NOW + 10 * MIN);
    expect(mine().find((p) => p.type === "short_put_spread")).toMatchObject({ status: "closed", closeReason: "take_profit" });
    expect(positionPL(mine().find((p) => p.type === "short_put_spread")!)).toBeCloseTo(2, 6);
    expect(bybit.created.map((c) => [c.params.side, c.params.reduceOnly ?? false])).toEqual([["Buy", false], ["Sell", false]]);
    expect(mine().find((p) => p.type === "short_call_spread")?.status).toBe("open");
    expect(outcomes()).toEqual(["opened", "opened"]);
    expect(botsStore.get(BTC_BOT_ID)?.needsAttention).toBe(false);
  });

  it("the risk check notices a stop even when no signal arrives", async () => {
    await run("bullish", "b1");
    bybit.movePrice(75_000);
    const r = await runBybitRiskCheck(BTC_BOT_ID, executor, executor, BASE_NOW + MIN);
    expect(mine()[0]).toMatchObject({ status: "closed", closeReason: "stop_loss" });
    expect(r.actions).toEqual([]);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).toMatch(/Closed at Bybit by Bybit's stop loss/);
  });
});

describe("the daily loss limit", () => {
  const small = { dailyMaxLossUsd: 0.5 };

  it("when the day's loss (the open loss, as Bybit reports it) reaches the limit, the position is closed, the day is marked, and nothing new is opened until the next day", async () => {
    executor = build(small);
    await run("bullish", "b1");
    bybit.price = 75_300; // an open loss of $0.70, still above the stop at 75,240
    const r = await runBybitRiskCheck(BTC_BOT_ID, executor, executor, BASE_NOW + MIN, { closeConfirmTimeoutMs: 1000, pollIntervalMs: 5 });
    expect(r.actions.join(" ")).toMatch(/daily loss limit of \$0.50 is reached/);
    expect(mine()[0]).toMatchObject({ status: "closed", closeReason: "daily_limit" });
    expect(bybit.created.map((c) => [c.params.side, c.params.reduceOnly ?? false])).toEqual([["Buy", false], ["Sell", true]]);
    expect(bybit.position.size).toBe(0);
    expect(botsStore.get(BTC_BOT_ID)?.riskTrip?.day).toBe("2026-10-06");

    bybit.calls.length = 0;
    bybit.price = 76_000;
    await run("bullish", "b2", BASE_NOW + 5 * MIN);
    expect(outcomes().at(-1)).toBe("daily_loss_limit_reached");
    expect(bybit.created).toHaveLength(0);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).toMatch(/No new entries until the next day/);

    // the next New York day starts from zero
    await run("bullish", "b3", BASE_NOW + 24 * 60 * MIN);
    expect(outcomes().at(-1)).toBe("opened");
    expect(bybit.created).toHaveLength(1);
  });

  it("the limit stays reached for the day even if the close happens to fill at a better price (the flag, not the arithmetic, blocks the entries)", async () => {
    executor = build(small);
    await run("bullish", "b1");
    bybit.price = 75_300; // an open loss of $0.70: over the $0.50 limit
    const real = bybit.fetch;
    bybit.fetch = async (url, init) => {
      if (init.method === "POST" && url.endsWith("/v5/order/create") && JSON.parse(init.body ?? "{}").reduceOnly === true) bybit.price = 75_800; // the market recovers as the close goes out
      return real(url, init);
    };
    executor = new BybitExecutor({ ...config, ...small }, bybit.fetch, () => {}, () => nowMs);
    executor.sleep = async () => {};
    await runBybitRiskCheck(BTC_BOT_ID, executor, executor, BASE_NOW + MIN, { closeConfirmTimeoutMs: 1000, pollIntervalMs: 5 });
    expect(positionPL(mine()[0])).toBeCloseTo(-0.2, 6); // realized only -$0.20: under the limit by the numbers
    bybit.price = 76_000;
    await run("bullish", "b2", BASE_NOW + 5 * MIN);
    expect(outcomes().at(-1)).toBe("daily_loss_limit_reached");
    expect(bybit.created.filter((c) => c.params.reduceOnly !== true)).toHaveLength(1);
  });

  it("a stop loss that takes the day's realized loss to the limit blocks the next entry, with no monitor needed", async () => {
    executor = build(small);
    await run("bullish", "b1");
    bybit.movePrice(75_000); // -$1.00 realized, over the $0.50 limit
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(outcomes()).toEqual(["opened", "daily_loss_limit_reached"]);
    expect(bybit.created).toHaveLength(1);
    expect(mine()[0]).toMatchObject({ status: "closed", closeReason: "stop_loss" });
  });

  it("under the limit nothing is closed and nothing is blocked", async () => {
    await run("bullish", "b1");
    bybit.price = 75_500; // -$0.50 open, limit $10
    const r = await runBybitRiskCheck(BTC_BOT_ID, executor, executor, BASE_NOW + MIN);
    expect(r.actions).toEqual([]);
    expect(mine()[0].status).toBe("open");
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
    expect(bybit.created).toHaveLength(3);
  });

  it("an open profit does not offset a realized loss", async () => {
    executor = build(small);
    await run("bullish", "b1");
    bybit.movePrice(75_000); // realized -$1.00
    await run("bullish", "b2", BASE_NOW + 5 * MIN);
    expect(outcomes().at(-1)).toBe("daily_loss_limit_reached");
  });
});

describe("the kill switch", () => {
  it("the bot's kill switch stops every new order and closes the open position", async () => {
    await run("bullish", "b1");
    botsStore.update(BTC_BOT_ID, { killSwitch: true });
    const r = await runBybitRiskCheck(BTC_BOT_ID, executor, executor, BASE_NOW + MIN, { closeConfirmTimeoutMs: 1000, pollIntervalMs: 5 });
    expect(r.actions.join(" ")).toMatch(/kill switch is on/i);
    expect(mine()[0]).toMatchObject({ status: "closed", closeReason: "kill_switch" });
    expect(bybit.position.size).toBe(0);
    bybit.calls.length = 0;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(outcomes().at(-1)).toBe("kill_switch");
    expect(bybit.created).toHaveLength(0);
  });

  it("BYBIT_KILL_SWITCH=true does the same without touching the bot, and even a manual order is refused by the executor itself", async () => {
    await run("bullish", "b1");
    process.env.BYBIT_KILL_SWITCH = "true";
    await runBybitRiskCheck(BTC_BOT_ID, executor, executor, BASE_NOW + MIN, { closeConfirmTimeoutMs: 1000, pollIntervalMs: 5 });
    expect(mine()[0]).toMatchObject({ status: "closed", closeReason: "kill_switch" });
    const before = bybit.created.length; // the entry and the kill switch's own reduce-only close
    await expect(executor.placeOpenOrder({ botId: BTC_BOT_ID, underlying: "BTC", positionType: "short_put_spread", shortStrike: 1, longStrike: 0, quantity: 1, limitCredit: 1, expiry: "2026-10-06", clientOrderId: "manual-1" })).rejects.toThrow(/kill switch is on/);
    expect(bybit.created).toHaveLength(before);
    expect(before).toBe(2);
  });

  it("the close the kill switch sends is never held to the trading window", async () => {
    await run("bullish", "b1");
    botsStore.update(BTC_BOT_ID, { killSwitch: true });
    await runBybitRiskCheck(BTC_BOT_ID, executor, executor, SATURDAY, { closeConfirmTimeoutMs: 1000, pollIntervalMs: 5 });
    expect(mine()[0].status).toBe("closed");
  });
});
