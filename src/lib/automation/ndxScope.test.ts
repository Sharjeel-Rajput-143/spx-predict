import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusView, type StatusResponse } from "@/components/automation/StatusDashboard";
import { alertsStore, botsStore, decisionsStore, errorsStore, ordersStore, positionsStore, runsStore } from "./store";
import { withBotLock } from "./botLock";
import { ensureBotRecord, getBotStaticConfig, listBotIds, updateBot } from "./bots";
import { ERROR_FAILSAFE_THRESHOLD, ORDER_FILL_TIMEOUT_SECONDS } from "./config";
import { processSignal, receiveAndSaveSignal, type LiveQuote } from "./engine";
import { countTodayErrors, recordError } from "./errors";
import { __resetSweepState, runDueSweeps, sweepBot, sweepMinutesFor, sweepModeFor } from "./eodSweep";
import { MockExecutor } from "./executor";
import { watchOrder } from "./orderWatch";
import { computeStats, positionPL, positionPLKind } from "./pnl";
import { enterPositionPL } from "./positionsAdmin";
import { activePositionsForBot, countTodayNewPositions, sumActiveAllocationRisk } from "./safeguards";
import { buildLadder } from "./smartPricing";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import { easternDateKey } from "./tradingHours";
import type { BrokerExecutor, OrderState, SignalDirection } from "./types";

// The NDX scope update: the eight changes taken from Option Alpha's documentation, one describe per item.
// Only the NDX bot is used. Everything runs on the mock executor; nothing talks to a broker.

setTestBotEnv();
setNdxTestEnv();

let executor: MockExecutor;
const fast = { closeConfirmTimeoutMs: 60, orderFillTimeoutMs: 60, pollIntervalMs: 4, ladderStepMs: 20 };
const DAY = 86_400_000;
let seq = 0;

function emit(
  direction: SignalDirection,
  opts: { now?: number; price?: number; dryRun?: boolean; receivedAgoMs?: number; liveQuote?: (symbol: string) => LiveQuote | null } = {},
) {
  const now = opts.now ?? BASE_NOW;
  const signal = receiveAndSaveSignal({
    botId: NDX_BOT_ID,
    signal: direction,
    price: opts.price ?? 21_003.7,
    barTime: `bar-${direction}-${now}-${seq++}`,
    interval: "5",
    raw: { symbol: "NDX" },
    now: now - (opts.receivedAgoMs ?? 0),
  });
  return processSignal(signal, { executor, now, ...fast, ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}), ...(opts.liveQuote ? { liveQuote: opts.liveQuote } : {}) });
}

const outcomes = () => decisionsStore.all().filter((d) => d.botId === NDX_BOT_ID).map((d) => d.outcome);
const bot = () => botsStore.get(NDX_BOT_ID)!;
const ndxPosition = (over: Parameters<typeof buildPosition>[0]) =>
  buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", shortStrike: 21_000, longStrike: 20_990, requestedQuantity: 1, filledQuantity: 1, credit: 3.5, ...over });
const switchBotBackOn = () => botsStore.update(NDX_BOT_ID, { enabled: true, needsAttention: false, needsAttentionReason: null });
const at = (h: number, m: number) => Date.UTC(2026, 9, 6, h + 4, m); // 2026-10-06, EDT = UTC-4

beforeEach(() => {
  resetAutomationStores();
  __resetSweepState();
  setNdxTestEnv();
  executor = new MockExecutor();
  ensureBotRecord(NDX_BOT_ID);
});
afterEach(() => vi.unstubAllEnvs());

describe("scope: NDX only", () => {
  it("the NDX bot is the one that is configured and on; the SPX bot stays archived and off", () => {
    delete process.env.BOT_SPX_EMA_BIAS_HIDDEN; // what a real server has: nobody set it
    try {
      resetAutomationStores();
      expect(ensureBotRecord(NDX_BOT_ID)).toMatchObject({ enabled: true });
      expect(ensureBotRecord("spx_ema_bias")).toMatchObject({ enabled: false, archived: true });
    } finally {
      process.env.BOT_SPX_EMA_BIAS_HIDDEN = "false";
    }
  });

  it("keeps the per-bot structure: bots are looked up by id, with their own config", () => {
    expect(listBotIds()).toEqual(expect.arrayContaining([NDX_BOT_ID]));
    expect(getBotStaticConfig(NDX_BOT_ID).id).toBe(NDX_BOT_ID);
  });
});

describe("(a) 10 errors in one trading day switch the bot off", () => {
  it("nine errors leave it on; the tenth switches it off, writes the reason to the log and raises an error alert", () => {
    for (let i = 0; i < ERROR_FAILSAFE_THRESHOLD - 1; i++) recordError(NDX_BOT_ID, "open_failed", { i }, BASE_NOW + i);
    expect(bot().enabled).toBe(true);
    expect(alertsStore.all()).toHaveLength(0);

    recordError(NDX_BOT_ID, "open_failed", { i: 9 }, BASE_NOW + 9);
    expect(ERROR_FAILSAFE_THRESHOLD).toBe(10);
    expect(bot()).toMatchObject({ enabled: false, needsAttention: true });
    expect(bot().needsAttentionReason).toContain("10 errors today");

    const row = decisionsStore.all().find((d) => d.outcome === "error_failsafe")!;
    expect(row.reason).toContain("10 errors in one trading day");
    expect(alertsStore.all()).toEqual([expect.objectContaining({ kind: "error", outcome: "error_failsafe", botId: NDX_BOT_ID })]);
  });

  it("says so once, not again for every later error", () => {
    for (let i = 0; i < 13; i++) recordError(NDX_BOT_ID, "close_failed", { i }, BASE_NOW + i);
    expect(decisionsStore.all().filter((d) => d.outcome === "error_failsafe")).toHaveLength(1);
  });

  it("counts by trading day: yesterday's errors don't add to today's, and the count starts again the next day", () => {
    for (let i = 0; i < 9; i++) recordError(NDX_BOT_ID, "open_failed", { i }, BASE_NOW - DAY + i);
    recordError(NDX_BOT_ID, "open_failed", {}, BASE_NOW);
    expect(bot().enabled).toBe(true);
    expect(countTodayErrors(NDX_BOT_ID, BASE_NOW)).toBe(1);

    for (let i = 0; i < 9; i++) recordError(NDX_BOT_ID, "open_failed", { i }, BASE_NOW + i + 1);
    expect(bot().enabled).toBe(false);
    expect(countTodayErrors(NDX_BOT_ID, BASE_NOW + DAY)).toBe(0); // next trading day: back to zero
    expect(errorsStore.all().length).toBeGreaterThan(10); // the history is kept
  });

  it("works through the engine: ten rejected orders in a day, then the next signal finds the bot off", async () => {
    for (let i = 0; i < 10; i++) {
      executor.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "broker said no" });
      await emit("bullish", { now: BASE_NOW + i * 200_000 });
    }
    expect(bot().enabled).toBe(false);
    expect(outcomes().filter((o) => o === "open_rejected")).toHaveLength(10);
    expect(outcomes()).toContain("error_failsafe");
    await emit("bullish", { now: BASE_NOW + 3_000_000 });
    expect(outcomes().at(-1)).toBe("automations_off");
  });
});

describe("(b) a safeguard limit switches the bot off and says why", () => {
  const expectSwitchedOff = (outcome: string) => {
    expect(bot()).toMatchObject({ enabled: false, needsAttention: true });
    expect(bot().needsAttentionReason).toContain(outcome); // the status page shows this
    const row = decisionsStore.all().find((d) => d.outcome === outcome)!; // the bot log shows this
    expect(row.reason).toContain("switched off");
    expect(row.detail).toMatchObject({ botSwitchedOff: true });
    expect(alertsStore.all().some((a) => a.outcome === outcome && a.kind === "warning")).toBe(true);
    expect(runsStore.all().some((r) => r.nodes.some((n) => n.kind === "decision" && !n.result))).toBe(true); // the run trace shows the failed check
  };

  it("the position limit", async () => {
    updateBot(NDX_BOT_ID, { safeguards: { maxPositionsPerType: 2, totalPositionLimit: 1 } });
    positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "held", shortStrike: 20_900, longStrike: 20_890 }));
    await emit("bullish");
    expect(outcomes()).toEqual(["total_position_limit_reached"]);
    expectSwitchedOff("total_position_limit_reached");
  });

  it("the daily limit", async () => {
    updateBot(NDX_BOT_ID, { safeguards: { dailyNewPositionLimit: 1 } });
    await emit("bullish");
    await emit("bearish", { now: BASE_NOW + 200_000 }); // closes the put, then the day's one new position is used up
    expect(outcomes()).toEqual(["opened", "closed", "daily_limit_reached"]);
    expectSwitchedOff("daily_limit_reached");
  });

  it("the allocation limit", async () => {
    updateBot(NDX_BOT_ID, { safeguards: { allocationLimit: 600 } });
    await emit("bullish");
    expect(outcomes()).toEqual(["allocation_limit_reached"]);
    expectSwitchedOff("allocation_limit_reached");
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("afterwards signals find the bot off, and switching it back on puts it back to work", async () => {
    updateBot(NDX_BOT_ID, { safeguards: { allocationLimit: 600 } });
    await emit("bullish");
    await emit("bullish", { now: BASE_NOW + 200_000 });
    expect(outcomes()).toEqual(["allocation_limit_reached", "automations_off"]);

    updateBot(NDX_BOT_ID, { safeguards: { allocationLimit: 2000 } });
    switchBotBackOn();
    await emit("bullish", { now: BASE_NOW + 400_000 });
    expect(outcomes().at(-1)).toBe("opened");
  });

  it("a repeat signal on a side already held is a plain skip, not a limit: the bot stays on", async () => {
    await emit("bullish");
    await emit("bullish", { now: BASE_NOW + 200_000 });
    expect(outcomes()).toEqual(["opened", "already_in_position"]);
    expect(bot()).toMatchObject({ enabled: true, needsAttention: false });
  });
});

describe("(c) the price ladder", () => {
  const legs = { short: { bid: 12.0, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } }; // mid 3.30, worst credit 2.70

  it("the three presets: Normal 4 x 10s, Fast 3 x 5s, Patient 5 x 20s, starting at the mid and stepping toward the bid", () => {
    for (const [mode, count, seconds] of [["normal", 4, 10], ["fast", 3, 5], ["patient", 5, 20]] as const) {
      const built = buildLadder({ side: "credit", legs, mode, finalPercent: 100, width: 10, tick: 0.05 });
      if (!built.ok) throw new Error(built.reason);
      expect(built.ladder.prices).toHaveLength(count);
      expect(built.ladder.secondsEach).toBe(seconds);
      expect(built.ladder.prices[0]).toBe(3.3); // the mid
      expect(built.ladder.prices.at(-1)).toBe(2.7); // the final price
      expect([...built.ladder.prices].sort((a, b) => b - a)).toEqual(built.ladder.prices); // selling: down toward the bid
    }
  });

  it("the final price is a setting: 50% stops half way across", () => {
    const built = buildLadder({ side: "credit", legs, mode: "normal", finalPercent: 50, width: 10, tick: 0.05 });
    if (!built.ok) throw new Error(built.reason);
    expect(built.ladder.final).toBe(3.0);
  });

  it("the final price waits 2 minutes, then cancels", () => {
    expect(ORDER_FILL_TIMEOUT_SECONDS).toBe(120);
  });

  it("every price tried is a line in the run trace, in order, ending with the final price's outcome", async () => {
    executor.setQuotes(legs);
    executor.setMarket({ creditAtMost: 2.5 }); // the market never pays: all four prices are tried
    await emit("bullish");

    const open = runsStore.all()[0].nodes.find((n) => n.kind === "action" && n.action === "open");
    if (!open || open.kind !== "action") throw new Error("no open card");
    expect(open.steps).toHaveLength(4);
    expect(open.steps![0]).toMatch(/^Price 1 of 4: \$3\.30, waited up to 20ms - not filled in time, canceled$/);
    expect(open.steps![3]).toMatch(/^Price 4 of 4: \$2\.70, waited up to 60ms - not filled in time, canceled$/);
    expect(decisionsStore.all()[0].detail).toMatchObject({ steps: open.steps });
  });

  it("a fill stops the ladder and the trace says where", async () => {
    executor.setQuotes(legs);
    executor.setMarket({ creditAtMost: 3.15 });
    await emit("bullish");
    const open = runsStore.all()[0].nodes.find((n) => n.kind === "action");
    if (!open || open.kind !== "action") throw new Error("no open card");
    expect(open.steps).toHaveLength(2);
    expect(open.steps![1]).toMatch(/Price 2 of 4: \$3\.10.*filled 1 of 1$/);
  });

  it("without quotes it is one price, and the trace says so", async () => {
    await emit("bullish");
    const open = runsStore.all()[0].nodes.find((n) => n.kind === "action");
    if (!open || open.kind !== "action") throw new Error("no open card");
    expect(open.steps).toEqual([expect.stringMatching(/^Single price: .*filled 1 of 1$/)]);
  });
});

describe("(d) partial fills", () => {
  it("waits for the rest: every new partial fill restarts the timer", async () => {
    // 3 contracts filling one at a time, 40ms apart. Each wait is only 60ms, so the 120ms it takes in total
    // outlasts a single timer - it only completes because each partial fill restarted it.
    const timeline = [0, 40, 80, 120];
    const t0 = Date.now();
    const fake = {
      async getOrder(): Promise<OrderState> {
        const filled = Math.min(3, timeline.filter((t) => Date.now() - t0 >= t).length - 1);
        return filled >= 3 ? { status: "filled", filledQuantity: 3 } : { status: filled > 0 ? "partially_filled" : "working", filledQuantity: filled };
      },
      cancelOrder: vi.fn(async () => {}),
    } as unknown as BrokerExecutor;
    const result = await watchOrder(fake, "ref", { timeoutMs: 60, partialTimeoutMs: 60, pollIntervalMs: 4 });
    expect(result.timedOut).toBe(false);
    expect(result.state).toMatchObject({ status: "filled", filledQuantity: 3 });
    expect(fake.cancelOrder).not.toHaveBeenCalled();
  });

  it("on timeout the remainder is canceled and the position is open at the partial quantity", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_QUANTITY", "3");
    vi.stubEnv("BOT_NDX_EMA_BIAS_ALLOCATION_LIMIT", "5000");
    executor.queueScenario(NDX_BOT_ID, { kind: "partial", firstFillRatio: 0.34, remainderDelayMs: null }); // 1 of 3, then nothing
    await emit("bullish");

    expect(positionsStore.all()[0]).toMatchObject({ status: "open", filledQuantity: 1, requestedQuantity: 3 });
    expect(ordersStore.all()[0].status).toBe("canceled"); // the rest was canceled
    const opened = decisionsStore.all()[0];
    expect(opened.outcome).toBe("opened");
    expect(opened.reason).toContain("1 of 3 contracts");
    expect(opened.detail).toMatchObject({ partial: true, filledQuantity: 1, requestedQuantity: 3 });
    const open = runsStore.all()[0].nodes.find((n) => n.kind === "action");
    if (!open || open.kind !== "action") throw new Error("no open card");
    expect(open.steps![0]).toContain("partly filled (1 of 3)");
  });

  it("a close that only partly fills leaves the position closing: it isn't called closed, and it keeps its slot", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_QUANTITY", "3");
    positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "open", id: "held", requestedQuantity: 3, filledQuantity: 3 }));
    executor.queueScenario(NDX_BOT_ID, { kind: "partial", firstFillRatio: 0.34, remainderDelayMs: null });
    await emit("bullish");
    expect(outcomes()).toContain("close_partial_fill");
    expect(positionsStore.get("held")?.status).toBe("closing");
    expect(activePositionsForBot(NDX_BOT_ID)).toHaveLength(1);
    expect(executor.placedOrders.filter((o) => o.kind === "open")).toHaveLength(0); // never opens while the old side may still be held
  });
});

describe("(e) closing counts as held, and never gets a second close", () => {
  /** A close order already working at the executor for this position, as a crash or a restart would leave it. */
  function seedCloseInProgress(positionId: string, scenario: Parameters<MockExecutor["queueScenario"]>[1]) {
    executor.queueScenario(NDX_BOT_ID, scenario);
    return executor.placeCloseOrder(positionsStore.get(positionId)!).then(({ ref }) => {
      ordersStore.insert({ id: "ord-seed", positionId, kind: "close", status: "working", limitPrice: 0, filledQuantity: 0, ref, createdAt: BASE_NOW, updatedAt: BASE_NOW });
      return ref;
    });
  }
  const closeOrders = () => executor.placedOrders.filter((o) => o.kind === "close");

  it("every status counts as held: a closing position is in the active set, like Option Alpha's \"any status\"", () => {
    positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "closing", id: "c" }));
    positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "opening", id: "o", shortStrike: 20_900, longStrike: 20_890 }));
    expect(activePositionsForBot(NDX_BOT_ID, "short_put_spread").map((p) => p.id).sort()).toEqual(["c", "o"]);
  });

  it("an opposite position that is closing, with nothing working behind it, is not closed again - and nothing opens", async () => {
    positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "closing", id: "c" }));
    await emit("bullish");
    expect(closeOrders()).toHaveLength(0); // no second close
    expect(executor.placedOrders).toHaveLength(0); // and no open
    expect(outcomes()).toEqual(["close_in_flight"]);
    expect(positionsStore.get("c")?.status).toBe("closing");
    expect(runsStore.all()[0].nodes.find((n) => n.kind === "decision" && n.text.includes("isn't already closing"))).toMatchObject({ result: false });
  });

  it("an opposite signal during a close in progress: the flip waits for that close to be confirmed, then runs the Open step", async () => {
    positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "closing", id: "c" }));
    await seedCloseInProgress("c", { kind: "delayed", delayMs: 40 }); // confirms 40ms from now
    await emit("bullish");

    expect(closeOrders()).toHaveLength(1); // only the one already in progress
    expect(executor.placedOrders.map((o) => o.kind)).toEqual(["close", "open"]);
    expect(outcomes()).toEqual(["closed", "opened"]);
    expect(positionsStore.get("c")).toMatchObject({ status: "closed" });
    expect(decisionsStore.all()[0].reason).toContain("already in progress is confirmed");
    expect(positionsStore.all().find((p) => p.type === "short_put_spread")?.status).toBe("open");
  });

  it("if that close never confirms, the run stops: the other side is never opened, it counts as an error, and the bot is flagged", async () => {
    positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "closing", id: "c" }));
    await seedCloseInProgress("c", { kind: "never" });
    await emit("bullish");
    expect(outcomes()).toEqual(["close_timeout"]);
    expect(executor.placedOrders.filter((o) => o.kind === "open")).toHaveLength(0);
    expect(positionsStore.get("c")?.status).toBe("closing");
    expect(countTodayErrors(NDX_BOT_ID, BASE_NOW)).toBe(1);
    expect(bot().needsAttention).toBe(true);
  });

  it("a closing position of the wanted type counts as held: 'already in position', nothing opens", async () => {
    positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "closing", id: "c", shortStrike: 20_900, longStrike: 20_890 }));
    await emit("bullish");
    expect(outcomes()).toEqual(["already_in_position"]);
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("a closing position keeps its slot in the limits: it can't let a new position open before the old one is gone", async () => {
    updateBot(NDX_BOT_ID, { safeguards: { maxPositionsPerType: 2, totalPositionLimit: 1 } });
    positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "closing", id: "c", shortStrike: 20_900, longStrike: 20_890 }));
    await emit("bullish");
    expect(outcomes()).toEqual(["total_position_limit_reached"]);
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("the flip stays close, confirm, then open: the new side is sent only after the old one's close is confirmed", async () => {
    positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "open", id: "held" }));
    executor.queueScenario(NDX_BOT_ID, { kind: "delayed", delayMs: 30 }); // the close confirms 30ms after it is sent
    await emit("bullish");

    expect(executor.placedOrders.map((o) => o.kind)).toEqual(["close", "open"]);
    expect(outcomes()).toEqual(["closed", "opened"]);
    const [close, open] = ordersStore.all().sort((a, b) => a.createdAt - b.createdAt);
    expect(close.status).toBe("filled");
    expect(open.createdAt).toBeGreaterThanOrEqual(close.createdAt);
    expect(positionsStore.get("held")?.status).toBe("closed");
  });

  it("a failed close stops the run, flags the bot, never opens the other side, and counts toward the 10-error failsafe", async () => {
    positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "open", id: "held" }));
    executor.queueScenario(NDX_BOT_ID, { kind: "never" });
    await emit("bullish");
    expect(outcomes()).toEqual(["close_timeout"]);
    expect(executor.placedOrders.filter((o) => o.kind === "open")).toHaveLength(0);
    expect(positionsStore.get("held")?.status).toBe("closing");
    expect(countTodayErrors(NDX_BOT_ID, BASE_NOW)).toBe(1);
    expect(bot().needsAttention).toBe(true);
    // Nine more failures in the day switch the bot off.
    for (let i = 0; i < 9; i++) recordError(NDX_BOT_ID, "close_failed", { i }, BASE_NOW + i + 1);
    expect(bot().enabled).toBe(false);
  });
});

describe("(A4) dry run runs the whole flow and withholds every order, the flip's close included", () => {
  it("a flip in dry run logs 'would close' then 'would open', sends nothing, and leaves the position and the bot alone", async () => {
    positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "open", id: "held" }));
    await emit("bullish", { dryRun: true });
    expect(outcomes()).toEqual(["dry_run", "dry_run"]);
    expect(decisionsStore.all()[0].reason).toContain("would close");
    expect(decisionsStore.all()[1].reason).toContain("would open");
    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.get("held")?.status).toBe("open");
    expect(bot()).toMatchObject({ enabled: true, needsAttention: false });
    const actions = runsStore.all()[0].nodes.filter((n) => n.kind === "action");
    expect(actions.map((n) => n.kind === "action" && n.action)).toEqual(["close", "open"]);
  });

  it("the Open step is judged as it would be after the close: a limit of one doesn't trip on the position that would be closed", async () => {
    positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "open", id: "held" }));
    updateBot(NDX_BOT_ID, { safeguards: { totalPositionLimit: 1 } });
    await emit("bullish", { dryRun: true });
    expect(outcomes()).not.toContain("total_position_limit_reached");
    expect(bot().enabled).toBe(true);
  });

  it("a close already in progress is 'would wait' in dry run - no second close, nothing sent", async () => {
    positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "closing", id: "c" }));
    await emit("bullish", { dryRun: true });
    expect(outcomes()).toEqual(["dry_run", "dry_run"]);
    expect(decisionsStore.all()[0].reason).toContain("would wait");
    expect(executor.placedOrders).toHaveLength(0);
  });
});

describe("(A1) the strike price source", () => {
  const liveAt = (price: number, ageMs = 3000) => () => ({ price, ageMs });
  const sourceOf = () => (decisionsStore.all().at(-1)!.detail as { priceSource?: Record<string, unknown> }).priceSource;

  it("defaults to the alert's price", () => {
    expect(getBotStaticConfig(NDX_BOT_ID).strikePriceSource).toBe("alert");
  });

  it("alert price: strikes come from the alert, and the log says so with the price and its age", async () => {
    await emit("bullish", { price: 21_003.7, receivedAgoMs: 4000, liveQuote: liveAt(25_000) }); // a live quote exists but is not used
    const [open] = executor.placedOrders;
    expect([open.shortStrike, open.longStrike]).toEqual([20_970, 20_960]); // 21,003.7 - 30, rounded down
    expect(sourceOf()).toMatchObject({ source: "alert", price: 21_003.7 });
    expect((sourceOf() as { ageSeconds: number }).ageSeconds).toBeGreaterThanOrEqual(4);
    expect(positionsStore.all()[0].underlyingAtOpen).toBe(21_003.7);
    const card = runsStore.all()[0].nodes.find((n) => n.kind === "action");
    expect(card && card.kind === "action" && card.params.find((p) => p.label === "Strike price")?.value).toMatch(/^alert price 21,003\.7, \d+(\.\d)?s old$/);
  });

  it("the alert's age includes the flip's wait: it is older by the time the Open step runs", async () => {
    positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "open", id: "held" }));
    executor.queueScenario(NDX_BOT_ID, { kind: "delayed", delayMs: 20 });
    await emit("bullish", { receivedAgoMs: 1000 });
    expect((sourceOf() as { ageSeconds: number }).ageSeconds).toBeGreaterThanOrEqual(1.0); // 1s before the run, plus the close wait
  });

  it("live quote: strikes come from the quote taken when the Open step runs, and the log has the source, price and age", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_STRIKE_PRICE_SOURCE", "live");
    await emit("bullish", { price: 21_003.7, liveQuote: liveAt(21_103.2, 2500) });
    const [open] = executor.placedOrders;
    expect([open.shortStrike, open.longStrike]).toEqual([21_070, 21_060]); // 21,103.2 - 30 = 21,073.2, rounded down
    expect(sourceOf()).toEqual({ source: "live", price: 21_103.2, ageSeconds: 2.5, alertPrice: 21_003.7 });
    expect(positionsStore.all()[0].underlyingAtOpen).toBe(21_103.2);
    expect(decisionsStore.all().at(-1)!.detail).toMatchObject({ strikePlan: { price: 21_103.2 } });
  });

  it("live quote after a flip: the quote is taken after the close, not at the alert", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_STRIKE_PRICE_SOURCE", "live");
    positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "open", id: "held" }));
    executor.queueScenario(NDX_BOT_ID, { kind: "delayed", delayMs: 40 });
    let closed = false;
    const quote = () => {
      closed = positionsStore.get("held")?.status === "closed";
      return { price: 21_050, ageMs: 1000 };
    };
    await emit("bullish", { liveQuote: quote });
    expect(closed).toBe(true); // asked only once the old side was confirmed closed
  });

  it("the price-range check runs on the live price, not only the alert's", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_STRIKE_PRICE_SOURCE", "live");
    await emit("bullish", { price: 21_003.7, liveQuote: liveAt(5_000) }); // the alert is in range (15,000-30,000); the live price is not
    expect(outcomes()).toEqual(["price_out_of_range"]);
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("and on the alert's price in alert mode", async () => {
    await emit("bullish", { price: 5_000 });
    expect(outcomes()).toEqual(["price_out_of_range"]);
  });

  it("with no live quote, or a stale one, it refuses to open (never silently uses the alert), says so, and switches nothing off", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_STRIKE_PRICE_SOURCE", "live");
    await emit("bullish", { liveQuote: () => null });
    await emit("bullish", { now: BASE_NOW + 300_000, liveQuote: liveAt(21_000, 120_000) }); // 2 minutes old, over the 60s allowed
    expect(outcomes()).toEqual(["no_live_price", "no_live_price"]);
    expect(executor.placedOrders).toHaveLength(0);
    expect(bot().enabled).toBe(true);
    expect(alertsStore.all().every((a) => a.kind === "warning")).toBe(true);
    expect(decisionsStore.all()[1].detail).toMatchObject({ priceSource: { source: "live", ageSeconds: 120 } });
  });

  it("an unknown source is refused by name", () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_STRIKE_PRICE_SOURCE", "guess");
    expect(() => getBotStaticConfig(NDX_BOT_ID)).toThrow(/STRIKE_PRICE_SOURCE must be one of alert, live/);
  });
});

describe("(f) identical actions, overlapping strikes, stuck orders", () => {
  it("blocks an identical action already in process: two copies of an alert open one position", async () => {
    const make = (n: number) =>
      receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: "bullish", price: 21_003.7, barTime: "same-bar", interval: "5", raw: { symbol: "NDX" }, now: BASE_NOW + n });
    const [a, b] = [make(0), make(1)];
    await Promise.all([a, b].map((s) => withBotLock(NDX_BOT_ID, () => processSignal(s, { executor, now: s.receivedAt, ...fast }))));
    expect(executor.placedOrders.filter((o) => o.kind === "open")).toHaveLength(1);
    expect(outcomes().sort()).toEqual(["duplicate_signal", "opened"]);
  });

  it("an order still in flight blocks the same side being opened again", async () => {
    positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "opening", id: "inflight", shortStrike: 20_970, longStrike: 20_960 }));
    await emit("bullish");
    expect(outcomes()).toEqual(["already_in_position"]);
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("refuses to open when the same underlying, strike and expiry already exist in the bot", async () => {
    updateBot(NDX_BOT_ID, { safeguards: { maxPositionsPerType: 3, totalPositionLimit: 5 } });
    // 21,003.7 - 30 = 20,973.7, rounded down to 20,970 / 20,960 - a position already sits on those strikes today.
    positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "same", shortStrike: 20_970, longStrike: 20_960 }));
    await emit("bullish");
    expect(outcomes()).toEqual(["overlapping_strikes"]);
    expect(executor.placedOrders).toHaveLength(0);
    expect(decisionsStore.all()[0].detail).toMatchObject({ overlapPositionId: "same" });
  });

  it("a different expiry, or different strikes, is not an overlap", async () => {
    updateBot(NDX_BOT_ID, { safeguards: { maxPositionsPerType: 3, totalPositionLimit: 5 } });
    const tomorrow = easternDateKey(BASE_NOW + DAY);
    positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "other-day", shortStrike: 20_970, longStrike: 20_960, expiry: tomorrow }));
    positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "other-strikes", shortStrike: 20_900, longStrike: 20_890 }));
    await emit("bullish");
    expect(outcomes()).toEqual(["opened"]);
  });

  it("a failed or stuck order keeps its slot, and counts against the limits until it is cleared", async () => {
    executor.queueScenario(NDX_BOT_ID, { kind: "throw", message: "connection dropped" });
    await emit("bullish");
    expect(outcomes()).toEqual(["executor_error"]);
    const stuck = positionsStore.all()[0];
    expect(stuck.status).toBe("opening"); // the order may have reached the broker: unknown, so it stays
    expect(activePositionsForBot(NDX_BOT_ID)).toHaveLength(1);

    // It still counts everywhere a position does: the side is taken, the allocation is used, and today's count includes it.
    expect(sumActiveAllocationRisk(NDX_BOT_ID, 10, 3.5)).toBe(650);
    expect(countTodayNewPositions(NDX_BOT_ID, BASE_NOW, 0)).toBe(1);
    await emit("bullish", { now: BASE_NOW + 200_000 });
    expect(outcomes().at(-1)).toBe("already_in_position"); // can't be opened on top of
    expect(positionsStore.get(stuck.id)?.status).toBe("opening");
    expect(executor.placedOrders).toHaveLength(0);

    // Cleared by a person (here: marked rejected after checking the broker) - the slot is free again.
    resetAutomationStores();
    ensureBotRecord(NDX_BOT_ID);
    positionsStore.insert({ ...stuck, status: "rejected" });
    await emit("bullish", { now: BASE_NOW + 400_000 });
    expect(outcomes().at(-1)).toBe("opened");
  });

  it("a stuck close counts too: the position stays closing and its allocation stays used", async () => {
    positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "open", id: "held" }));
    executor.queueScenario(NDX_BOT_ID, { kind: "never" });
    await emit("bullish");
    expect(positionsStore.get("held")?.status).toBe("closing");
    expect(activePositionsForBot(NDX_BOT_ID).map((p) => p.id)).toEqual(["held"]);
  });
});

describe("(g) no manual orders on positions the bot manages", () => {
  const emptyStatus = (): StatusResponse => ({
    now: BASE_NOW,
    executor: { kind: "mock", venue: "mock", error: null, dryRun: false, testMode: false },
    bots: [],
    positions: [],
    orders: [],
    signals: [],
    alerts: [],
    alertEmail: { enabled: false, to: null },
  });

  it("the status page says so", () => {
    const html = renderToStaticMarkup(createElement(StatusView, { data: emptyStatus(), busyBot: null, results: {}, onToggle: () => {}, onSend: () => {}, onReset: () => {} }));
    expect(html).toMatch(/place manual orders on positions the bot manages/);
  });

  it("the testing walkthrough says so", () => {
    const doc = readFileSync(path.join(process.cwd(), "docs/testing-mode-walkthrough.md"), "utf8");
    expect(doc).toMatch(/manual orders on positions the bot manages/i);
  });
});

describe("(h) the end-of-day sweep", () => {
  const noPrice = { underlyingPrice: () => null };
  const priced = (price: number) => ({ underlyingPrice: () => price });

  it("defaults to estimating, ten minutes before the NDX series closes (4:15pm), at the NDX bot's own sweep time", () => {
    for (const k of ["EOD_SWEEP_TIME", "EOD_SWEEP_MODE"]) vi.stubEnv(`BOT_NDX_EMA_BIAS_${k}`, "");
    expect(getBotStaticConfig(NDX_BOT_ID)).toMatchObject({ eodSweepMode: "estimate", eodSweepTime: "16:05" });
    expect(sweepModeFor(NDX_BOT_ID)).toBe("estimate");
    expect(sweepMinutesFor(NDX_BOT_ID)).toBe(16 * 60 + 5);
    vi.stubEnv("BOT_NDX_EMA_BIAS_EOD_SWEEP_TIME", "16:00");
    expect(sweepMinutesFor(NDX_BOT_ID)).toBe(16 * 60);
  });

  it("the sweep doesn't run before its time, runs once at it, and not again", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_EOD_SWEEP_TIME", "16:05");
    positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "p" }));
    expect(await runDueSweeps(at(16, 4), noPrice)).toEqual([]);
    expect(positionsStore.get("p")?.status).toBe("open");
    expect(await runDueSweeps(at(16, 5), noPrice)).toContain(NDX_BOT_ID);
    expect(positionsStore.get("p")?.status).toBe("expired");
    expect(await runDueSweeps(at(16, 6), noPrice)).toEqual([]);
  });

  it("an unknown sweep mode is refused by name", () => {
    expect(() => updateBot(NDX_BOT_ID, { inputs: { ...getBotStaticConfig(NDX_BOT_ID), eodSweepMode: "guess" as never } })).toThrow(/end-of-day sweep must be one of/);
    vi.stubEnv("BOT_NDX_EMA_BIAS_EOD_SWEEP_MODE", "guess");
    expect(() => getBotStaticConfig(NDX_BOT_ID)).toThrow(/EOD_SWEEP_MODE must be one of estimate, market, manual/);
  });

  describe("estimate (default)", () => {
    it("works the result out from the underlying's price: a put spread's loss grows below the short strike and is capped at the width", async () => {
      positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "keep" })); // short 21,000 / long 20,990, credit 3.50
      const r = await sweepBot(NDX_BOT_ID, at(16, 5), priced(21_100));
      expect(r).toMatchObject({ mode: "estimate", estimated: 1 });
      expect(positionsStore.get("keep")).toMatchObject({ status: "expired", underlyingAtClose: 21_100, settlement: { kind: "estimated", pl: 350, underlyingPrice: 21_100, settleValue: 0 } });

      for (const [price, expected] of [[20_995, -150], [20_900, -650]] as const) {
        resetAutomationStores();
        ensureBotRecord(NDX_BOT_ID);
        positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "p" }));
        await sweepBot(NDX_BOT_ID, at(16, 5), priced(price));
        expect(positionsStore.get("p")?.settlement?.pl).toBe(expected);
      }
    });

    it("a call spread mirrors it", async () => {
      positionsStore.insert(ndxPosition({ type: "short_call_spread", status: "open", id: "c", shortStrike: 21_000, longStrike: 21_010 }));
      await sweepBot(NDX_BOT_ID, at(16, 5), priced(21_004));
      expect(positionsStore.get("c")?.settlement?.pl).toBe(-50); // (3.50 - 4) x 100
    });

    it("scales with the quantity, and shows as an estimate, not a fill", async () => {
      positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "q", requestedQuantity: 3, filledQuantity: 3 }));
      await sweepBot(NDX_BOT_ID, at(16, 5), priced(21_100));
      const p = positionsStore.get("q")!;
      expect(positionPL(p)).toBe(1050);
      expect(positionPLKind(p)).toBe("estimated");
      expect(computeStats([p])).toMatchObject({ priced: 1, settledWithoutFill: 1, closedPL: 1050 });
    });

    it("with no fresh price it estimates nothing: the position waits for a person", async () => {
      positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "p" }));
      const r = await sweepBot(NDX_BOT_ID, at(16, 5), noPrice);
      expect(r).toMatchObject({ estimated: 0, awaitingEntry: 1 });
      expect(positionsStore.get("p")).toMatchObject({ status: "expired" });
      expect(positionsStore.get("p")?.settlement).toBeUndefined();
      expect(positionPL(positionsStore.get("p")!)).toBeNull();
      expect(decisionsStore.all().find((d) => d.outcome === "eod_sweep")?.reason).toContain("waiting for you to enter the P/L");
    });

    it("a position that wasn't fully open is not guessed at", async () => {
      positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "opening", id: "o" }));
      await sweepBot(NDX_BOT_ID, at(16, 5), priced(21_100));
      expect(positionsStore.get("o")?.settlement).toBeUndefined();
    });
  });

  describe("close at market", () => {
    beforeEach(() => vi.stubEnv("BOT_NDX_EMA_BIAS_EOD_SWEEP_MODE", "market"));
    const opts = () => ({ executor, closeConfirmTimeoutMs: 40, pollIntervalMs: 4, underlyingPrice: () => 21_000 });

    it("sends a close order with no limit price, and the position closes on its fill", async () => {
      positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "p" }));
      executor.queueScenario(NDX_BOT_ID, { kind: "instant", averagePrice: 1.25 });
      const r = await sweepBot(NDX_BOT_ID, at(16, 5), opts());
      expect(r).toMatchObject({ mode: "market", closedAtMarket: 1, failed: 0 });
      expect(executor.placedOrders).toEqual([expect.objectContaining({ kind: "close" })]);
      expect(executor.placedOrders[0].price).toBeUndefined(); // no limit = market
      expect(positionsStore.get("p")).toMatchObject({ status: "closed", closePrice: 1.25 });
      expect(positionPLKind(positionsStore.get("p")!)).toBe("fill");
      expect(positionPL(positionsStore.get("p")!)).toBe(225);
    });

    it("a close that doesn't go through flags the bot and leaves the position for a person - it is not quietly expired", async () => {
      positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "p" }));
      executor.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "no market" });
      const r = await sweepBot(NDX_BOT_ID, at(16, 5), opts());
      expect(r).toMatchObject({ closedAtMarket: 0, failed: 1 });
      expect(positionsStore.get("p")?.status).toBe("closing");
      expect(bot().needsAttention).toBe(true);
      expect(bot().needsAttentionReason).toContain("end-of-day sweep");
      expect(errorsStore.all()).toHaveLength(1);
    });

    it("never sends an order in dry-run", async () => {
      vi.stubEnv("AUTOMATION_DRY_RUN", "true");
      positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "p" }));
      await sweepBot(NDX_BOT_ID, at(16, 5), opts());
      expect(executor.placedOrders).toHaveLength(0);
      expect(positionsStore.get("p")?.status).toBe("open");
    });
  });

  describe("manual entry", () => {
    beforeEach(() => vi.stubEnv("BOT_NDX_EMA_BIAS_EOD_SWEEP_MODE", "manual"));

    it("expires the position with no result and waits; the P/L is then typed in, and says so", async () => {
      positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "p" }));
      const r = await sweepBot(NDX_BOT_ID, at(16, 5), priced(21_100)); // a price is available, but manual means manual
      expect(r).toMatchObject({ mode: "manual", awaitingEntry: 1, estimated: 0 });
      expect(positionsStore.get("p")?.settlement).toBeUndefined();

      const entered = enterPositionPL("p", 212.5, at(17, 0));
      expect(entered.settlement).toEqual({ kind: "manual", pl: 212.5, at: at(17, 0) });
      expect(positionPL(entered)).toBe(212.5);
      expect(positionPLKind(entered)).toBe("manual");
      expect(decisionsStore.all().at(-1)?.reason).toContain("+$212.50 entered by hand");
    });

    it("takes only a possible number: no more than the credit kept, no worse than the most it could lose", async () => {
      positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "p" })); // best +350, worst -650
      await sweepBot(NDX_BOT_ID, at(16, 5), noPrice);
      expect(() => enterPositionPL("p", 351)).toThrow(/can't be this trade's result/);
      expect(() => enterPositionPL("p", -651)).toThrow(/can't be this trade's result/);
      expect(() => enterPositionPL("p", Number.NaN)).toThrow(/number of dollars/);
      expect(() => enterPositionPL("p", "12" as never)).toThrow(/number of dollars/);
      expect(enterPositionPL("p", -650).settlement?.pl).toBe(-650);
    });

    it("only an expired position takes one - never an open one, or a fill-priced one - and a person can replace an estimate", async () => {
      positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "open" }));
      positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "closed", id: "closed", closePrice: 1 }));
      expect(() => enterPositionPL("open", 10)).toThrow(/Only an expired position/);
      expect(() => enterPositionPL("closed", 10)).toThrow(/Only an expired position/);
      expect(() => enterPositionPL("nope", 10)).toThrow(/not found/);

      vi.stubEnv("BOT_NDX_EMA_BIAS_EOD_SWEEP_MODE", "estimate");
      await sweepBot(NDX_BOT_ID, at(16, 5), priced(21_100));
      expect(positionsStore.get("open")?.settlement?.kind).toBe("estimated");
      expect(enterPositionPL("open", 300).settlement).toMatchObject({ kind: "manual", pl: 300 });
    });
  });

  it("runs inside the bot's lock, so it never overlaps a signal", async () => {
    positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "p" }));
    let release!: () => void;
    const held = withBotLock(NDX_BOT_ID, () => new Promise<void>((resolve) => (release = resolve)));
    const sweeping = sweepBot(NDX_BOT_ID, at(16, 5), priced(21_100));
    await new Promise((r) => setTimeout(r, 20));
    expect(positionsStore.get("p")?.status).toBe("open"); // waiting its turn behind the signal
    release();
    await held;
    await sweeping;
    expect(positionsStore.get("p")?.status).toBe("expired");
  });

  it("sweeps a bot that has switched itself off: a held position still has to be settled", async () => {
    positionsStore.insert(ndxPosition({ type: "short_put_spread", status: "open", id: "p" }));
    botsStore.update(NDX_BOT_ID, { enabled: false });
    await sweepBot(NDX_BOT_ID, at(16, 5), priced(21_100));
    expect(positionsStore.get("p")?.status).toBe("expired");
  });

  it("with nothing held it does nothing and writes nothing", async () => {
    const r = await sweepBot(NDX_BOT_ID, at(16, 5), priced(21_100));
    expect(r).toMatchObject({ swept: 0 });
    expect(decisionsStore.all()).toHaveLength(0);
  });

  it("shows on the status page: the estimate is marked, and a position with no result asks for one", () => {
    const base = { botId: NDX_BOT_ID, underlying: "NDX", type: "short_put_spread" as const, shortStrike: 21_000, longStrike: 20_990, requestedQuantity: 1, filledQuantity: 1, expiry: "2026-10-06", credit: 3.5, openedAt: BASE_NOW, closedAt: BASE_NOW + 1000, status: "expired" };
    const data: StatusResponse = {
      now: BASE_NOW,
      executor: { kind: "mock", venue: "mock", error: null, dryRun: false, testMode: false },
      bots: [],
      positions: [
        { ...base, id: "est", settlement: { kind: "estimated", pl: 350 } },
        { ...base, id: "none" },
      ] as StatusResponse["positions"],
      orders: [],
      signals: [],
      alerts: [],
      alertEmail: { enabled: false, to: null },
    };
    const html = renderToStaticMarkup(createElement(StatusView, { data, busyBot: null, results: {}, onToggle: () => {}, onSend: () => {}, onReset: () => {} }));
    expect(html).toContain("+$350.00");
    expect(html).toContain("est.");
    expect(html).toContain("Waiting for your P/L");
    expect(html).toContain("to enter");
  });
});
