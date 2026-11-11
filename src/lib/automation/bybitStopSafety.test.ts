import { beforeEach, describe, expect, it } from "vitest";
import { systemEntryLabel } from "@/components/automation/bot/btcWording";
import { ensureBotRecord } from "./bots";
import { ALARM_AFTER_MS, BybitExecutor, STOP_CHECK_BUDGET_MS, STOP_TOLERANCE_PERCENT, stopVerdict, type BybitConfig } from "./bybitExecutor";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { raiseStopAlarm } from "./bybitWatchdog";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { OrderNotPlacedError } from "./orderErrors";
import { botsStore, decisionsStore, notificationsStore, positionsStore } from "./store";
import { BASE_NOW, BTC_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import type { OpenSpreadRequest } from "./types";

// THE STOP LOSS SAFETY RULES, against the fake exchange (no network, no real key):
//   an open position must never exist without a working stop loss that covers all of it; an unconfirmed stop is treated as a missing one
//   (repair once, then reduce-only closes every second until protected or flat); the check after an entry is capped at 5 seconds; the watchdog looks at ANY
//   position every 1.5 seconds; and the alarm reaches the Log, the red banner and the bell.

setNdxTestEnv();
const MIN = 60_000;
const config: BybitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0.12, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 5000 };

type Alarm = { kind: "stop_problem" | "unreachable" | "resolved"; text: string };
let bybit: FakeBybit;
let logs: string[];
let alarms: Alarm[];
let nowMs: number;
let virt: number;
let sleeps: number[];
let onVirtual: ((t: number) => void) | null;

const make = (over: Partial<BybitConfig> = {}) => {
  const ex = new BybitExecutor({ ...config, ...over }, bybit.fetch, (l) => logs.push(l), () => nowMs);
  ex.sleep = async (ms) => {
    sleeps.push(ms);
    virt += ms;
    onVirtual?.(virt);
  };
  ex.onAlarm = (a) => alarms.push(a);
  return ex;
};
const openReq = (over: Partial<OpenSpreadRequest> = {}): OpenSpreadRequest => ({ botId: BTC_BOT_ID, underlying: "BTC", positionType: "short_put_spread", shortStrike: 29_000, longStrike: 28_990, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06", clientOrderId: "o-1", ...over });
const posts = () => bybit.calls.filter((c) => c.method === "POST");
const stopCalls = () => bybit.of("/v5/position/trading-stop", "POST");
const entries = () => bybit.created.filter((c) => c.params.reduceOnly !== true);
const reduceOnlys = () => bybit.created.filter((c) => c.params.reduceOnly === true);
/** A reduce-only order is refused this many times before Bybit takes one (counting every attempt). */
function refuseReduceOnly(times: number): { tries: () => number } {
  let tries = 0;
  let left = times;
  const real = bybit.fetch;
  bybit.fetch = async (url, init) => {
    if (init.method === "POST" && url.endsWith("/v5/order/create") && JSON.parse(init.body ?? "{}").reduceOnly === true) {
      tries++;
      if (left > 0) {
        left--;
        return { ok: true, status: 200, text: async () => JSON.stringify({ retCode: 10016, retMsg: "Server Error", result: {} }) };
      }
    }
    return real(url, init);
  };
  return { tries: () => tries };
}

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(BTC_BOT_ID);
  bybit = new FakeBybit();
  logs = [];
  alarms = [];
  sleeps = [];
  nowMs = BASE_NOW;
  virt = 0;
  onVirtual = null;
  bybit.clock = () => nowMs;
  delete process.env.BYBIT_KILL_SWITCH;
});

describe("the rule for a correct stop", () => {
  const held = (over: Record<string, unknown> = {}) => ({ side: "Buy" as const, size: 0.001, avgPrice: 76_000, stopLoss: 75_240 as number | null, takeProfit: 77_520 as number | null, tpslMode: "Full", ...over });
  it("the tolerance is stated: 0.05 percentage points of price", () => {
    expect(STOP_TOLERANCE_PERCENT).toBe(0.05);
  });
  it("a stop where it should be is fine, for a long and a short", () => {
    expect(stopVerdict(held(), 1, { strict: true }).ok).toBe(true);
    expect(stopVerdict(held({ side: "Sell", stopLoss: 76_760, takeProfit: 74_480 }), 1, { strict: true }).ok).toBe(true);
  });
  it("within the tolerance either way is fine; beyond it is wrong", () => {
    // 1% of 76,000 = 760. The tolerance is 0.05% = 38.
    expect(stopVerdict(held({ stopLoss: 76_000 - 760 - 37 }), 1, { strict: true }).ok).toBe(true);
    expect(stopVerdict(held({ stopLoss: 76_000 - 760 - 39 }), 1, { strict: true }).ok).toBe(false);
    expect(stopVerdict(held({ stopLoss: 76_000 - 760 + 37 }), 1, { strict: true }).ok).toBe(true);
    expect(stopVerdict(held({ stopLoss: 76_000 - 760 + 39 }), 1, { strict: true }).ok).toBe(false);
  });
  it("a stop that is TIGHTER than intended is only wrong right after an entry (a breakeven stop is tighter on purpose)", () => {
    const breakeven = held({ stopLoss: 76_091 }); // above the entry: locked in profit
    expect(stopVerdict(breakeven, 1).ok).toBe(true);
    expect(stopVerdict(breakeven, 1, { strict: true }).ok).toBe(false);
  });
  it("a missing stop, a looser one, and one that covers only part of the position are wrong", () => {
    expect(stopVerdict(held({ stopLoss: null }), 1)).toMatchObject({ ok: false, problems: ["there is no stop loss"] });
    expect(stopVerdict(held({ stopLoss: 70_000 }), 1).ok).toBe(false);
    expect(stopVerdict(held({ tpslMode: "Partial" }), 1).problems.join(" ")).toMatch(/covers only part of the position/);
  });
  it("a missing take profit alone is not a stop problem", () => {
    expect(stopVerdict(held({ takeProfit: null }), 1)).toMatchObject({ ok: true, takeProfitMissing: true });
  });
  it("flat is fine", () => {
    expect(stopVerdict({ side: null, size: 0, avgPrice: null, stopLoss: null, takeProfit: null }, 1).ok).toBe(true);
  });
});

describe("after an entry: the stop is checked against the real fill, within 5 seconds", () => {
  it("a normal entry: stop in the order, one look, nothing to repair, no alarm", async () => {
    await make().placeOpenOrder(openReq());
    expect(stopCalls()).toHaveLength(0);
    expect(alarms).toEqual([]);
    expect(bybit.unprotectedMoments).toBe(0);
    expect(bybit.position.stopLoss).toBe(75_240);
  });

  it("a fill a little away from the mark price (inside the tolerance) is accepted as it is", async () => {
    bybit.fillSlip = 20; // 0.026% of price
    await make().placeOpenOrder(openReq());
    expect(stopCalls()).toHaveLength(0);
    expect(alarms).toEqual([]);
  });

  it("a fill far from the mark price makes the stop wrong against the real fill: it is repaired from the fill, with an alarm and then an all-clear", async () => {
    bybit.fillSlip = 300; // bought at 76,300 while the stop was worked out from 76,000
    await make().placeOpenOrder(openReq());
    expect(stopCalls()).toHaveLength(1);
    expect(stopCalls()[0].params).toMatchObject({ tpslMode: "Full", stopLoss: "75537.0", slTriggerBy: "MarkPrice" });
    expect(bybit.position.stopLoss).toBe(75_537);
    expect(alarms.map((a) => a.kind)).toEqual(["stop_problem", "resolved"]);
    expect(alarms[0].text).toMatch(/looser than the 1% it should be \(tolerance 0.05 points\)/);
    expect(reduceOnlys()).toHaveLength(0);
  });

  it("a stop that is too tight right after the entry is repaired too", async () => {
    bybit.onCreated = () => {
      bybit.position.stopLoss = 75_900;
    };
    await make().placeOpenOrder(openReq());
    expect(bybit.position.stopLoss).toBe(75_240);
    expect(alarms[0].kind).toBe("stop_problem");
  });

  it("a missing stop: one repair, confirmed, the entry stands", async () => {
    bybit.dropStops = true;
    await make().placeOpenOrder(openReq());
    expect(stopCalls()).toHaveLength(1);
    expect(bybit.position).toMatchObject({ stopLoss: 75_240, takeProfit: 77_520 });
    expect(reduceOnlys()).toHaveLength(0);
    expect(alarms.map((a) => a.kind)).toEqual(["stop_problem", "resolved"]);
  });

  it("a repair Bybit refuses: reduce-only closes follow, and the account ends flat", async () => {
    bybit.dropStops = true;
    bybit.tradingStopFails = true;
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(stopCalls()).toHaveLength(1); // one repair attempt, not more
    expect(reduceOnlys().length).toBeGreaterThanOrEqual(1);
    expect(bybit.position.size).toBe(0);
  });

  it("closes are retried every second until the account is flat", async () => {
    bybit.dropStops = true;
    bybit.tradingStopFails = true;
    const refused = refuseReduceOnly(3);
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(refused.tries()).toBe(4); // 3 refused, the 4th taken
    expect(sleeps.filter((ms) => ms === 1000).length).toBeGreaterThanOrEqual(3);
    expect(bybit.position.size).toBe(0);
  });

  it("a stop covering only part of the position (Partial mode) counts as wrong; if it cannot be made Full the position is closed", async () => {
    bybit.partialMode = true; // the fake keeps reporting Partial however the stop is set
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(alarms[0].text).toMatch(/covers only part of the position/);
    expect(stopCalls()[0].params).toMatchObject({ tpslMode: "Full" });
    expect(bybit.position.size).toBe(0);
  });

  it("a partial fill: what is held has a stop that covers all of it, and the entry stands", async () => {
    bybit.fillFraction = 0.5;
    await make().placeOpenOrder(openReq());
    expect(bybit.position.size).toBeCloseTo(0.0005, 10);
    expect(bybit.position.stopLoss).toBe(75_240);
    expect(logs.join("\n")).toMatch(/partial fill: 0.0005 of 0.001 BTCUSDT is held; its stop loss covers all of it \(Full mode\)/);
    expect(reduceOnlys()).toHaveLength(0);
  });

  it("a partial fill whose stop is missing: the repair is in Full mode, for all of what is held", async () => {
    bybit.fillFraction = 0.5;
    bybit.dropStops = true;
    await make().placeOpenOrder(openReq());
    expect(stopCalls()[0].params).toMatchObject({ tpslMode: "Full" });
    expect(bybit.position).toMatchObject({ stopLoss: 75_240 });
    expect(bybit.position.size).toBeCloseTo(0.0005, 10);
  });

  it("the check is capped at 5 seconds: with reads failing, the reduce-only close starts after 5 seconds, not before", async () => {
    const times: number[] = [];
    const real = bybit.fetch;
    bybit.fetch = async (url, init) => {
      if (init.method === "POST" && url.endsWith("/v5/order/create")) times.push(virt);
      return real(url, init);
    };
    bybit.onCreated = () => {
      bybit.down = true; // the network is cut right after the entry
    };
    onVirtual = (t) => {
      if (t >= 8_000) bybit.down = false;
    };
    await make().placeOpenOrder(openReq());
    expect(STOP_CHECK_BUDGET_MS).toBe(5_000);
    // times[0] is the entry (at 0 seconds). The next order Bybit was sent is the first blind reduce-only close: not before 5 seconds of failed reads, and right after them.
    expect(times[0]).toBe(0);
    expect(times[1]).toBeGreaterThanOrEqual(5_000);
    expect(times[1]).toBeLessThan(5_700);
    // Phase 1 polls every 300 ms (about 17 reads); after that, every second.
    expect(sleeps.filter((ms) => ms === 300).length).toBeGreaterThanOrEqual(16);
    expect(sleeps.filter((ms) => ms === 300).length).toBeLessThanOrEqual(18);
    expect(sleeps.filter((ms) => ms === 1000).length).toBeGreaterThanOrEqual(2);
    // The network came back at 8 seconds with the entry's own stop intact: confirmed, nothing was closed, and no alarm (8 seconds is under the 20 second alarm).
    expect(bybit.position).toMatchObject({ size: 0.001, stopLoss: 75_240 });
    expect(alarms).toEqual([]);
  });

  it("Bybit unreadable for more than 20 seconds after an entry: the alarm goes off, closes keep being sent every second, and it ends protected once Bybit answers", async () => {
    bybit.onCreated = () => {
      bybit.down = true;
    };
    onVirtual = (t) => {
      if (t >= 24_000) bybit.down = false;
    };
    await make().placeOpenOrder(openReq());
    expect(ALARM_AFTER_MS).toBe(20_000);
    expect(alarms.filter((a) => a.kind === "unreachable")).toHaveLength(1);
    expect(alarms.find((a) => a.kind === "unreachable")!.text).toMatch(/Bybit cannot be read for 2\d seconds.*cannot be confirmed/);
    expect(sleeps.filter((ms) => ms === 1000).length).toBeGreaterThanOrEqual(15);
    expect(bybit.position.size).toBe(0.001);
  });

  it("Bybit unreadable for longer than the call is willing to wait: it reports UNPROTECTED, raises the alarm, and leaves the rest to the watchdog", async () => {
    bybit.onCreated = () => {
      bybit.down = true;
    };
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(String(err)).toMatch(/UNPROTECTED POSITION.*may be open at Bybit WITHOUT a confirmed stop loss/);
    expect(alarms.map((a) => a.kind)).toEqual(["unreachable", "stop_problem"]);
    expect(alarms[1].text).toMatch(/STILL not confirmed.*watchdog keeps closing it every second/);
  });
});

describe("the watchdog: any position at Bybit, recorded or not, every 1.5 seconds", () => {
  const manualPosition = () => {
    bybit.hold(0.001, 76_000);
    bybit.position.stopLoss = 75_240;
    bybit.position.takeProfit = 77_520;
  };

  it("the first look is the startup check, and it says what it found", async () => {
    const ex = make();
    expect(await ex.watchdogStep(nowMs)).toMatchObject({ state: "flat", startup: true, text: "Startup check: the Bybit account holds no position." });
    expect(await ex.watchdogStep(nowMs + 1500)).toMatchObject({ state: "flat", startup: false });
    manualPosition();
    const again = make();
    expect(await again.watchdogStep(nowMs)).toMatchObject({ state: "protected", startup: true });
    expect((await make().watchdogStep(nowMs)).text).toMatch(/Startup check: the long 0.001 BTCUSDT has its stop loss at 75240/);
  });

  it("a position nobody recorded (placed by hand) with a correct stop is left alone: no write of any kind", async () => {
    manualPosition();
    const ex = make();
    await ex.watchdogStep(nowMs);
    await ex.watchdogStep(nowMs + 1500);
    expect(posts()).toHaveLength(0);
    expect(alarms).toEqual([]);
    expect(positionsStore.all()).toHaveLength(0);
  });

  it("a stop deleted by hand at Bybit: alarm, ONE repair, confirmed, all clear", async () => {
    manualPosition();
    const ex = make();
    await ex.watchdogStep(nowMs);
    bybit.deleteStop();
    const r = await ex.watchdogStep(nowMs + 1500);
    expect(r.state).toBe("repaired");
    expect(stopCalls()).toHaveLength(1);
    expect(stopCalls()[0].params).toMatchObject({ tpslMode: "Full", stopLoss: "75240.0", slTriggerBy: "MarkPrice" });
    expect(bybit.position.stopLoss).toBe(75_240);
    expect(reduceOnlys()).toHaveLength(0);
    expect(alarms.map((a) => a.kind)).toEqual(["stop_problem", "resolved"]);
    expect(alarms[0].text).toMatch(/has no correct stop loss: there is no stop loss/);
    // And the next look finds nothing wrong.
    expect((await ex.watchdogStep(nowMs + 3000)).state).toBe("protected");
    expect(stopCalls()).toHaveLength(1);
  });

  it("a stop that cannot be repaired: reduce-only closes every second until the account is flat", async () => {
    manualPosition();
    const refused = refuseReduceOnly(2);
    const ex = make();
    await ex.watchdogStep(nowMs);
    bybit.deleteStop();
    bybit.tradingStopFails = true;
    sleeps = [];
    const r = await ex.watchdogStep(nowMs + 1500);
    expect(r.state).toBe("closed");
    expect(refused.tries()).toBe(3);
    expect(sleeps.filter((ms) => ms === 1000)).toHaveLength(3);
    expect(stopCalls()).toHaveLength(1); // a single repair attempt
    expect(bybit.position.size).toBe(0);
    expect(alarms.map((a) => a.kind)).toEqual(["stop_problem", "resolved"]);
    expect(alarms[1].text).toMatch(/was closed \(reduce only\)/);
  });

  it("a position that never had a stop (opened by hand) is treated the same", async () => {
    bybit.hold(0.001, 76_000);
    bybit.tradingStopFails = true;
    const r = await make().watchdogStep(nowMs);
    expect(r.state).toBe("closed");
    expect(alarms[0].text).toMatch(/^Startup check: the long 0.001 BTCUSDT/);
    expect(bybit.position.size).toBe(0);
  });

  it("a breakeven stop (above the entry) is not wrong; a stop far looser than intended is", async () => {
    manualPosition();
    bybit.position.stopLoss = 76_091;
    const ex = make();
    expect((await ex.watchdogStep(nowMs)).state).toBe("protected");
    expect(posts()).toHaveLength(0);
    bybit.position.stopLoss = 70_000;
    expect((await ex.watchdogStep(nowMs + 1500)).state).toBe("repaired");
    expect(bybit.position.stopLoss).toBe(75_240);
  });

  it("only a missing take profit: it is set once (the stop is not touched), never a reason to close", async () => {
    manualPosition();
    bybit.position.takeProfit = 0;
    bybit.position.stopLoss = 76_091;
    const ex = make();
    await ex.watchdogStep(nowMs);
    await ex.watchdogStep(nowMs + 1500);
    expect(stopCalls()).toHaveLength(1);
    expect(stopCalls()[0].params).toMatchObject({ takeProfit: "77520.0" });
    expect(stopCalls()[0].params).not.toHaveProperty("stopLoss");
    expect(bybit.position.stopLoss).toBe(76_091);
    expect(reduceOnlys()).toHaveLength(0);
    expect(alarms).toEqual([]);
  });

  it("it leaves a position to an entry that is still confirming its stop", async () => {
    manualPosition();
    bybit.deleteStop();
    const ex = make();
    (ex as unknown as { protecting: number }).protecting = 1;
    expect((await ex.watchdogStep(nowMs)).state).toBe("skipped");
    expect(posts()).toHaveLength(0);
  });

  it("a restart with a position open: a fresh watchdog does the startup check, and repairs a stop that went missing while the app was down", async () => {
    await make().placeOpenOrder(openReq());
    expect(bybit.position.size).toBe(0.001);
    bybit.deleteStop(); // the app is "down": nobody was watching
    const restarted = make();
    const r = await restarted.watchdogStep(nowMs);
    expect(r).toMatchObject({ state: "repaired", startup: true });
    expect(alarms[0].text).toMatch(/^Startup check: /);
    expect(bybit.position.stopLoss).toBe(75_240);
  });
});

describe("Bybit cannot be reached", () => {
  it("after 3 reads in a row fail, new entries are refused with nothing sent; they are allowed again when Bybit answers", async () => {
    const ex = make();
    await ex.watchdogStep(nowMs);
    bybit.down = true;
    for (let i = 1; i <= 3; i++) expect((await ex.watchdogStep(nowMs + i * 1500)).state).toBe("unreadable");
    expect(ex.watchdogHealth()).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be read 3 times in a row/) });
    bybit.down = false;
    bybit.calls.length = 0;
    // The watchdog has not yet looked again: the entry is refused on its word, and nothing at all goes to Bybit.
    const err = await ex.placeOpenOrder(openReq()).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(String(err)).toMatch(/stop-loss watchdog is not healthy.*Nothing was sent/);
    expect(bybit.created).toHaveLength(0);
    expect((await ex.watchdogStep(nowMs + 6000)).state).toBe("flat");
    expect(ex.watchdogHealth().ok).toBe(true);
    await ex.placeOpenOrder(openReq({ clientOrderId: "o-2" }));
    expect(entries()).toHaveLength(1);
  });

  it("two failed reads are not enough to refuse an entry", async () => {
    const ex = make();
    await ex.watchdogStep(nowMs);
    bybit.down = true;
    await ex.watchdogStep(nowMs + 1500);
    await ex.watchdogStep(nowMs + 3000);
    expect(ex.watchdogHealth().ok).toBe(true);
  });

  it("with a position at risk the alarm goes off after 20 seconds, once, and clears when Bybit answers; with nothing at risk there is no alarm", async () => {
    // Nothing at risk: no record, last look flat.
    const calm = make();
    await calm.watchdogStep(nowMs);
    bybit.down = true;
    await calm.watchdogStep(nowMs + 1500);
    await calm.watchdogStep(nowMs + 30_000);
    expect(alarms).toEqual([]);
    bybit.down = false;
    // A position held, the bot's records agreeing.
    const ex = make();
    ex.exposedHint = () => true;
    await ex.watchdogStep(nowMs);
    bybit.down = true;
    await ex.watchdogStep(nowMs + 1500);
    await ex.watchdogStep(nowMs + 1500 + 19_000);
    expect(alarms).toEqual([]);
    await ex.watchdogStep(nowMs + 1500 + 21_000);
    await ex.watchdogStep(nowMs + 1500 + 24_000);
    expect(alarms.map((a) => a.kind)).toEqual(["unreachable"]);
    expect(alarms[0].text).toMatch(/Bybit cannot be read for 2\d seconds while a position may be open.*the stop at Bybit still works if it was set/);
    bybit.down = false;
    await ex.watchdogStep(nowMs + 40_000);
    expect(alarms.map((a) => a.kind)).toEqual(["unreachable", "resolved"]);
  });

  it("a position that has no correct stop also refuses new entries until it is dealt with", async () => {
    bybit.hold(0.001, 76_000);
    bybit.tradingStopFails = true;
    const refused = refuseReduceOnly(100_000);
    const ex = make();
    // The close never goes through in this step's 30 seconds, so the episode stays open.
    const r = await ex.watchdogStep(nowMs);
    expect(r.state).toBe("closing");
    expect(refused.tries()).toBeGreaterThanOrEqual(25);
    expect(ex.watchdogHealth()).toMatchObject({ ok: false, reason: expect.stringMatching(/no correct stop loss/) });
    const err = await ex.placeOpenOrder(openReq()).catch((e) => e);
    expect(String(err)).toMatch(/not healthy/);
  });
});

describe("a flip while a stop is pending, end to end", () => {
  it("the flip closes the old side reduce-only, the new side opens with its own stop, and at no moment does a position exist without one", async () => {
    const ex = make();
    const run = (direction: "bullish" | "bearish", barTime: string, now: number) => {
      nowMs = now;
      const signal = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: direction, price: 29_284.55, barTime, interval: "5", raw: { symbol: "BTC" }, now });
      return processSignal(signal, { executor: ex, now, closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 });
    };
    await run("bullish", "b1", BASE_NOW);
    expect(bybit.position).toMatchObject({ size: 0.001, stopLoss: 75_240 });
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(bybit.position.size).toBe(-0.001);
    expect(bybit.position.stopLoss).toBe(76_760);
    expect(reduceOnlys()).toHaveLength(1);
    expect(bybit.unprotectedMoments).toBe(0);
    expect((await ex.watchdogStep(nowMs)).state).toBe("protected");
    expect(alarms).toEqual([]);
  });
});

describe("the alarm reaches the Log, the red banner and the bell", () => {
  it("a problem: a Log entry (an executor error, so the bell rings), the red banner with the sentence, and the entry is labelled as the watchdog's", () => {
    raiseStopAlarm({ kind: "stop_problem", text: "the long 0.001 BTCUSDT at Bybit has no correct stop loss: there is no stop loss." }, BASE_NOW);
    const d = decisionsStore.all().find((x) => x.botId === BTC_BOT_ID && x.outcome === "executor_error")!;
    expect(d.reason).toBe("STOP LOSS ALARM: the long 0.001 BTCUSDT at Bybit has no correct stop loss: there is no stop loss.");
    expect(d.detail).toMatchObject({ stopWatchdog: true, kind: "stop_problem" });
    const bot = botsStore.get(BTC_BOT_ID)!;
    expect(bot.needsAttention).toBe(true);
    expect(bot.needsAttentionReason).toMatch(/^STOP LOSS ALARM: /);
    expect(notificationsStore.all().some((n) => /STOP LOSS ALARM/.test(JSON.stringify(n)))).toBe(true);
    expect(systemEntryLabel(d)).toBe("Stop watchdog");
  });

  it("Bybit unreachable is the same kind of alarm", () => {
    raiseStopAlarm({ kind: "unreachable", text: "Bybit cannot be read for 21 seconds while a position may be open." }, BASE_NOW);
    expect(botsStore.get(BTC_BOT_ID)!.needsAttentionReason).toMatch(/cannot be read for 21 seconds/);
    expect(decisionsStore.all().filter((x) => x.outcome === "executor_error")).toHaveLength(1);
  });

  it("the all-clear is written to the Log but does not clear the banner: a person looks at what happened", () => {
    raiseStopAlarm({ kind: "stop_problem", text: "A." }, BASE_NOW);
    raiseStopAlarm({ kind: "resolved", text: "Repaired." }, BASE_NOW + 1000);
    expect(decisionsStore.all().some((x) => x.outcome === "position_resolved" && x.reason === "Stop watchdog: Repaired.")).toBe(true);
    expect(botsStore.get(BTC_BOT_ID)!.needsAttention).toBe(true);
  });
});
