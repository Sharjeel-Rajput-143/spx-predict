import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withBotLock } from "./botLock";
import { ensureBotRecord, getBotLimits, getBotStaticConfig, updateBot } from "./bots";
import { summarizeBot } from "./summary";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { __resetSweepState, runDueSweeps, sweepMinutesFor } from "./eodSweep";
import { MockExecutor } from "./executor";
import { countTodayNewPositions } from "./safeguards";
import { botsStore, decisionsStore, positionsStore, runsStore } from "./store";
import { maxRisk } from "./strikes";
import { BASE_NOW, BTC_BOT_ID, NDX_BOT_ID, TEST_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import type { SignalDirection } from "./types";

// The addendum's NDX bot, driven through the same engine as SPX: same code,
// different configuration.

setTestBotEnv();
setNdxTestEnv();

let executor: MockExecutor;
const fast = { closeConfirmTimeoutMs: 50, orderFillTimeoutMs: 50, pollIntervalMs: 5 };

function emit(
  botId: string,
  direction: SignalDirection,
  opts: { price?: number; barTime?: string; now?: number; symbol?: string | null; timeouts?: typeof fast } = {},
) {
  const now = opts.now ?? BASE_NOW;
  const signal = receiveAndSaveSignal({
    botId,
    signal: direction,
    price: opts.price ?? (botId === NDX_BOT_ID ? 21_003.7 : 7720),
    barTime: opts.barTime ?? `bar-${botId}-${direction}-${now}`,
    interval: "5",
    raw: opts.symbol === null ? {} : { symbol: opts.symbol ?? (botId === NDX_BOT_ID ? "NDX" : "SPX") },
    now,
  });
  return processSignal(signal, { executor, now, ...(opts.timeouts ?? fast) }).then(() => signal);
}

const outcomesOf = (botId: string) => decisionsStore.query((d) => d.botId === botId).map((d) => d.outcome);
const ndxPosition = (over: Parameters<typeof buildPosition>[0]) =>
  buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", shortStrike: 21_000, longStrike: 20_990, requestedQuantity: 1, filledQuantity: 1, credit: 3.5, ...over });

beforeEach(() => {
  resetAutomationStores();
  __resetSweepState();
  setNdxTestEnv();
  executor = new MockExecutor();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("NDX bot config", () => {
  it("is 1 contract, 10 points wide, 2000 allocation, NDXP, on NDX - from config, not code", () => {
    expect(getBotStaticConfig(NDX_BOT_ID)).toMatchObject({
      underlying: "NDX",
      optionRoot: "NDXP",
      quantity: 1,
      widthPoints: 10,
      allocationLimit: 2000,
    });
  });

  it("needs no settings at all: with none of the optional ones set it has working defaults", () => {
    for (const k of ["STRIKE_INCREMENT", "OPENING_CREDIT_ESTIMATE", "PRICE_MIN", "PRICE_MAX", "EOD_SWEEP_TIME", "OPTION_ROOT", "PUT_SHORT_OFFSET", "CALL_SHORT_OFFSET"]) vi.stubEnv(`BOT_NDX_EMA_BIAS_${k}`, "");
    const c = getBotStaticConfig(NDX_BOT_ID);
    expect(c).toMatchObject({ strikeIncrement: 5, openingCreditEstimate: 3.5, eodSweepTime: "16:05", eodSweepMode: "estimate", optionRoot: "NDXP", putShortOffset: -0.01, callShortOffset: 0.01 });
    expect(c.priceRange).toBeUndefined();
    const summary = summarizeBot(NDX_BOT_ID);
    expect(summary).toMatchObject({ name: "NDX Bias Bot", enabled: true, configError: null, missingSettings: null });
  });

  it("without a price range there is no sanity check on the price - the other checks still apply", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_PRICE_MIN", "");
    vi.stubEnv("BOT_NDX_EMA_BIAS_PRICE_MAX", "");
    await emit(NDX_BOT_ID, "bullish", { symbol: "SPX", barTime: "m" }); // the symbol check still refuses a wrong chart
    expect(outcomesOf(NDX_BOT_ID)).toEqual(["symbol_mismatch"]);
  });

  it("the price range is both ends or neither", () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_PRICE_MAX", "");
    expect(() => getBotStaticConfig(NDX_BOT_ID)).toThrow(/PRICE_MIN and BOT_NDX_EMA_BIAS_PRICE_MAX must be set together/);
  });

  it.each([
    ["BOT_NDX_EMA_BIAS_STRIKE_INCREMENT", "BOT_NDX_EMA_BIAS_STRIKE_INCREMENT"],
    ["BOT_NDX_EMA_BIAS_OPENING_CREDIT_ESTIMATE", "BOT_NDX_EMA_BIAS_OPENING_CREDIT_ESTIMATE"],
    ["BOT_NDX_EMA_BIAS_EOD_SWEEP_TIME", "HH:MM"],
  ])("a setting that is set wrongly (%s) is refused with a message", async (name, expected) => {
    vi.stubEnv(name, "abc");
    expect(() => getBotStaticConfig(NDX_BOT_ID)).toThrow(expected);
    await emit(NDX_BOT_ID, "bullish");
    expect(executor.placedOrders).toHaveLength(0);
    const decision = decisionsStore.query((d) => d.botId === NDX_BOT_ID)[0];
    expect(decision.outcome).toBe("config_error");
    expect(decision.reason).toContain(expected);
  });

  it("#4 refuses width 10 with increment 25 (width_not_multiple_of_increment), starts with increment 5", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_STRIKE_INCREMENT", "25");
    expect(() => getBotStaticConfig(NDX_BOT_ID)).toThrow(/width_not_multiple_of_increment/);
    await emit(NDX_BOT_ID, "bullish");
    expect(executor.placedOrders).toHaveLength(0);
    expect(decisionsStore.query((d) => d.botId === NDX_BOT_ID)[0].reason).toMatch(/width_not_multiple_of_increment/);

    vi.stubEnv("BOT_NDX_EMA_BIAS_STRIKE_INCREMENT", "5");
    expect(getBotStaticConfig(NDX_BOT_ID).strikeIncrement).toBe(5);
  });

  it("#7 refuses an opening credit equal to or above the 10 point width", () => {
    for (const credit of ["10", "12.5"]) {
      vi.stubEnv("BOT_NDX_EMA_BIAS_OPENING_CREDIT_ESTIMATE", credit);
      expect(() => getBotStaticConfig(NDX_BOT_ID)).toThrow(/less than the spread width/);
    }
    vi.stubEnv("BOT_NDX_EMA_BIAS_OPENING_CREDIT_ESTIMATE", "9.95");
    expect(getBotStaticConfig(NDX_BOT_ID).openingCreditEstimate).toBe(9.95);
  });
});

describe("signals reach only their own bot", () => {
  it("#1 an NDX bullish signal opens only an NDX short put spread; the SPX bot is untouched", async () => {
    ensureBotRecord(TEST_BOT_ID);
    positionsStore.insert(buildPosition({ id: "spx-call", type: "short_call_spread", status: "open" }));

    await emit(NDX_BOT_ID, "bullish");

    expect(executor.placedOrders).toHaveLength(1);
    expect(executor.placedOrders[0]).toMatchObject({ botId: NDX_BOT_ID, kind: "open", positionType: "short_put_spread", quantity: 1 });
    expect(positionsStore.get("spx-call")?.status).toBe("open");
    expect(positionsStore.query((p) => p.botId === TEST_BOT_ID)).toHaveLength(1);
    expect(decisionsStore.query((d) => d.botId === TEST_BOT_ID)).toHaveLength(0);
    expect(positionsStore.query((p) => p.botId === NDX_BOT_ID)[0]).toMatchObject({ underlying: "NDX", type: "short_put_spread", status: "open" });
  });

  it("#1 an NDX bearish signal opens only a short call spread, and an SPX signal leaves the NDX position alone", async () => {
    await emit(NDX_BOT_ID, "bearish");
    expect(executor.placedOrders.map((o) => `${o.botId}:${o.positionType}`)).toEqual([`${NDX_BOT_ID}:short_call_spread`]);

    await emit(TEST_BOT_ID, "bullish", { now: BASE_NOW + 1000 });
    const ndx = positionsStore.query((p) => p.botId === NDX_BOT_ID);
    expect(ndx).toHaveLength(1);
    expect(ndx[0].status).toBe("open");
    expect(executor.placedOrders.filter((o) => o.botId === NDX_BOT_ID)).toHaveLength(1);
  });

  it("#2 a signal whose symbol is SPX, sent to the NDX bot, is rejected as symbol_mismatch", async () => {
    await emit(NDX_BOT_ID, "bullish", { symbol: "SPX", price: 21_000 });
    expect(outcomesOf(NDX_BOT_ID)).toEqual(["symbol_mismatch"]);
    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.all()).toHaveLength(0);
  });

  it("the symbol check ignores case and spacing", async () => {
    await emit(NDX_BOT_ID, "bullish", { symbol: " ndx " });
    expect(outcomesOf(NDX_BOT_ID)).toEqual(["opened"]);
  });
});

describe("NDX strikes and risk", () => {
  it("#5 rounds to the increment and always derives the long strike from the short strike", async () => {
    // 21,003.7 - 30 = 20,973.7 -> rounded DOWN to 20,970; a long strike taken from the price (21,003.7 - 10)
    // would be nowhere near it. Derived correctly it is exactly one width below the short.
    await emit(NDX_BOT_ID, "bullish");
    const [open] = executor.placedOrders;
    expect([open.shortStrike, open.longStrike]).toEqual([20_970, 20_960]);
    expect(open.shortStrike % 5).toBe(0);
    expect(open.shortStrike - open.longStrike).toBe(10);
  });

  it("#5 a call spread goes the other way: 21,003.7 + 30 -> 21,035, long 21,045", async () => {
    await emit(NDX_BOT_ID, "bearish");
    const [open] = executor.placedOrders;
    expect([open.shortStrike, open.longStrike]).toEqual([21_035, 21_045]);
  });

  it("#6 max risk is width x 100 x quantity minus the credit, and the position is refused if it doesn't fit", async () => {
    expect(maxRisk(10, 1, 0)).toBe(1000);
    expect(maxRisk(10, 1, 3.5)).toBe(650);

    // $650 at risk against a $600 allocation: refused, nothing sent.
    ensureBotRecord(NDX_BOT_ID);
    updateBot(NDX_BOT_ID, { safeguards: { allocationLimit: 600 } });
    await emit(NDX_BOT_ID, "bullish");
    expect(outcomesOf(NDX_BOT_ID)).toEqual(["allocation_limit_reached"]);
    expect(executor.placedOrders).toHaveLength(0);

    // The limit switched the bot off, with the reason; against the real $2,000 allocation, switched back on, the same signal fits.
    expect(botsStore.get(NDX_BOT_ID)?.enabled).toBe(false);
    updateBot(NDX_BOT_ID, { safeguards: { allocationLimit: 2000 } });
    botsStore.update(NDX_BOT_ID, { enabled: true, needsAttention: false, needsAttentionReason: null });
    await emit(NDX_BOT_ID, "bullish", { barTime: "retry", now: BASE_NOW + 200_000 });
    expect(executor.placedOrders).toHaveLength(1);
  });

  it("#8 a price outside the sanity range is refused as price_out_of_range - an SPX-sized price can't make NDX strikes", async () => {
    await emit(NDX_BOT_ID, "bullish", { price: 7720, symbol: null }); // no symbol sent: only the range stands in the way
    expect(outcomesOf(NDX_BOT_ID)).toEqual(["price_out_of_range"]);
    expect(executor.placedOrders).toHaveLength(0);
    expect(decisionsStore.query((d) => d.botId === NDX_BOT_ID)[0].reason).toMatch(/15,000 - 30,000/);
  });

  it("#8 a zero or negative price is refused too", async () => {
    await emit(NDX_BOT_ID, "bullish", { price: 0 });
    await emit(NDX_BOT_ID, "bearish", { price: -5, now: BASE_NOW + 1000 });
    expect(outcomesOf(NDX_BOT_ID)).toEqual(["price_out_of_range", "price_out_of_range"]);
  });
});

describe("NDX position limits and flips", () => {
  it("#9 with a total limit of 1, a second same-side signal while one is active opens nothing", async () => {
    await emit(NDX_BOT_ID, "bullish");
    await emit(NDX_BOT_ID, "bullish", { barTime: "bar-2", now: BASE_NOW + 200_000 });
    expect(executor.placedOrders).toHaveLength(1);
    expect(outcomesOf(NDX_BOT_ID)).toEqual(["opened", "already_in_position"]);
  });

  it("#9 a flip closes first, waits for the confirmation, then opens - with the NDX numbers", async () => {
    await emit(NDX_BOT_ID, "bullish");
    await emit(NDX_BOT_ID, "bearish", { barTime: "bar-2", now: BASE_NOW + 200_000 });

    expect(executor.placedOrders.map((o) => `${o.kind}:${o.positionType}`)).toEqual([
      "open:short_put_spread",
      "close:short_put_spread",
      "open:short_call_spread",
    ]);
    const [, close, open] = executor.placedOrders;
    expect([close.shortStrike, close.longStrike, close.quantity]).toEqual([20_970, 20_960, 1]);
    expect([open.shortStrike, open.longStrike, open.quantity]).toEqual([21_035, 21_045, 1]);
    expect(positionsStore.query((p) => p.status === "open")).toHaveLength(1);
  });

  it("a flip whose close never fills opens nothing", async () => {
    await emit(NDX_BOT_ID, "bullish");
    executor.queueScenario(NDX_BOT_ID, { kind: "never" });
    await emit(NDX_BOT_ID, "bearish", { barTime: "bar-2", now: BASE_NOW + 200_000 });
    expect(executor.placedOrders.filter((o) => o.kind === "open")).toHaveLength(1);
    expect(outcomesOf(NDX_BOT_ID).at(-1)).toBe("close_timeout");
  });
});

const noPrice = { underlyingPrice: () => null };

describe("per-bot hours and sweep", () => {
  it("can have its own signal window", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_HOURS_START", "11:00");
    vi.stubEnv("BOT_NDX_EMA_BIAS_HOURS_END", "15:00");
    await emit(NDX_BOT_ID, "bullish"); // 10:40am ET - inside the SPX window, outside this one
    expect(outcomesOf(NDX_BOT_ID)).toEqual(["outside_hours"]);
    await emit(TEST_BOT_ID, "bullish");
    expect(outcomesOf(TEST_BOT_ID)).toEqual(["opened"]);
  });

  it("#10 the end-of-day sweep uses each bot's own sweep time", async () => {
    expect(sweepMinutesFor(NDX_BOT_ID)).toBe(16 * 60 + 15);
    expect(sweepMinutesFor(TEST_BOT_ID)).toBe(16 * 60 + 5);

    positionsStore.insert(ndxPosition({ id: "ndx-open", type: "short_put_spread", status: "open" }));
    positionsStore.insert(buildPosition({ id: "spx-open", type: "short_put_spread", status: "open" }));

    const at = (h: number, m: number) => Date.UTC(2026, 9, 6, h + 4, m); // EDT = UTC-4
    expect(await runDueSweeps(at(16, 0), noPrice)).toEqual([]); // before either
    expect(await runDueSweeps(at(16, 10), noPrice)).toEqual([TEST_BOT_ID, BTC_BOT_ID, LIVE_BOT_ID]); // SPX's 4:05 (and the BTC bot's, on the simulation here) has passed, NDX's 4:15 has not
    expect(positionsStore.get("spx-open")?.status).toBe("expired");
    expect(positionsStore.get("ndx-open")?.status).toBe("open");

    expect(await runDueSweeps(at(16, 20), noPrice)).toEqual([NDX_BOT_ID]);
    expect(positionsStore.get("ndx-open")?.status).toBe("expired");
    expect(await runDueSweeps(at(16, 30), noPrice)).toEqual([]); // each bot sweeps once a day
  });
});

describe("two bots at the same moment", () => {
  it("#11 keep separate queues and separate counters", async () => {
    const done: string[] = [];
    // NDX's fill is slow; SPX must not wait behind it.
    executor.queueScenario(NDX_BOT_ID, { kind: "delayed", delayMs: 80 });
    const slow = { closeConfirmTimeoutMs: 500, orderFillTimeoutMs: 500, pollIntervalMs: 5 };

    const run = (botId: string, direction: SignalDirection) => {
      const signal = receiveAndSaveSignal({
        botId,
        signal: direction,
        price: botId === NDX_BOT_ID ? 21_003.7 : 7720,
        barTime: `same-moment-${botId}`,
        interval: "5",
        raw: { symbol: botId === NDX_BOT_ID ? "NDX" : "SPX" },
        now: BASE_NOW,
      });
      return withBotLock(botId, () => processSignal(signal, { executor, now: BASE_NOW, ...slow })).then(() => done.push(botId));
    };

    await Promise.all([run(NDX_BOT_ID, "bullish"), run(TEST_BOT_ID, "bullish")]);

    expect(done).toEqual([TEST_BOT_ID, NDX_BOT_ID]);
    expect(countTodayNewPositions(NDX_BOT_ID, BASE_NOW)).toBe(1);
    expect(countTodayNewPositions(TEST_BOT_ID, BASE_NOW)).toBe(1);
    expect(positionsStore.query((p) => p.botId === NDX_BOT_ID).map((p) => p.underlying)).toEqual(["NDX"]);
    expect(positionsStore.query((p) => p.botId === TEST_BOT_ID).map((p) => p.underlying)).toEqual(["SPX"]);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBeFalsy();
  });

  it("#11 one bot's daily limit does not count the other bot's positions", async () => {
    ensureBotRecord(NDX_BOT_ID);
    updateBot(NDX_BOT_ID, { safeguards: { dailyNewPositionLimit: 1 } });
    await emit(NDX_BOT_ID, "bullish");
    await emit(TEST_BOT_ID, "bullish");
    await emit(NDX_BOT_ID, "bearish", { barTime: "bar-2", now: BASE_NOW + 200_000 }); // flips: close, then a 2nd opening -> over NDX's limit of 1
    expect(outcomesOf(TEST_BOT_ID)).toEqual(["opened"]);
    expect(outcomesOf(NDX_BOT_ID)).toContain("daily_limit_reached");
  });
});

describe("the live bot's settings, mirrored", () => {
  it("NDX offsets default to -0.01 / +0.01 (marked: owner to confirm for NDX), rounding to out of the money", () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_PUT_SHORT_OFFSET", "");
    vi.stubEnv("BOT_NDX_EMA_BIAS_CALL_SHORT_OFFSET", "");
    expect(getBotStaticConfig(NDX_BOT_ID)).toMatchObject({ putShortOffset: -0.01, callShortOffset: 0.01, strikeRounding: "outward", openPricePercent: 100, closePricePercent: 100 });
  });

  it("with the default offsets the NDX strikes land at the first strike at or beyond the price", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_PUT_SHORT_OFFSET", "");
    vi.stubEnv("BOT_NDX_EMA_BIAS_CALL_SHORT_OFFSET", "");
    await emit(NDX_BOT_ID, "bullish");
    await emit(NDX_BOT_ID, "bearish", { barTime: "b2", now: BASE_NOW + 200_000 });
    const opens = executor.placedOrders.filter((o) => o.kind === "open");
    expect(opens.map((o) => [o.shortStrike, o.longStrike])).toEqual([[21_000, 20_990], [21_005, 21_015]]);
  });

  it("nearest rounding is selectable, and the strike follows", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_STRIKE_ROUNDING", "nearest");
    expect(getBotStaticConfig(NDX_BOT_ID).strikeRounding).toBe("nearest");
    await emit(NDX_BOT_ID, "bullish"); // 21,003.7 - 30 = 20,973.7 -> 20,975, not 20,970
    expect(executor.placedOrders[0].shortStrike).toBe(20_975);
  });

  it("an unknown rounding mode is refused, not guessed", () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_STRIKE_ROUNDING", "sideways");
    expect(() => getBotStaticConfig(NDX_BOT_ID)).toThrow(/"outward" or "nearest"/);
  });

  it("total position limit: SPX holds up to 3 by default, NDX stays at 1", () => {
    vi.stubEnv("BOT_SPX_EMA_BIAS_TOTAL_POSITION_LIMIT", "");
    expect(getBotLimits(TEST_BOT_ID).totalPositionLimit).toBe(3);
    expect(getBotLimits(NDX_BOT_ID).totalPositionLimit).toBe(1);
    expect(getBotLimits(TEST_BOT_ID)).toMatchObject({ dailyNewPositionLimit: 10 });
    // A safeguard set on the bot still wins.
    ensureBotRecord(NDX_BOT_ID);
    updateBot(NDX_BOT_ID, { safeguards: { totalPositionLimit: 2 } });
    expect(getBotLimits(NDX_BOT_ID).totalPositionLimit).toBe(2);
  });

  it.each([["0"], ["-5"], ["101"], ["abc"]])("an order price of %s%% of bid/ask is refused", (value) => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_OPEN_PRICE_PERCENT", value);
    expect(() => getBotStaticConfig(NDX_BOT_ID)).toThrow();
  });

  it("the price percent travels with the order (the mock has no bid/ask, so it only records it)", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_OPEN_PRICE_PERCENT", "80");
    const seen: unknown[] = [];
    const spy = vi.spyOn(executor, "placeOpenOrder").mockImplementation(async (req) => {
      seen.push(req.pricePercent);
      return { ref: "mock-x" };
    });
    await emit(NDX_BOT_ID, "bullish");
    expect(seen).toEqual([80]);
    spy.mockRestore();
  });
});

describe("every decision carries the target price, rounding mode and chosen strikes", () => {
  const plans = (bot: string) => decisionsStore.query((d) => d.botId === bot).map((d) => (d.detail.strikePlan as { text: string } | undefined)?.text);

  it("an opened signal", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_PUT_SHORT_OFFSET", "");
    await emit(NDX_BOT_ID, "bullish");
    expect(decisionsStore.all()[0].detail.strikePlan).toMatchObject({ price: 21_003.7, offset: -0.01, target: 21_003.69, rounding: "outward", increment: 5, shortStrike: 21_000, longStrike: 20_990 });
    expect(plans(NDX_BOT_ID)).toEqual(["Target 21,003.69 (21,003.7 - 0.01), rounded down to 5 -> short 21,000, long 20,990"]);
  });

  it("a flip's close and open both carry it, and the run's strike check shows it", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_PUT_SHORT_OFFSET", "");
    vi.stubEnv("BOT_NDX_EMA_BIAS_CALL_SHORT_OFFSET", "");
    await emit(NDX_BOT_ID, "bullish");
    await emit(NDX_BOT_ID, "bearish", { barTime: "b2", now: BASE_NOW + 200_000 });
    const text = plans(NDX_BOT_ID);
    expect(text).toHaveLength(3); // opened, closed, opened
    expect(text.slice(1).every((t) => t?.includes("rounded up to 5 -> short 21,005, long 21,015"))).toBe(true);
  });

  it("skipped signals carry it too: outside hours, off, mismatch, out of range", async () => {
    await emit(NDX_BOT_ID, "bullish", { symbol: "SPX", barTime: "m" }); // symbol_mismatch
    await emit(NDX_BOT_ID, "bullish", { price: 7720, symbol: null, barTime: "r" }); // price_out_of_range
    ensureBotRecord(NDX_BOT_ID);
    botsStore.update(NDX_BOT_ID, { enabled: false });
    await emit(NDX_BOT_ID, "bullish", { barTime: "off" }); // automations_off
    expect(outcomesOf(NDX_BOT_ID)).toEqual(["symbol_mismatch", "price_out_of_range", "automations_off"]);
    expect(plans(NDX_BOT_ID).every((t) => typeof t === "string" && t.includes("Target"))).toBe(true);
  });

  it("the run trace shows the target, the mode and the strikes in the strike check and on the Open card", async () => {
    await emit(NDX_BOT_ID, "bullish");
    const run = runsStore.all()[0];
    const strikes = run.nodes.find((n) => n.kind === "decision" && n.text.startsWith("Strikes pass"));
    expect(strikes).toMatchObject({ measured: "Target 20,973.7 (21,003.7 - 30), rounded down to 5 -> short 20,970, long 20,960" });
    const open = run.nodes.find((n) => n.kind === "action");
    expect(open).toMatchObject({ params: expect.arrayContaining([{ label: "Short put", value: "20970 (target 20,973.7 = 21003.7 - 30, rounded down to 5)" }]) });
  });
});

describe("values saved from the built-in canvas are what the engine uses", () => {
  const saved = (changes: Record<string, unknown>) => {
    const { id: _id, ...base } = getBotStaticConfig(NDX_BOT_ID);
    ensureBotRecord(NDX_BOT_ID);
    updateBot(NDX_BOT_ID, { inputs: { ...base, ...changes } as never });
  };

  it("a trading window saved on the time node is enforced, and clearing it returns to the default", async () => {
    saved({ hours: { start: "11:00", end: "15:00" } }); // BASE_NOW is 10:40am ET
    await emit(NDX_BOT_ID, "bullish");
    expect(outcomesOf(NDX_BOT_ID)).toEqual(["outside_hours"]);
    expect(getBotStaticConfig(NDX_BOT_ID).hours).toEqual({ start: "11:00", end: "15:00" });

    const { hours: _drop, ...rest } = getBotStaticConfig(NDX_BOT_ID);
    updateBot(NDX_BOT_ID, { inputs: rest as never });
    await emit(NDX_BOT_ID, "bullish", { barTime: "b2", now: BASE_NOW + 200_000 });
    expect(outcomesOf(NDX_BOT_ID)).toEqual(["outside_hours", "opened"]);
  });

  it("an offset, width, size and rounding saved on the open node change the strikes the next signal gets", async () => {
    saved({ putShortOffset: -0.5, widthPoints: 15, strikeRounding: "nearest", quantity: 2, allocationLimit: 5000 });
    await emit(NDX_BOT_ID, "bullish"); // 21,003.7 - 0.5 = 21,003.2 -> nearest 21,005; long 15 below
    expect(executor.placedOrders[0]).toMatchObject({ shortStrike: 21_005, longStrike: 20_990, quantity: 2 });
  });

  it("a bad window or price is refused with a message, not saved", () => {
    expect(() => saved({ hours: { start: "15:00", end: "11:00" } })).toThrow(/start before they end/);
    expect(() => saved({ closePricePercent: 150 })).toThrow(/percent of bid\/ask/);
    expect(() => saved({ widthPoints: 12 })).toThrow(/multiple of the strike increment/);
    expect(getBotStaticConfig(NDX_BOT_ID).hours).toBeUndefined();
  });
});
