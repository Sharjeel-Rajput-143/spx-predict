import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord, getBotStaticConfig, updateBot } from "./bots";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { exitMet, runExitChecks } from "./exitChecks";
import { MockExecutor } from "./executor";
import { resolveQuantity, resolveStrikeInputs, validateOpenSettings } from "./openSettings";
import type { LegQuotes } from "./smartPricing";
import { botsStore, decisionsStore, positionsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import type { SignalDirection } from "./types";

setTestBotEnv();
setNdxTestEnv();

const timing = { closeConfirmTimeoutMs: 80, orderFillTimeoutMs: 80, pollIntervalMs: 4, ladderStepMs: 10 };
let executor: MockExecutor;
let seq = 0;

async function emit(direction: SignalDirection, now = BASE_NOW + seq * 200_000, price = 21_003.7) {
  seq++;
  const signal = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price, barTime: `b${seq}`, interval: "5", raw: { symbol: "NDX" }, now });
  await processSignal(signal, { executor, now, ...timing });
}
const set = (open: unknown) => updateBot(NDX_BOT_ID, { openSettings: { bullish: open as never } });
const puts = () => positionsStore.query((p) => p.type === "short_put_spread");
const lastOutcome = () => decisionsStore.all().at(-1)?.outcome;

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  seq = 0;
  executor = new MockExecutor();
  ensureBotRecord(NDX_BOT_ID);
  botsStore.update(NDX_BOT_ID, { safeguards: { totalPositionLimit: 5, maxPositionsPerType: 3 } });
});
afterEach(() => vi.unstubAllEnvs());

describe("what is accepted", () => {
  it("takes every part, and drops nothing it cannot read", () => {
    const ok = validateOpenSettings({ shortStrike: { method: "percent", amount: 0.5, side: "below" }, longStrike: { method: "points", amount: 10 }, size: { method: "contracts", count: 2 }, tags: [" a ", "a", "b"], entry: { lessOpen: 2 }, exit: { stopPercent: 100 }, pricing: { speed: "fast", percent: 100 } });
    expect(ok.ok && ok.value.tags).toEqual(["a", "b"]);
  });
  it("refuses bad values with the reason", () => {
    expect(validateOpenSettings({ shortStrike: { method: "flat", strike: -1 } })).toMatchObject({ ok: false });
    expect(validateOpenSettings({ shortStrike: { method: "points", amount: 1, side: "sideways" } })).toMatchObject({ ok: false });
    expect(validateOpenSettings({ size: { method: "contracts", count: 0 } })).toMatchObject({ ok: false });
    expect(validateOpenSettings({ size: { method: "allocation", percent: 150 } })).toMatchObject({ ok: false });
    expect(validateOpenSettings({ entry: { lessOpen: 0 } })).toMatchObject({ ok: false });
    expect(validateOpenSettings({ position: { midMin: 5, midMax: 1 } })).toMatchObject({ ok: false });
    expect(validateOpenSettings({ exit: { profitPercent: 0 } })).toMatchObject({ ok: false });
  });
  it("an opening order always has a limit price: no Market, no position trade price", () => {
    expect(validateOpenSettings({ pricing: { speed: "market" } })).toMatchObject({ ok: false });
    expect(validateOpenSettings({ pricing: { speed: "off", tradePrice: { op: "×", value: 0.5 } } })).toMatchObject({ ok: false });
  });
  it("is saved per trigger, and null returns it to the bot's own inputs", () => {
    set({ size: { method: "contracts", count: 2 } });
    expect(botsStore.get(NDX_BOT_ID)!.openSettings!.bullish!.size).toEqual({ method: "contracts", count: 2 });
    expect(botsStore.get(NDX_BOT_ID)!.openSettings!.bearish).toBeUndefined();
    set(null);
    expect(botsStore.get(NDX_BOT_ID)!.openSettings!.bullish).toBeUndefined();
    expect(() => set({ size: { method: "contracts", count: 0 } })).toThrow(/contracts/);
  });
});

describe("working out strikes and size", () => {
  const cfg = () => getBotStaticConfig(NDX_BOT_ID);
  it("a percent from the price", () => {
    const r = resolveStrikeInputs(cfg(), "short_put_spread", 20_000, { shortStrike: { method: "percent", amount: 1, side: "below" } });
    expect(r.ok && r.inputs.putShortOffset).toBe(-200);
  });
  it("a flat short strike", () => {
    const r = resolveStrikeInputs(cfg(), "short_put_spread", 20_003.7, { shortStrike: { method: "flat", strike: 19_950 } });
    expect(r.ok && r.inputs.putShortOffset).toBe(-53.7);
  });
  it("a flat long strike on the wrong side is refused", () => {
    const r = resolveStrikeInputs(cfg(), "short_put_spread", 20_000, { shortStrike: { method: "flat", strike: 19_950 }, longStrike: { method: "flat", strike: 19_960 } });
    expect(r.ok).toBe(false);
  });
  it("a long strike a number of points from the short leg sets the width", () => {
    const r = resolveStrikeInputs(cfg(), "short_put_spread", 20_000, { longStrike: { method: "points", amount: 25 } });
    expect(r.ok && r.inputs.widthPoints).toBe(25);
  });
  it("a percent width is snapped to the increment and is at least one", () => {
    const r = resolveStrikeInputs(cfg(), "short_put_spread", 20_000, { shortStrike: { method: "flat", strike: 20_000 }, longStrike: { method: "percent", amount: 0.5 } });
    expect(r.ok && r.inputs.widthPoints).toBe(100);
  });
  it("sizes by contracts, risk and allocation, in whole contracts", () => {
    const c = { ...cfg(), widthPoints: 10, openingCreditEstimate: 3, allocationLimit: 10_000 }; // $700 risk per contract
    expect(resolveQuantity(c, { method: "contracts", count: 4 }, 10).quantity).toBe(4);
    expect(resolveQuantity(c, { method: "risk", dollars: 2_000 }, 10).quantity).toBe(2);
    expect(resolveQuantity(c, { method: "risk", dollars: 2_000, cap: 1 }, 10).quantity).toBe(1);
    expect(resolveQuantity(c, { method: "risk", dollars: 500 }, 10).quantity).toBe(0);
    expect(resolveQuantity(c, { method: "allocation", percent: 50 }, 10).quantity).toBe(7);
    expect(resolveQuantity(c, { method: "allocation", percent: 50, capDollars: 1_500 }, 10).quantity).toBe(2);
    expect(resolveQuantity(c, { method: "allocation", percent: 50, capContracts: 3 }, 10).quantity).toBe(3);
    expect(resolveQuantity(c, undefined, 10).quantity).toBe(c.quantity);
  });
});

describe("the engine follows the Open step's settings", () => {
  it("with nothing set, it opens as before", async () => {
    await emit("bullish");
    expect(puts()).toHaveLength(1);
    expect(puts()[0].requestedQuantity).toBe(getBotStaticConfig(NDX_BOT_ID).quantity);
  });

  it("settings saved from the bot's own values open exactly what no settings open", async () => {
    await emit("bullish");
    const plain = puts()[0];
    resetAutomationStores();
    setNdxTestEnv();
    ensureBotRecord(NDX_BOT_ID);
    botsStore.update(NDX_BOT_ID, { safeguards: { totalPositionLimit: 5, maxPositionsPerType: 3 } });
    const cfg = getBotStaticConfig(NDX_BOT_ID);
    set({ shortStrike: { method: "points", amount: Math.abs(cfg.putShortOffset), side: cfg.putShortOffset < 0 ? "below" : "above" }, longStrike: { method: "points", amount: cfg.widthPoints }, size: { method: "contracts", count: cfg.quantity }, pricing: { speed: "normal", percent: 100 } });
    await emit("bullish", BASE_NOW);
    expect(puts()[0]).toMatchObject({ shortStrike: plain.shortStrike, longStrike: plain.longStrike, requestedQuantity: plain.requestedQuantity });
  });

  it("opens the contracts and strikes it was told", async () => {
    set({ shortStrike: { method: "flat", strike: 20_900 }, longStrike: { method: "points", amount: 20 }, size: { method: "contracts", count: 2 } });
    botsStore.update(NDX_BOT_ID, { safeguards: { totalPositionLimit: 5, maxPositionsPerType: 3, allocationLimit: 50_000 } });
    vi.stubEnv("BOT_NDX_EMA_BIAS_ALLOCATION_LIMIT", "50000");
    await emit("bullish");
    expect(lastOutcome()).toBe("opened");
    expect(puts()[0]).toMatchObject({ shortStrike: 20_900, longStrike: 20_880, requestedQuantity: 2 });
  });

  it("a size under one contract opens nothing and says why, without switching the bot off", async () => {
    set({ size: { method: "risk", dollars: 1 } });
    await emit("bullish");
    expect(lastOutcome()).toBe("size_too_small");
    expect(puts()).toHaveLength(0);
    expect(botsStore.get(NDX_BOT_ID)!.enabled).toBe(true);
  });

  it("entry criteria not met open nothing and leave the bot on", async () => {
    await emit("bullish"); // one put spread held
    set({ entry: { lessOpen: 1 } });
    botsStore.update(NDX_BOT_ID, { positionChecks: { bullish: { open: { op: "exactly or more than", count: 5, status: "any" } } } as never });
    await emit("bullish", BASE_NOW + 400_000, 21_203.7);
    expect(lastOutcome()).toBe("entry_criteria_not_met");
    expect(puts()).toHaveLength(1);
    expect(botsStore.get(NDX_BOT_ID)!.enabled).toBe(true);
  });

  it("position criteria: the width and how far out of the money", async () => {
    set({ position: { widthMin: 50 } });
    await emit("bullish");
    expect(lastOutcome()).toBe("position_criteria_not_met");
    set({ position: { otmPercentAbove: 5 } });
    await emit("bullish");
    expect(lastOutcome()).toBe("position_criteria_not_met");
    set({ position: { widthMin: 1, otmPercentAbove: 0.0001 } });
    await emit("bullish");
    expect(lastOutcome()).toBe("opened");
  });

  it("position criteria that need a quote cannot be met without one", async () => {
    set({ position: { maxBidAskSpread: 5 } });
    await emit("bullish");
    expect(lastOutcome()).toBe("position_criteria_not_met");
    const quotes: LegQuotes = { short: { bid: 12.0, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } }; // bid/ask spread 1.20, mid 3.30
    executor.setQuotes(quotes);
    await emit("bullish");
    expect(lastOutcome()).toBe("opened");
    set({ position: { midMin: 4 } });
    await emit("bullish", BASE_NOW + 800_000, 21_303.7);
    expect(lastOutcome()).toBe("position_criteria_not_met");
  });

  it("tags go on the position that was opened, and its exit options are kept with it", async () => {
    set({ tags: ["ndx", "bull"], exit: { stopPercent: 100 } });
    await emit("bullish");
    expect(puts()[0]).toMatchObject({ tags: ["ndx", "bull"], exitOptions: { stopPercent: 100 } });
    set({ exit: { stopPercent: 50 } }); // a later edit does not change a position that is already open
    expect(puts()[0].exitOptions).toEqual({ stopPercent: 100 });
  });

  it("the final price it was given is the one the ladder ends at", async () => {
    executor.setQuotes({ short: { bid: 12.0, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } }); // credit mid 3.30, worst 2.70
    set({ pricing: { speed: "off", flat: 3.0 } });
    executor.setMarket({ creditAtMost: 0 });
    await emit("bullish");
    expect(executor.placedOrders.filter((o) => o.kind === "open").map((o) => o.price)).toEqual([3]);
  });
});

describe("exit options", () => {
  const position = { type: "short_put_spread" as const, shortStrike: 21_000, credit: 3, filledQuantity: 2, requestedQuantity: 2 };
  it("profit taking by percent or dollars (dollars are for the whole position)", () => {
    expect(exitMet(position, { profitPercent: 50 }, { debit: 1.4, underlying: null })?.kind).toBe("profit_percent");
    expect(exitMet(position, { profitPercent: 50 }, { debit: 1.6, underlying: null })).toBeNull();
    expect(exitMet(position, { profitDollars: 300 }, { debit: 1.5, underlying: null })?.kind).toBe("profit_dollars"); // 1.5 x 100 x 2
    expect(exitMet(position, { profitDollars: 300 }, { debit: 1.6, underlying: null })).toBeNull();
  });
  it("stop loss by percent or dollars", () => {
    expect(exitMet(position, { stopPercent: 100 }, { debit: 6, underlying: null })?.kind).toBe("stop_percent");
    expect(exitMet(position, { stopPercent: 100 }, { debit: 5.9, underlying: null })).toBeNull();
    expect(exitMet(position, { stopDollars: 600 }, { debit: 6, underlying: null })?.kind).toBe("stop_loss_dollars");
  });
  it("touch: the underlying within the distance of the short strike, or beyond it", () => {
    expect(exitMet(position, { touchPoints: 50 }, { debit: null, underlying: 21_040 })?.kind).toBe("touch");
    expect(exitMet(position, { touchPoints: 50 }, { debit: null, underlying: 21_200 })).toBeNull();
    expect(exitMet({ ...position, type: "short_call_spread" }, { touchPoints: 50 }, { debit: null, underlying: 20_960 })?.kind).toBe("touch");
  });
  it("with no quote the money options are not acted on", () => {
    expect(exitMet(position, { profitPercent: 1, stopPercent: 1 }, { debit: null, underlying: null })).toBeNull();
  });

  const hold = (exit: object, credit = 3.5) =>
    positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", shortStrike: 20_900, longStrike: 20_890, requestedQuantity: 1, filledQuantity: 1, credit, exitOptions: exit as never }));

  it("closes an open position when its profit target is met, and says why", async () => {
    executor.setQuotes({ short: { bid: 12.0, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } }); // buying it back costs 3.30 at the mid
    hold({ profitPercent: 5 });
    const r = await runExitChecks(NDX_BOT_ID, BASE_NOW, { executor, ...timing });
    expect(r.closed).toBe(1);
    expect(positionsStore.all()[0].status).toBe("closed");
    expect(lastOutcome()).toBe("exit_closed");
  });

  it("leaves it alone when nothing is met, and never touches one without exit options or placed by hand", async () => {
    executor.setQuotes({ short: { bid: 12.0, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } });
    hold({ profitPercent: 50 });
    positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", shortStrike: 20_800, longStrike: 20_790, requestedQuantity: 1, filledQuantity: 1, credit: 9 }));
    positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", shortStrike: 20_700, longStrike: 20_690, requestedQuantity: 1, filledQuantity: 1, credit: 9, manual: true, exitOptions: { stopPercent: 1 } }));
    const r = await runExitChecks(NDX_BOT_ID, BASE_NOW, { executor, ...timing });
    expect(r.closed).toBe(0);
    expect(positionsStore.all().every((p) => p.status === "open")).toBe(true);
  });

  it("does nothing with the kill switch on or outside its window, and a dry run only says what it would do", async () => {
    executor.setQuotes({ short: { bid: 12.0, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } });
    hold({ profitPercent: 5 });
    botsStore.update(NDX_BOT_ID, { killSwitch: true });
    expect((await runExitChecks(NDX_BOT_ID, BASE_NOW, { executor, ...timing })).skipped).toBe("kill_switch");
    botsStore.update(NDX_BOT_ID, { killSwitch: false });
    expect((await runExitChecks(NDX_BOT_ID, BASE_NOW - 14 * 3_600_000, { executor, ...timing })).skipped).toBe("outside_hours");
    const dry = await runExitChecks(NDX_BOT_ID, BASE_NOW, { executor, dryRun: true, ...timing });
    expect(dry.wouldClose).toBe(1);
    expect(positionsStore.all()[0].status).toBe("open");
  });

  it("works even when the bot is switched off: a stop loss must still act", async () => {
    executor.setQuotes({ short: { bid: 12.0, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } });
    hold({ profitPercent: 5 });
    botsStore.update(NDX_BOT_ID, { enabled: false });
    expect((await runExitChecks(NDX_BOT_ID, BASE_NOW, { executor, ...timing })).closed).toBe(1);
  });
});
