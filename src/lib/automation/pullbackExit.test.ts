import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withBotLock } from "./botLock";
import { BTC_BOT_ID, ensureBotRecord, updateBot } from "./bots";
import { BybitExecutor, type BybitConfig } from "./bybitExecutor";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { runBybitRiskCheck } from "./bybitRisk";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { closePosition, processSignal, receiveAndSaveSignal } from "./engine";
import { runEntryRetry } from "./entryRetry";
import { DEFAULT_MIN_PEAK_USD, __resetPullbackForTests, chainStopFires, nextPeak, profitUsd, pullbackFires, pullbackSettings, pullbackTick, type PullbackDeps } from "./pullbackExit";
import { countTodayNewPositions } from "./safeguards";
import { botsStore, decisionsStore, positionsStore, signalsStore } from "./store";
import { BASE_NOW, resetAutomationStores, setNdxTestEnv } from "./testSupport";

/**
 * THE PULLBACK EXIT AND THE CHAIN MODE (pullbackExit.ts), on the fake Bybit exchange with the real engine and executor. 0.001 BTC: $0.03 of profit is a $30 move of the price.
 */

setNdxTestEnv();
const baseConfig: BybitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0.12, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000 };
const fast = { closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 };

let bybit: FakeBybit;
let executor: BybitExecutor;
let nowMs = BASE_NOW;
let n = 0;
const make = (over: Partial<BybitConfig> = {}) => {
  const ex = new BybitExecutor({ ...baseConfig, ...over }, bybit.fetch, () => {}, () => nowMs);
  ex.sleep = async () => {};
  return ex;
};
const deps = (): PullbackDeps => ({ bybit: () => executor, executor, price: async () => bybit.price, closeConfirmTimeoutMs: 1000, pollIntervalMs: 5, process: fast });
const tick = () => pullbackTick(nowMs, deps());
/** An alert from TradingView, saved and processed. */
const alert = async (direction: "bullish" | "bearish") => {
  nowMs += 5 * 60_000;
  vi.setSystemTime(nowMs);
  const signal = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: direction, price: 76_000, barTime: `t-${++n}`, interval: "5", raw: { origin: "tradingview", symbol: "BTC" }, now: nowMs });
  await processSignal(signal, { executor, now: nowMs, ...fast });
  return signal;
};
const saveOnly = (direction: "bullish" | "bearish") => {
  nowMs += 5 * 60_000;
  return receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: direction, price: 76_000, barTime: `t-${++n}`, interval: "5", raw: { origin: "tradingview", symbol: "BTC" }, now: nowMs });
};
const positions = () => positionsStore.all().filter((p) => p.botId === BTC_BOT_ID).sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
const open = () => positions().find((p) => p.status === "open");
const reduceOnly = () => bybit.created.filter((c) => c.params.reduceOnly === true);
const outcomes = () => decisionsStore.all().filter((d) => d.botId === BTC_BOT_ID).map((d) => d.outcome);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  nowMs = BASE_NOW;
  vi.setSystemTime(nowMs);
  resetAutomationStores();
  setNdxTestEnv();
  __resetPullbackForTests();
  ensureBotRecord(BTC_BOT_ID);
  delete process.env.BYBIT_KILL_SWITCH;
  bybit = new FakeBybit();
  bybit.clock = () => nowMs;
  executor = make();
});
afterEach(() => vi.useRealTimers());

describe("the arithmetic", () => {
  it("a $0.03 fall is exact: peak 0.38 -> profit 0.35 fires, 0.351 does not", () => {
    expect(pullbackFires({ peak: 0.38, profit: 0.35, fallUsd: 0.03, minPeakUsd: 0 })).toBe(true);
    expect(pullbackFires({ peak: 0.38, profit: 0.351, fallUsd: 0.03, minPeakUsd: 0 })).toBe(false);
    expect(pullbackFires({ peak: 0.38, profit: 0.34, fallUsd: 0.03, minPeakUsd: 0 })).toBe(true);
    // floating point noise does not move the line
    expect(pullbackFires({ peak: 0.1 + 0.2, profit: 0.1 + 0.2 - 0.03, fallUsd: 0.03, minPeakUsd: 0 })).toBe(true);
    expect(pullbackFires({ peak: 0.38000000000000256, profit: 0.35000000000000142, fallUsd: 0.03, minPeakUsd: 0 })).toBe(true);
  });
  it("needs a real peak, and the minimum peak when one is set", () => {
    expect(pullbackFires({ peak: 0, profit: -0.05, fallUsd: 0.03, minPeakUsd: 0 })).toBe(false); // never in profit: nothing to protect
    expect(pullbackFires({ peak: 0.38, profit: 0.2, fallUsd: 0.03, minPeakUsd: 0.5 })).toBe(false);
    expect(pullbackFires({ peak: 0.5, profit: 0.2, fallUsd: 0.03, minPeakUsd: 0.5 })).toBe(true);
  });
  it("the peak only goes up and only counts a profit", () => {
    expect(nextPeak(undefined, -0.1)).toBe(0);
    expect(nextPeak(undefined, 0.2)).toBe(0.2);
    expect(nextPeak(0.38, 0.2)).toBe(0.38);
    expect(nextPeak(0.38, 0.41)).toBe(0.41);
  });
  it("profit is on the profit side of the average fill, in dollars, for a long and a short", () => {
    expect(profitUsd({ side: "Buy", size: 0.001, avgPrice: 76_000, markPrice: 76_380 })).toBeCloseTo(0.38, 9);
    expect(profitUsd({ side: "Sell", size: 0.001, avgPrice: 76_000, markPrice: 75_620 })).toBeCloseTo(0.38, 9);
    expect(profitUsd({ side: "Sell", size: 0.001, avgPrice: 76_000, markPrice: 76_030 })).toBeCloseTo(-0.03, 9);
    expect(profitUsd({ side: null, size: 0, avgPrice: null, markPrice: null })).toBeNull();
  });
  it("the chain stop fires at exactly -$0.03", () => {
    expect(chainStopFires({ profit: -0.03, stopUsd: 0.03 })).toBe(true);
    expect(chainStopFires({ profit: -0.029, stopUsd: 0.03 })).toBe(false);
    expect(chainStopFires({ profit: -0.031, stopUsd: 0.03 })).toBe(true);
  });
});

describe("the settings", () => {
  it("ON for the demo bot, the chain OFF, defaults $0.03 fall / $0.12 minimum peak / cap 10; everything OFF for the live bot whatever is stored", () => {
    expect(pullbackSettings(BTC_BOT_ID)).toEqual({ enabled: true, fallUsd: 0.03, minPeakUsd: 0.12, chainEnabled: false, chainStopUsd: 0.03, chainMax: 10 });
    expect(DEFAULT_MIN_PEAK_USD).toBe(0.12);
    // the LIVE bot has the same code and the same defaults, with its own saved values
    expect(pullbackSettings(LIVE_BOT_ID)).toEqual({ enabled: true, fallUsd: 0.03, minPeakUsd: 0.12, chainEnabled: false, chainStopUsd: 0.03, chainMax: 10 });
    ensureBotRecord(LIVE_BOT_ID);
    updateBot(LIVE_BOT_ID, { pullback: { minPeakUsd: 0.3, chainEnabled: true } });
    expect(pullbackSettings(LIVE_BOT_ID)).toMatchObject({ enabled: true, minPeakUsd: 0.3, chainEnabled: true });
    expect(pullbackSettings(BTC_BOT_ID)).toMatchObject({ minPeakUsd: 0.12, chainEnabled: false }); // the demo bot is untouched
    updateBot(BTC_BOT_ID, { pullback: { fallUsd: 0.05 } });
    expect(pullbackSettings(LIVE_BOT_ID)).toMatchObject({ fallUsd: 0.03 }); // and the other way round
    expect(pullbackSettings("ndx_ema_bias")).toMatchObject({ enabled: false, chainEnabled: false }); // any other bot gets nothing
    expect(() => updateBot("ndx_ema_bias", { pullback: { enabled: true } })).toThrow(/two Bybit bots only/);
  });
  it("a minimum peak somebody SAVED is never replaced by the default: 0 (no minimum) stays 0, 0.05 stays 0.05, 0.3 stays 0.3; only nothing, or something unusable, gets $0.12", () => {
    for (const saved of [0, 0.05, 0.12, 0.3, 10]) {
      botsStore.update(BTC_BOT_ID, { pullback: { minPeakUsd: saved } });
      expect(pullbackSettings(BTC_BOT_ID).minPeakUsd, String(saved)).toBe(saved);
    }
    for (const unusable of [undefined, -1, Number.NaN, "0.5", null]) {
      botsStore.update(BTC_BOT_ID, { pullback: { enabled: true, minPeakUsd: unusable as never } });
      expect(pullbackSettings(BTC_BOT_ID).minPeakUsd, String(unusable)).toBe(0.12);
    }
    // a bot with other pullback values saved but no minimum gets the default for the minimum only
    botsStore.update(BTC_BOT_ID, { pullback: { fallUsd: 0.05 } });
    expect(pullbackSettings(BTC_BOT_ID)).toMatchObject({ fallUsd: 0.05, minPeakUsd: 0.12 });
  });
  it("reading the settings never writes: what is stored is exactly what was stored", () => {
    botsStore.update(BTC_BOT_ID, { pullback: { fallUsd: 0.05 } });
    const before = JSON.stringify(botsStore.get(BTC_BOT_ID)?.pullback);
    pullbackSettings(BTC_BOT_ID);
    pullbackSettings(BTC_BOT_ID);
    expect(JSON.stringify(botsStore.get(BTC_BOT_ID)?.pullback)).toBe(before);
    expect(botsStore.get(BTC_BOT_ID)?.pullback).not.toHaveProperty("minPeakUsd");
  });
  it("the default minimum fires from a peak of exactly $0.12 and not below it", () => {
    const d = pullbackSettings(BTC_BOT_ID);
    expect(pullbackFires({ peak: 0.12, profit: 0.09, fallUsd: d.fallUsd, minPeakUsd: d.minPeakUsd })).toBe(true);
    expect(pullbackFires({ peak: 0.119, profit: 0.089, fallUsd: d.fallUsd, minPeakUsd: d.minPeakUsd })).toBe(false);
    expect(pullbackFires({ peak: 0.06, profit: 0.03, fallUsd: d.fallUsd, minPeakUsd: d.minPeakUsd })).toBe(false); // the 03:45 trade: peak +$0.06, back to +$0.03: no longer closed
    expect(pullbackFires({ peak: 0.06, profit: 0.03, fallUsd: d.fallUsd, minPeakUsd: 0 })).toBe(true); // with a saved 0 it still would
  });
  it("is saved through the bot patch and checked", () => {
    updateBot(BTC_BOT_ID, { pullback: { enabled: false, fallUsd: 0.05, minPeakUsd: 0.1, chainEnabled: true, chainStopUsd: 0.02, chainMax: 4 } });
    expect(pullbackSettings(BTC_BOT_ID)).toEqual({ enabled: false, fallUsd: 0.05, minPeakUsd: 0.1, chainEnabled: true, chainStopUsd: 0.02, chainMax: 4 });
    expect(() => updateBot(BTC_BOT_ID, { pullback: { fallUsd: 0 } })).toThrow();
    expect(() => updateBot(BTC_BOT_ID, { pullback: { chainMax: 2.5 } })).toThrow();
    expect(() => updateBot(BTC_BOT_ID, { pullback: { chainStopUsd: -1 } })).toThrow();
    updateBot(BTC_BOT_ID, { pullback: { chainEnabled: false } });
    expect(botsStore.get(BTC_BOT_ID)?.chainState).toBeUndefined();
  });
});

describe("the pullback exit", () => {
  it("long: the peak is saved, 0.351 does not fire, a $0.03 fall below the 0.38 peak closes it at market, reduce only, reason pullback_exit", async () => {
    await alert("bullish");
    const id = open()!.id;
    bybit.price = 76_380;
    await tick();
    expect(positionsStore.get(id)?.peakProfitUsd).toBeCloseTo(0.38, 9);
    bybit.price = 76_351;
    await tick();
    expect(positionsStore.get(id)?.status).toBe("open");
    expect(reduceOnly()).toHaveLength(0);
    bybit.price = 76_350;
    expect(await tick()).toBe(1);
    expect(positionsStore.get(id)).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
    expect(reduceOnly()).toHaveLength(1);
    expect(bybit.position.size).toBe(0);
    expect(outcomes()).toContain("pullback_exit");
    // the stop loss and take profit were on the position until the close filled
    expect(bybit.created.find((c) => c.params.reduceOnly !== true)?.params).toMatchObject({ stopLoss: expect.anything(), takeProfit: expect.anything() });
  });

  it("with the DEFAULT $0.12 minimum peak: a trade that peaked at +$0.06 and fell back to +$0.03 is NOT closed; once it has peaked at +$0.12, a $0.03 fall closes it", async () => {
    await alert("bullish");
    const id = open()!.id;
    bybit.price = 76_060; // +$0.06
    await tick();
    bybit.price = 76_030; // +$0.03: the old default (no minimum) would have closed it here
    expect(await tick()).toBe(0);
    expect(positionsStore.get(id)?.status).toBe("open");
    bybit.price = 76_120; // peak +$0.12
    await tick();
    bybit.price = 76_091; // +$0.091: a fall of $0.029
    expect(await tick()).toBe(0);
    bybit.price = 76_090; // +$0.09: a fall of exactly $0.03 from a peak of exactly $0.12
    expect(await tick()).toBe(1);
    expect(positionsStore.get(id)).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
  });

  it("with a SAVED minimum of 0 the old behaviour is kept (nothing is overwritten): the same +$0.06 / +$0.03 trade closes", async () => {
    updateBot(BTC_BOT_ID, { pullback: { minPeakUsd: 0 } });
    await alert("bullish");
    const id = open()!.id;
    bybit.price = 76_060;
    await tick();
    bybit.price = 76_030;
    expect(await tick()).toBe(1);
    expect(positionsStore.get(id)).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
  });

  it("short: the same, mirrored", async () => {
    await alert("bearish");
    const id = open()!.id;
    bybit.price = 75_620;
    await tick();
    expect(positionsStore.get(id)?.peakProfitUsd).toBeCloseTo(0.38, 9);
    bybit.price = 75_649;
    await tick();
    expect(positionsStore.get(id)?.status).toBe("open");
    bybit.price = 75_650;
    await tick();
    expect(positionsStore.get(id)).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
    expect(reduceOnly()).toHaveLength(1);
  });

  it("the peak is saved on the trade, so a restart does not forget it", async () => {
    await alert("bullish");
    const id = open()!.id;
    bybit.price = 76_380;
    await tick();
    // "restart": a new executor and a fresh module state; the first look afterwards is already 3 cents down
    __resetPullbackForTests();
    executor = make();
    bybit.price = 76_350;
    await tick();
    expect(positionsStore.get(id)).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
  });

  it("a minimum peak keeps it from firing below that peak; with none (0) it fires at once after any peak", async () => {
    updateBot(BTC_BOT_ID, { pullback: { minPeakUsd: 0.5 } });
    await alert("bullish");
    bybit.price = 76_380;
    await tick();
    bybit.price = 76_340;
    await tick();
    expect(open()).toBeTruthy(); // peak 0.38 is under the 0.5 minimum
    updateBot(BTC_BOT_ID, { pullback: { minPeakUsd: 0 } });
    await tick();
    expect(open()).toBeUndefined();
  });

  it("is off when switched off, and never runs for the live bot", async () => {
    updateBot(BTC_BOT_ID, { pullback: { enabled: false } });
    await alert("bullish");
    bybit.price = 76_380;
    await tick();
    bybit.price = 76_300;
    expect(await tick()).toBe(0);
    expect(open()).toBeTruthy();
  });

  it("no action when the position is already gone at Bybit (its stop fired): nothing is sent", async () => {
    await alert("bullish");
    bybit.price = 76_380;
    await tick();
    bybit.position.size = 0; // Bybit closed it by itself; the record has not caught up yet
    bybit.price = 76_300;
    const before = bybit.created.length;
    expect(await tick()).toBe(0);
    expect(bybit.created).toHaveLength(before);
  });

  it("while it waits for the bot's lock, the trade can be closed by something else: it then does nothing (the record said closed)", async () => {
    await alert("bullish");
    const id = open()!.id;
    bybit.price = 76_380;
    await tick();
    bybit.price = 76_350;
    let release!: () => void;
    const holder = withBotLock(BTC_BOT_ID, () => new Promise<void>((r) => (release = r)));
    const waiting = tick(); // reads the account outside the lock, decides to close, queues for the lock
    await new Promise((r) => setTimeout(r, 20));
    positionsStore.update(id, { status: "closed", closeReason: "signal_flip", closedAt: nowMs });
    release();
    await holder;
    expect(await waiting).toBe(0);
    expect(reduceOnly()).toHaveLength(0);
    expect(outcomes()).not.toContain("pullback_exit");
  });

  it("while it waits for the bot's lock, Bybit can close the position by itself: it then does nothing (the account is flat)", async () => {
    await alert("bullish");
    bybit.price = 76_380;
    await tick();
    bybit.price = 76_350;
    let release!: () => void;
    const holder = withBotLock(BTC_BOT_ID, () => new Promise<void>((r) => (release = r)));
    const waiting = tick();
    await new Promise((r) => setTimeout(r, 20));
    bybit.position.size = 0; // Bybit's own stop fired in the meantime
    release();
    await holder;
    expect(await waiting).toBe(0);
    expect(outcomes()).not.toContain("pullback_exit"); // not even decided: no "closing" line for a position that is gone
  });

  it("no double close with the risk check (kill switch) at the same moment, in either order", async () => {
    for (const order of ["risk-first", "pullback-first"] as const) {
      resetAutomationStores();
      __resetPullbackForTests();
      ensureBotRecord(BTC_BOT_ID);
      bybit = new FakeBybit();
      bybit.clock = () => nowMs;
      executor = make();
      await alert("bullish");
      bybit.price = 76_380;
      await tick();
      bybit.price = 76_350;
      botsStore.update(BTC_BOT_ID, { killSwitch: true });
      const risk = () => runBybitRiskCheck(BTC_BOT_ID, executor, executor, nowMs, { closeConfirmTimeoutMs: 1000, pollIntervalMs: 5 });
      if (order === "risk-first") await Promise.all([risk(), tick()]);
      else await Promise.all([tick(), risk()]);
      expect(reduceOnly(), order).toHaveLength(1);
      expect(open(), order).toBeUndefined();
      expect(botsStore.get(BTC_BOT_ID)?.needsAttention, order).toBeFalsy();
      botsStore.update(BTC_BOT_ID, { killSwitch: false });
    }
  });

  it("no double close with the breakeven step: the stop is moved up, then the pullback closes once", async () => {
    executor = make({ breakevenTriggerPercent: 0.3, breakevenLockPercent: 0.12 });
    await alert("bullish");
    const id = open()!.id;
    const risk = () => runBybitRiskCheck(BTC_BOT_ID, executor, executor, nowMs, { closeConfirmTimeoutMs: 1000, pollIntervalMs: 5 });
    bybit.price = 76_380; // +0.50%: past the breakeven trigger
    await Promise.all([risk(), tick()]);
    expect(positionsStore.get(id)?.breakevenStop).toBeTruthy();
    bybit.price = 76_350;
    await Promise.all([tick(), risk()]);
    expect(positionsStore.get(id)).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
    expect(reduceOnly()).toHaveLength(1);
    expect(botsStore.get(BTC_BOT_ID)?.needsAttention).toBeFalsy();
  });
});

describe("the chain mode", () => {
  const chainOn = (extra: Record<string, unknown> = {}) => updateBot(BTC_BOT_ID, { pullback: { chainEnabled: true, minPeakUsd: 0, ...extra } });
  const chainSignals = () => signalsStore.all().filter((s) => (s.raw as { origin?: string } | null)?.origin === "chain");

  it("a pullback exit opens the opposite trade at once, protected like any other; its tight stop and the pullback exit watch it; each close opens the next", async () => {
    chainOn();
    const protectedEntries: { orderId: string; side: string }[] = [];
    executor.onEntryProtected = (e) => protectedEntries.push(e); // what the ledger is told in the app (bybitWatchdog.ts)
    await alert("bullish");
    bybit.price = 76_380;
    await tick();
    bybit.price = 76_350;
    expect(await tick()).toBe(2); // the close, and the chain trade
    expect(protectedEntries.map((e) => e.side)).toEqual(["Buy", "Sell"]); // the chain trade's stop was confirmed at its entry like the first trade's
    const first = open()!;
    expect(first).toMatchObject({ type: "short_call_spread", chain: { index: 1 } }); // opposite: a short
    expect(bybit.position.size).toBeLessThan(0); // a short
    expect(bybit.position.stopLoss).toBeGreaterThan(0); // the executor's own stop and take profit are on it
    expect(bybit.position.takeProfit).toBeGreaterThan(0);
    expect(botsStore.get(BTC_BOT_ID)?.chainState).toMatchObject({ count: 1, lastPositionId: first.id });
    expect(outcomes()).toContain("chain_open");
    // the chain trade loses $0.03 (price up $30 against the short): the chain stop closes it, and the next trade (long) opens
    bybit.price = 76_380;
    expect(await tick()).toBe(2);
    expect(positionsStore.get(first.id)).toMatchObject({ status: "closed", closeReason: "chain_stop" });
    const second = open()!;
    expect(second).toMatchObject({ type: "short_put_spread", chain: { index: 2 } });
    // the pullback exit watches it too: peak +0.03, then back to 0
    bybit.price = 76_410;
    await tick();
    bybit.price = 76_380;
    expect(await tick()).toBe(2);
    expect(positionsStore.get(second.id)).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
    expect(open()).toMatchObject({ chain: { index: 3 } });
    expect(chainSignals()).toHaveLength(3);
  });

  it("a trade opened with the Open UP / Open DOWN button is not an alert's trade: its pullback exit closes it and starts NO chain", async () => {
    chainOn();
    nowMs += 5 * 60_000;
    vi.setSystemTime(nowMs);
    const manual = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: "bullish", price: 76_000, barTime: `manual-${++n}`, interval: "manual", raw: { source: "manual", manualOpen: true, symbol: "BTC" }, now: nowMs });
    await processSignal(manual, { executor, now: nowMs, ...fast });
    expect(open()).toBeTruthy();
    bybit.price = 76_380;
    await tick();
    bybit.price = 76_350;
    expect(await tick()).toBe(1); // only the close
    expect(positions().filter((p) => p.status === "closed")[0]).toMatchObject({ closeReason: "pullback_exit" });
    expect(open()).toBeUndefined();
    expect(positions()).toHaveLength(1);
    expect(chainSignals()).toHaveLength(0);
    expect(botsStore.get(BTC_BOT_ID)?.chainState ?? null).toBeNull();
  });

  it("the chain's trades do not use up the day's allowance of new positions", async () => {
    chainOn();
    await alert("bullish");
    bybit.price = 76_380;
    await tick();
    bybit.price = 76_350;
    await tick();
    expect(positions()).toHaveLength(2);
    expect(countTodayNewPositions(BTC_BOT_ID, nowMs)).toBe(1);
  });

  it("the cap per alert ends the chain", async () => {
    chainOn({ chainMax: 2 });
    await alert("bullish");
    bybit.price = 76_380;
    await tick();
    bybit.price = 76_350;
    await tick(); // chain trade 1 (short) opens at 76,350
    bybit.price = 76_380;
    await tick(); // its chain stop closes it; chain trade 2 (long) opens at 76,380
    bybit.price = 76_410;
    await tick();
    bybit.price = 76_380;
    await tick(); // pullback closes trade 2; the cap of 2 is reached
    expect(open()).toBeUndefined();
    expect(chainSignals()).toHaveLength(2);
    expect(botsStore.get(BTC_BOT_ID)?.chainState).toBeUndefined();
    const ended = decisionsStore.all().filter((d) => d.outcome === "chain_ended").at(-1);
    expect(ended?.reason).toMatch(/cap of 2/);
  });

  it("a real alert stops the chain: the closing chain trade does not carry on, and the alert is followed through the normal flip logic", async () => {
    chainOn();
    await alert("bullish");
    bybit.price = 76_380;
    await tick();
    bybit.price = 76_350;
    await tick(); // chain trade 1: a short
    const chainTrade = open()!;
    // an alert arrives and is saved (its processing is queued); the chain trade then closes by the pullback exit
    bybit.price = 76_320;
    await tick(); // peak +0.03 for the short
    const arrived = saveOnly("bullish");
    bybit.price = 76_350;
    await tick(); // the short's profit falls from +0.03 to 0: pullback exit
    expect(positionsStore.get(chainTrade.id)).toMatchObject({ status: "closed", closeReason: "pullback_exit" });
    expect(open()).toBeUndefined(); // no next chain trade
    expect(chainSignals()).toHaveLength(1);
    expect(botsStore.get(BTC_BOT_ID)?.chainState).toBeUndefined();
    expect(decisionsStore.all().filter((d) => d.outcome === "chain_ended").at(-1)?.reason).toMatch(/real alert/);
    // and the alert, processed, opens its own direction
    await processSignal(arrived, { executor, now: nowMs, ...fast });
    expect(open()).toMatchObject({ type: "short_put_spread" });
    expect(open()?.chain).toBeUndefined();
  });

  it("an alert that arrives while a chain trade is open flips it through the existing logic (reason signal_flip) and ends the chain", async () => {
    chainOn();
    await alert("bullish");
    bybit.price = 76_380;
    await tick();
    bybit.price = 76_350;
    await tick(); // chain trade: a short
    const chainTrade = open()!;
    await alert("bullish"); // opposite to the chain's short: the flip
    expect(positionsStore.get(chainTrade.id)).toMatchObject({ status: "closed", closeReason: "signal_flip" });
    expect(open()).toMatchObject({ type: "short_put_spread" });
    expect(open()?.chain).toBeUndefined();
    bybit.price = 76_320;
    await tick();
    expect(chainSignals()).toHaveLength(1); // no new chain trade was made
  });

  it("the daily loss limit stops the chain", async () => {
    executor = make({ dailyMaxLossUsd: 0.05 });
    chainOn();
    await alert("bullish");
    bybit.price = 76_380;
    await tick();
    // a loss today (bigger than the first trade's small win) puts the day past the $0.05 limit
    positionsStore.insert({ id: "old-loss", botId: BTC_BOT_ID, underlying: "BTC", venue: "bybit", type: "short_put_spread", shortStrike: 1, longStrike: 1, requestedQuantity: 1, filledQuantity: 1, expiry: "2026-11-09", credit: 0.75, openedAt: nowMs - 3_600_000, closedAt: nowMs - 1_800_000, openSignalId: null, closeSignalId: null, brokerOrderRef: "bybit-close-x", status: "closed", closeReason: "stop_loss", settlement: { kind: "broker", pl: -2, at: nowMs - 1_800_000 } } as never);
    bybit.price = 76_350;
    await tick();
    expect(open()).toBeUndefined();
    expect(chainSignals()).toHaveLength(0);
    expect(decisionsStore.all().filter((d) => d.outcome === "chain_ended").at(-1)?.reason).toMatch(/loss limit|daily/i);
  });

  it("the kill switch stops the chain", async () => {
    chainOn();
    await alert("bullish");
    bybit.price = 76_380;
    await tick();
    botsStore.update(BTC_BOT_ID, { killSwitch: true });
    bybit.price = 76_350;
    await tick();
    expect(open()).toBeUndefined();
    expect(chainSignals()).toHaveLength(0);
    expect(decisionsStore.all().filter((d) => d.outcome === "chain_ended").at(-1)?.reason).toMatch(/kill switch/i);
  });

  it("no chain after a close that is not a pullback exit (a signal flip, or the chain switched off)", async () => {
    chainOn();
    await alert("bullish");
    await alert("bearish"); // flip: the long closes as signal_flip
    expect(positions()[0]).toMatchObject({ closeReason: "signal_flip" });
    expect(botsStore.get(BTC_BOT_ID)?.chainState).toBeUndefined();
    bybit.price = 75_620;
    await tick();
    expect(chainSignals()).toHaveLength(0);
    // with the chain switched OFF a pullback exit closes the trade and nothing follows
    updateBot(BTC_BOT_ID, { pullback: { chainEnabled: false } });
    bybit.price = 75_650;
    await tick();
    expect(open()).toBeUndefined();
    expect(chainSignals()).toHaveLength(0);
  });

  it("a chain trade that closes some other way (here: by hand) does not carry the chain on", async () => {
    chainOn();
    await alert("bullish");
    bybit.price = 76_380;
    await tick();
    bybit.price = 76_350;
    await tick(); // chain trade 1 (short) is open
    const trade = open()!;
    await closePosition(trade, null, executor, 1000, 5, nowMs, undefined, undefined, { reason: "manual" });
    expect(positionsStore.get(trade.id)).toMatchObject({ status: "closed", closeReason: "manual" });
    await tick();
    expect(open()).toBeUndefined();
    expect(chainSignals()).toHaveLength(1);
    expect(decisionsStore.all().filter((d) => d.outcome === "chain_ended").at(-1)?.reason).toMatch(/manual/);
  });

  it("a chain signal is not turned away as a duplicate of the real alert just before it", async () => {
    chainOn();
    const at = (direction: "bullish" | "bearish", ms: number) => {
      nowMs = ms;
      vi.setSystemTime(nowMs);
      const signal = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: direction, price: 76_000, barTime: `d-${++n}`, interval: "5", raw: { origin: "tradingview", symbol: "BTC" }, now: nowMs });
      return processSignal(signal, { executor, now: nowMs, ...fast });
    };
    const t0 = nowMs + 3_600_000;
    await at("bearish", t0); // a real bearish alert: a short
    await at("bullish", t0 + 30_000); // 30 s later a bullish alert: the flip, now long
    bybit.price = 76_380;
    nowMs = t0 + 35_000;
    await tick();
    bybit.price = 76_350;
    nowMs = t0 + 40_000;
    await tick(); // the pullback closes the long; the chain wants a SHORT: a bearish signal 40 s after the real bearish alert (inside the 120 s duplicate window)
    expect(chainSignals()).toHaveLength(1);
    expect(chainSignals()[0].status).toBe("accepted");
    expect(open()).toMatchObject({ type: "short_call_spread", chain: { index: 1 } });
  });

  it("the entry retry never takes a chain signal for the alert to finish", async () => {
    signalsStore.insert({ id: "chain-sig", botId: BTC_BOT_ID, signal: "bullish", barTime: "chain-x-1", price: 76_000, interval: "", receivedAt: nowMs - 60_000, status: "accepted", raw: { origin: "chain" } } as never);
    decisionsStore.insert({ id: "chain-dec", signalId: "chain-sig", botId: BTC_BOT_ID, outcome: "no_live_price", reason: "no price", detail: {}, createdAt: nowMs - 59_000 } as never);
    const r = await runEntryRetry(BTC_BOT_ID, nowMs, { executor, price: async () => bybit.price, ...fast });
    expect(r).toMatchObject({ retried: false, skipped: "nothing_to_retry" });
    expect(bybit.created).toHaveLength(0);
  });

  it("the chain's own signals are not duplicates of the alert before them, and are never retried as missed alerts", async () => {
    chainOn();
    await alert("bearish"); // short
    bybit.price = 75_620;
    await tick();
    bybit.price = 75_650;
    await tick(); // pullback closes the short; the chain opens a LONG (bullish)... then a later bearish chain trade is the opposite of that
    expect(open()).toMatchObject({ type: "short_put_spread" });
    expect(chainSignals().every((s) => s.status === "accepted")).toBe(true);
    // the entry retry never treats a chain signal as the alert to finish
    const r = await runEntryRetry(BTC_BOT_ID, nowMs + 120_000, { executor, price: async () => bybit.price });
    expect(r.retried).toBe(false);
  });
});
