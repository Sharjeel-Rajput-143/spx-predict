import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord } from "./bots";
import type { BybitConfig } from "./bybitExecutor";
import { LiveBybitExecutor } from "./bybitLive";
import { LIVE_API_BASE, LIVE_BOT_ID, LIVE_LIMITS } from "./bybitLiveLimits";
import { __resetLiveWatchdogForTests, liveRiskTick } from "./bybitLiveWatchdog";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { RESUME_DELAYS_MS, __resetLastCheck, attemptAutoResume, chooseStage, liveStatus, runAccountCheck, scheduleAutoResume, setDailyLoss, tidyMirror, turnSwitchOff, turnSwitchOn, type LiveControlDeps } from "./liveControl";
import { liveGate, readLedger } from "./ledger";
import { appLiveGuard } from "./liveGuard";
import { __resetLiveSettings, bootLiveSettings, liveDataDir, readLiveSettings, updateLiveSettings } from "./liveSettings";
import { botsStore, decisionsStore } from "./store";
import { BASE_NOW, resetAutomationStores, setNdxTestEnv } from "./testSupport";

// THE LIVE CONTROLS against a fake REAL Bybit exchange: the real executor, the real settings, the real bot records. No network, no key.
// The questions: does ON ever happen without all three conditions? does OFF always happen? is anything left ON after a restart?

setNdxTestEnv();
const base: Omit<BybitConfig, "apiBase"> = { apiKey: API_KEY, apiSecret: API_SECRET, symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 3, breakevenTriggerPercent: 0, breakevenLockPercent: 0, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000 };
const g = globalThis as typeof globalThis & { __liveBybit?: { executor: LiveBybitExecutor | null; error: string | null }; __liveBootedApp?: boolean };

let fake: FakeBybit;
let live: LiveBybitExecutor;
let nowMs = BASE_NOW;
const deps = (over: Partial<LiveControlDeps> = {}): LiveControlDeps => ({ executor: () => g.__liveBybit?.executor ?? null, problem: () => g.__liveBybit?.error ?? null, gate: () => ({ ok: false, why: "gate not passed" }), now: () => nowMs, ...over });
const sdeps = () => ({ executor: () => g.__liveBybit?.executor ?? null, problem: () => g.__liveBybit?.error ?? null, now: () => nowMs });
const bot = () => botsStore.get(LIVE_BOT_ID)!;

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  __resetLiveSettings();
  __resetLastCheck();
  __resetLiveWatchdogForTests();
  g.__liveBootedApp = true;
  nowMs = BASE_NOW;
  fake = new FakeBybit();
  fake.clock = () => nowMs;
  live = new LiveBybitExecutor({ ...base, apiBase: LIVE_API_BASE }, appLiveGuard, fake.fetch, () => undefined, () => nowMs);
  live.sleep = async () => undefined;
  g.__liveBybit = { executor: live, error: null };
  ensureBotRecord(LIVE_BOT_ID);
});
afterEach(() => vi.unstubAllEnvs());

describe("everything starts OFF", () => {
  it("the switch, the mirror and the live bot are OFF, and the limits are the code's", () => {
    const s = liveStatus(sdeps());
    expect(s.switch.on).toBe(false);
    expect(s.mirror.on).toBe(false);
    expect(s.bot).toMatchObject({ exists: true, enabled: false });
    expect(s.limits).toEqual({ maxQty: 0.001, dailyLossCeilingUsd: 3, maxTradesPerDay: 5, maxOpenPositions: 1 });
    expect(s).toMatchObject({ stage: 1, leverage: 10, dailyLossUsd: 2, host: "api.bybit.com", tradesToday: 0 });
    expect(s.gate.tests).toMatchObject({ passed: 0, total: 6 });
  });
  it("the status says whether a key is present and never contains a key or a secret", () => {
    const text = JSON.stringify(liveStatus(sdeps()));
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(API_SECRET);
    expect(liveStatus(sdeps()).key).toEqual({ present: true, problem: null });
  });
});

describe("the account check (the Check the live account now button)", () => {
  it("passes on a new cross-margin account: switched to isolated, 10x read back, no 'position record' problem, tradeMode 0 as at Bybit", async () => {
    const r = await runAccountCheck(deps());
    expect(r).toMatchObject({ ok: true });
    const check = (r as { check: { ok: boolean; problems: string[]; marginMode: string | null; leverage: number | null } }).check;
    expect(check).toMatchObject({ ok: true, problems: [], marginMode: "ISOLATED_MARGIN", leverage: 10 });
    expect(liveStatus(sdeps()).check).toMatchObject({ ok: true, marginMode: "ISOLATED_MARGIN", leverage: 10 });
  });
  it("passes on an account that is already isolated, and on one whose position record gives no leverage (with the plain warning)", async () => {
    fake.account.marginMode = "ISOLATED_MARGIN";
    expect((await runAccountCheck(deps()) as { check: { ok: boolean } }).check.ok).toBe(true);
    fake.account.leverageStyle = "missing";
    fake.account.leverage = 20;
    const r = (await runAccountCheck(deps())) as { check: { ok: boolean; leverage: number | null; warnings: string[] } };
    expect(r.check).toMatchObject({ ok: true, leverage: 10 });
    expect(readLiveSettings().warnings.join(" ")).toMatch(/could not be read back/);
  });
  it("still fails on cross margin that Bybit will not switch, and the page says so", async () => {
    fake.account.refuseMarginSwitch = true;
    const r = (await runAccountCheck(deps())) as { check: { ok: boolean; problems: string[]; marginMode: string | null } };
    expect(r.check.ok).toBe(false);
    expect(r.check.marginMode).toBe("REGULAR_MARGIN");
    expect(r.check.problems.join(" ")).toMatch(/not isolated margin/);
  });
});

describe("the live toggle goes ON only with the one confirm, a key, and a passed check (no typing)", () => {
  it("with no live key nothing can be turned ON, and Bybit is not asked anything", async () => {
    g.__liveBybit = { executor: null, error: "The live bot will not trade until these are set in .env.local: BYBIT_LIVE_API_KEY, BYBIT_LIVE_API_SECRET" };
    const r = await turnSwitchOn(true, deps());
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as { error: string }).error).toMatch(/no live key/);
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false, resume: false });
    expect(bot().enabled).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(liveStatus(sdeps()).key.present).toBe(false);
  });

  it.each([[undefined], [false], [null], ["true"], [1], ["LIVE"], [""], [{}]])("without the confirm (%j) it is refused before Bybit is even asked, and a typed word does not help", async (confirmed) => {
    const r = await turnSwitchOn(confirmed, deps());
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toMatch(/Confirm that real money/);
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false, resume: false });
    expect(bot().enabled).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("with the confirm, a key and a passing check it turns ON, and the mirror with it: the bot is on, the account is isolated at 10x, and the banner is cleared", async () => {
    botsStore.update(LIVE_BOT_ID, { needsAttention: true, needsAttentionReason: "LIVE SWITCH TURNED OFF: an earlier alarm" });
    const r = await turnSwitchOn(true, deps());
    expect(r).toMatchObject({ ok: true });
    expect(readLiveSettings()).toMatchObject({ enabled: true, mirrorEnabled: true, resume: true, typedAt: nowMs });
    expect(bot()).toMatchObject({ enabled: true, needsAttention: false });
    expect(fake.account).toMatchObject({ marginMode: "ISOLATED_MARGIN", leverage: 10 });
    expect(liveStatus(sdeps()).check).toMatchObject({ ok: true, marginMode: "ISOLATED_MARGIN", leverage: 10 });
    expect(decisionsStore.query((d) => d.botId === LIVE_BOT_ID).some((d) => /TURNED ON/.test(d.reason ?? ""))).toBe(true);
    // the check made no order
    expect(fake.created).toHaveLength(0);
  });

  it("the check is run again for each turn-on: a check that passed a minute ago is not enough", async () => {
    await runAccountCheck(deps());
    expect(liveStatus(sdeps()).check?.ok).toBe(true);
    fake.keyInfo.permissions.Wallet = ["AccountTransfer"]; // the key was edited at Bybit since
    const r = await turnSwitchOn(true, deps());
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/move money/);
    expect(readLiveSettings().enabled).toBe(false);
    expect(bot().enabled).toBe(false);
  });

  it.each([
    ["a key with withdraw rights", (f: FakeBybit) => void (f.keyInfo.permissions.Wallet = ["Withdraw"]), /move money/],
    ["a key with transfer rights", (f: FakeBybit) => void (f.keyInfo.permissions.Wallet = ["AccountTransfer"]), /move money/],
    ["a read only key", (f: FakeBybit) => void (f.keyInfo.readOnly = 1), /read only/],
    ["a key without contract trading", (f: FakeBybit) => void (f.keyInfo.permissions.ContractTrade = []), /contract trading/],
    ["an account that fell back to cross margin and will not go isolated", (f: FakeBybit) => void ((f.account.marginMode = "REGULAR_MARGIN"), (f.account.refuseMarginSwitch = true)), /isolated/],
    ["a leverage that will not stick", (f: FakeBybit) => void ((f.account.leverage = 3), (f.account.refuseLeverage = true)), /leverage/],
  ])("%s: ON is refused, and the switch and the bot stay OFF", async (_name, arrange, message) => {
    arrange(fake);
    const r = await turnSwitchOn(true, deps());
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as { error: string }).error).toMatch(message);
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false, resume: false });
    expect(bot().enabled).toBe(false);
  });

  it("a key without an IP restriction is a red warning on the page, not a block", async () => {
    fake.keyInfo.ips = [];
    const r = await turnSwitchOn(true, deps());
    expect(r).toMatchObject({ ok: true });
    expect(liveStatus(sdeps()).warnings.join(" ")).toMatch(/no IP restriction/);
  });

  it("Bybit not answering is a refusal that says so, not an ON and not a crash", async () => {
    fake.down = true;
    const r = await turnSwitchOn(true, deps());
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as { error: string }).error).toMatch(/could not be asked/);
    expect(readLiveSettings().enabled).toBe(false);
  });

  it("the kill switch blocks ON, the bot's own and the environment one", async () => {
    botsStore.update(LIVE_BOT_ID, { killSwitch: true });
    expect(await turnSwitchOn(true, deps())).toMatchObject({ ok: false });
    botsStore.update(LIVE_BOT_ID, { killSwitch: false });
    vi.stubEnv("BYBIT_KILL_SWITCH", "true");
    expect(await turnSwitchOn(true, deps())).toMatchObject({ ok: false });
    expect(readLiveSettings().enabled).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("stage 2 needs the live gate; stage 1 does not", async () => {
    expect(chooseStage(2, { gate: () => ({ ok: false, why: "gate not passed" }), now: () => nowMs })).toMatchObject({ ok: false });
    expect(readLiveSettings().stage).toBe(1);
    expect(chooseStage(2, { gate: () => ({ ok: true, why: "" }), now: () => nowMs })).toMatchObject({ ok: true });
    expect(readLiveSettings().stage).toBe(2);
    // at stage 2 the switch needs the gate too (the dep says no)
    expect(await turnSwitchOn(true, deps())).toMatchObject({ ok: false });
    expect(readLiveSettings().enabled).toBe(false);
    // going back to stage 1 is always allowed, and stage 1 is not held up by the gate
    expect(chooseStage(1, { gate: () => ({ ok: false, why: "no" }), now: () => nowMs })).toMatchObject({ ok: true });
    expect(await turnSwitchOn(true, deps())).toMatchObject({ ok: true });
    expect(fake.account.leverage).toBe(10);
  });

  it("a stage change turns the toggle OFF and the bot with it, and clears the saved ON state", async () => {
    await turnSwitchOn(true, deps());
    expect(readLiveSettings().enabled).toBe(true);
    chooseStage(2, { gate: () => ({ ok: true, why: "" }), now: () => nowMs });
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false, stage: 2 });
    expect(bot().enabled).toBe(false);
  });
});

describe("OFF always works", () => {
  it("turns the switch and the bot OFF with Bybit down, without asking Bybit anything", async () => {
    await turnSwitchOn(true, deps());
    fake.calls.length = 0;
    fake.down = true;
    const r = turnSwitchOff({ now: () => nowMs });
    expect(r).toMatchObject({ ok: true });
    expect(readLiveSettings()).toMatchObject({ enabled: false });
    expect(readLiveSettings().offReason).toMatch(/by you/);
    expect(bot().enabled).toBe(false);
    expect(bot().needsAttention).toBe(false); // a deliberate OFF is not an alarm
    expect(readLiveSettings().resume).toBe(false); // an OFF click is never resumed
    expect(fake.calls).toHaveLength(0);
  });
  it("needs no confirm: one call, nothing else asked", async () => {
    await turnSwitchOn(true, deps());
    expect(turnSwitchOff.length).toBeLessThanOrEqual(1);
    expect(turnSwitchOff({ now: () => nowMs })).toMatchObject({ ok: true });
    expect(readLiveSettings().enabled).toBe(false);
  });
  it("is still OFF when the settings file cannot be written", async () => {
    await turnSwitchOn(true, deps());
    const fs = await import("node:fs");
    const spy = vi.spyOn(fs.default, "renameSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    try {
      turnSwitchOff({ now: () => nowMs });
    } finally {
      spy.mockRestore();
    }
    expect(readLiveSettings().enabled).toBe(false);
  });
  it("a live position stays closable: OFF stops new entries only", async () => {
    await turnSwitchOn(true, deps());
    turnSwitchOff({ now: () => nowMs });
    const block = await live.entryBlock(LIVE_BOT_ID, nowMs);
    expect(block).toMatchObject({ outcome: "kill_switch" });
  });
});

describe("the mirror follows the toggle", () => {
  it("is turned ON by the toggle, in the same step, and by nothing else", async () => {
    expect(readLiveSettings().mirrorEnabled).toBe(false);
    await turnSwitchOn(true, deps());
    expect(readLiveSettings()).toMatchObject({ enabled: true, mirrorEnabled: true });
  });
  it("OFF with no live position held: both are OFF (the mirror is tidied at once, and Bybit is only read, never changed)", async () => {
    await turnSwitchOn(true, deps());
    turnSwitchOff({ now: () => nowMs });
    expect(await tidyMirror(deps())).toBe("off");
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false });
    expect(fake.of("/v5/order/create", "POST")).toHaveLength(0);
  });
  it("OFF while the live ACCOUNT holds a position: the mirror stays ON, however many times it is tidied", async () => {
    await turnSwitchOn(true, deps());
    fake.position = { size: 0.001, avg: 76_000, stopLoss: 75_700, takeProfit: 76_600 };
    turnSwitchOff({ now: () => nowMs });
    expect(await tidyMirror(deps())).toBe("kept");
    expect(await tidyMirror(deps())).toBe("kept");
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: true });
  });
  it("OFF while the app's RECORDS show a live position: the mirror stays ON even if the account looks flat", async () => {
    await turnSwitchOn(true, deps());
    turnSwitchOff({ now: () => nowMs });
    expect(await tidyMirror(deps(), () => true)).toBe("kept");
    expect(readLiveSettings().mirrorEnabled).toBe(true);
  });
  it("when the held position closes, the next tidy turns the mirror OFF", async () => {
    await turnSwitchOn(true, deps());
    fake.position = { size: 0.001, avg: 76_000, stopLoss: 75_700, takeProfit: 76_600 };
    turnSwitchOff({ now: () => nowMs });
    expect(await tidyMirror(deps())).toBe("kept");
    fake.position = { size: 0, avg: 0, stopLoss: 0, takeProfit: 0 };
    expect(await tidyMirror(deps())).toBe("off");
    expect(readLiveSettings().mirrorEnabled).toBe(false);
  });
  it("an unreadable account never turns the mirror OFF blind", async () => {
    await turnSwitchOn(true, deps());
    turnSwitchOff({ now: () => nowMs });
    fake.down = true;
    expect(await tidyMirror(deps())).toBe("kept");
    expect(readLiveSettings().mirrorEnabled).toBe(true);
  });
  it("never touches the mirror while the toggle is ON, or when it is already OFF", async () => {
    await turnSwitchOn(true, deps());
    expect(await tidyMirror(deps())).toBe("nothing");
    expect(readLiveSettings().mirrorEnabled).toBe(true);
    turnSwitchOff({ now: () => nowMs });
    await tidyMirror(deps());
    expect(await tidyMirror(deps())).toBe("nothing");
  });
  it("turned ON again while Bybit is being asked: the mirror is left alone", async () => {
    await turnSwitchOn(true, deps());
    turnSwitchOff({ now: () => nowMs });
    const slow = deps({ executor: () => ({ preflight: async () => ({ ok: true, problems: [], warnings: [] }), getAccountPosition: async () => { await turnSwitchOn(true, deps()); return { side: null, size: 0, avgPrice: null, stopLoss: null }; } }) });
    expect(await tidyMirror(slow)).toBe("kept");
    expect(readLiveSettings()).toMatchObject({ enabled: true, mirrorEnabled: true });
  });
});

describe("after a restart both are OFF until the checks say otherwise", () => {
  it("the file said ON for both; the new process starts with both OFF on disk and in memory, with a resume waiting", async () => {
    await turnSwitchOn(true, deps());
    expect(readLiveSettings()).toMatchObject({ enabled: true, mirrorEnabled: true });
    restart();
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false, resume: true });
    expect(liveStatus(sdeps())).toMatchObject({ resumePending: true, switch: { on: false } });
    expect(bot().enabled).toBe(false);
  });
});

const restart = () => {
  (globalThis as { __liveBooted?: boolean }).__liveBooted = false; // a new process
  bootLiveSettings(nowMs + 1);
  botsStore.update(LIVE_BOT_ID, { enabled: false }); // bootLive() does this too
};
const ledgerKinds = () => readLedger().events.filter((e) => e.kind === "live_auto_resume");
const calls = (path: string) => fake.calls.filter((c) => c.path === path).length;
const noCheckAsked = () => expect(calls("/v5/user/query-api")).toBe(0);

describe("AUTO RESUME: the saved ON state comes back after a restart or a release", () => {
  it("was ON, nothing tripped, key present, account check passes, flat: it turns ON again BY ITSELF, the mirror and the live bot with it, with no typing and no confirm", async () => {
    await turnSwitchOn(true, deps());
    restart();
    expect(await attemptAutoResume(deps())).toBe("resumed");
    expect(readLiveSettings()).toMatchObject({ enabled: true, mirrorEnabled: true, resume: true, offReason: null });
    expect(bot().enabled).toBe(true);
    expect(calls("/v5/user/query-api")).toBeGreaterThan(0); // the app ran the account check right then
    expect(fake.created).toHaveLength(0); // and no order
    expect(decisionsStore.query((d) => d.botId === LIVE_BOT_ID).some((d) => /BACK ON BY ITSELF/.test(d.reason ?? ""))).toBe(true);
  });
  it("the ledger records an event saying it was an auto resume", async () => {
    await turnSwitchOn(true, deps());
    restart();
    await attemptAutoResume(deps());
    const events = ledgerKinds();
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ at: nowMs, stage: 1, marginMode: "ISOLATED_MARGIN", leverage: 10, heldSide: null });
    expect(readLedger().damaged).toBeFalsy(); // the chain is intact with the new kind in it
    expect(liveGate().trades.clean).toBeGreaterThanOrEqual(0); // the gate still reads the ledger
  });
  it("a plain deliberate ON writes no auto resume event", async () => {
    await turnSwitchOn(true, deps());
    expect(ledgerKinds()).toHaveLength(0);
  });
  it("it resumes only once: a second attempt finds nothing to do", async () => {
    await turnSwitchOn(true, deps());
    restart();
    expect(await attemptAutoResume(deps())).toBe("resumed");
    expect(await attemptAutoResume(deps())).toBe("nothing");
    expect(ledgerKinds()).toHaveLength(1);
  });
  it("with no restart in between (still ON) there is nothing to resume and Bybit is not asked", async () => {
    await turnSwitchOn(true, deps());
    fake.calls.length = 0;
    expect(await attemptAutoResume(deps())).toBe("nothing");
    expect(fake.calls).toHaveLength(0);
  });
  it("a position held WITH a confirmed stop does not stop the resume (the stop is read from the account), and it is written in the event", async () => {
    await turnSwitchOn(true, deps());
    restart();
    fake.position = { size: 0.001, avg: 76_000, stopLoss: 75_700, takeProfit: 76_600 };
    expect(await attemptAutoResume(deps())).toBe("resumed");
    expect(ledgerKinds()[0].data).toMatchObject({ heldSide: "Buy", heldSize: 0.001, stopLoss: 75_700 });
  });
  it("a short held with its stop above entry resumes too", async () => {
    await turnSwitchOn(true, deps());
    restart();
    fake.position = { size: -0.001, avg: 76_000, stopLoss: 76_300, takeProfit: 75_400 };
    expect(await attemptAutoResume(deps())).toBe("resumed");
  });
});

describe("NO RESUME after any safety trip, after an OFF click, or without a key (the break-it checks)", () => {
  const trips: [string, () => Promise<void> | void][] = [
    ["an OFF click", () => void turnSwitchOff({ now: () => nowMs })],
    ["a STOP LOSS ALARM", () => void appLiveGuard.onAutoOff?.("STOP LOSS ALARM: the stop is missing")],
    ["a tripped daily loss limit", async () => {
      botsStore.update(LIVE_BOT_ID, { riskTrip: { day: (await import("./tradingHours")).easternDateKey(nowMs), reason: "daily_loss_limit_reached", at: nowMs } as never });
      await liveRiskTick(nowMs);
    }],
    ["the daily cap reported by the executor", () => void appLiveGuard.onAutoOff?.("the daily loss limit of $2.00 was reached")],
    ["a failed account check", async () => {
      fake.keyInfo.permissions.Wallet = ["Withdraw"];
      await runAccountCheck(deps());
    }],
    ["a failed pre-trade check", () => void appLiveGuard.onAutoOff?.("pre-trade check failed: cross margin")],
    ["the kill switch", async () => {
      botsStore.update(LIVE_BOT_ID, { killSwitch: true });
      await liveRiskTick(nowMs);
    }],
    ["a stage change", () => void chooseStage(2, { gate: () => ({ ok: true, why: "" }), now: () => nowMs })],
  ];
  it.each(trips)("after %s a restart does NOT resume it: still OFF, the saved ON state is gone, and Bybit is not even asked", async (_name, trip) => {
    await turnSwitchOn(true, deps());
    await trip();
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false });
    fake.calls.length = 0;
    restart();
    expect(liveStatus(sdeps()).resumePending).toBe(false);
    expect(await attemptAutoResume(deps())).toBe("nothing");
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false });
    expect(bot().enabled).toBe(false);
    expect(ledgerKinds()).toHaveLength(0);
    noCheckAsked();
  });
  it.each(trips)("after %s, even a resume attempt in the SAME process (no restart) does not turn it ON", async (_name, trip) => {
    await turnSwitchOn(true, deps());
    await trip();
    expect(await attemptAutoResume(deps())).toBe("nothing");
    expect(readLiveSettings().enabled).toBe(false);
  });
  it("without a live key: not resumed, and the saved state is dropped (a later key does not resume it either)", async () => {
    await turnSwitchOn(true, deps());
    restart();
    g.__liveBybit = { executor: null, error: "The live bot will not trade until these are set in .env.local: BYBIT_LIVE_API_KEY" };
    expect(await attemptAutoResume(deps())).toBe("refused");
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false });
    expect(readLiveSettings().offReason).toMatch(/no live key/);
    g.__liveBybit = { executor: live, error: null };
    expect(await attemptAutoResume(deps())).toBe("nothing");
    expect(readLiveSettings().enabled).toBe(false);
    expect(ledgerKinds()).toHaveLength(0);
  });
  it.each([
    ["a key with withdraw rights", (f: FakeBybit) => void (f.keyInfo.permissions.Wallet = ["Withdraw"]), /move money/],
    ["a read only key", (f: FakeBybit) => void (f.keyInfo.readOnly = 1), /read only/],
    ["an account that fell back to cross margin and will not go isolated", (f: FakeBybit) => void ((f.account.marginMode = "REGULAR_MARGIN"), (f.account.refuseMarginSwitch = true)), /isolated/],
    ["a leverage that will not stick", (f: FakeBybit) => void ((f.account.leverage = 3), (f.account.refuseLeverage = true)), /leverage|110026|not modified/],
  ])("%s at resume time: not resumed, red banner, and the saved state is dropped", async (_name, arrange, message) => {
    await turnSwitchOn(true, deps());
    restart();
    arrange(fake);
    const r = await attemptAutoResume(deps());
    expect(["refused", "retry"]).toContain(r);
    expect(readLiveSettings().enabled).toBe(false);
    if (r === "refused") {
      expect(readLiveSettings().resume).toBe(false);
      expect(`${readLiveSettings().offReason} ${bot().needsAttentionReason}`).toMatch(message);
      expect(bot().needsAttention).toBe(true);
    }
    expect(ledgerKinds()).toHaveLength(0);
    expect(fake.created).toHaveLength(0);
  });
  it("margin that does not read back as isolated (Bybit says OK to the switch but the account stays cross): never resumed", async () => {
    await turnSwitchOn(true, deps());
    restart();
    fake.account.marginMode = "REGULAR_MARGIN";
    fake.overrides.set("/v5/account/set-margin-mode", () => ({ ok: true, status: 200, text: async () => JSON.stringify({ retCode: 0, retMsg: "OK", result: { reasons: [] } }) }));
    expect(await attemptAutoResume(deps())).toBe("refused");
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false });
    expect(bot().needsAttention).toBe(true);
    expect(ledgerKinds()).toHaveLength(0);
  });
  it.each([
    ["a position held with NO stop loss", { size: 0.001, avg: 76_000, stopLoss: 0, takeProfit: 76_600 }],
    ["a long whose stop is above its entry", { size: 0.001, avg: 76_000, stopLoss: 76_300, takeProfit: 76_600 }],
    ["a short whose stop is below its entry", { size: -0.001, avg: 76_000, stopLoss: 75_700, takeProfit: 75_400 }],
  ])("%s: never resumed, red banner", async (_name, position) => {
    await turnSwitchOn(true, deps());
    restart();
    fake.position = position;
    expect(await attemptAutoResume(deps())).toBe("refused");
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false });
    expect(readLiveSettings().offReason).toMatch(/without a confirmed stop/);
    expect(bot()).toMatchObject({ enabled: false, needsAttention: true });
    expect(ledgerKinds()).toHaveLength(0);
  });
  it("the kill switch at resume time: never resumed", async () => {
    await turnSwitchOn(true, deps());
    restart();
    fake.calls.length = 0;
    botsStore.update(LIVE_BOT_ID, { killSwitch: true });
    expect(await attemptAutoResume(deps())).toBe("refused");
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false });
    expect(calls("/v5/user/query-api")).toBe(0); // refused before Bybit was asked anything
  });
  it("the environment kill switch at resume time: never resumed", async () => {
    await turnSwitchOn(true, deps());
    restart();
    vi.stubEnv("BYBIT_KILL_SWITCH", "true");
    expect(await attemptAutoResume(deps())).toBe("refused");
    expect(readLiveSettings().enabled).toBe(false);
  });
  it("a daily loss limit already tripped today: never resumed", async () => {
    await turnSwitchOn(true, deps());
    restart();
    botsStore.update(LIVE_BOT_ID, { riskTrip: { day: (await import("./tradingHours")).easternDateKey(nowMs), reason: "daily_loss_limit_reached", at: nowMs } as never });
    expect(await attemptAutoResume(deps())).toBe("refused");
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false });
  });
  it("stage 2 without the gate: never resumed", async () => {
    await turnSwitchOn(true, deps());
    restart();
    fs.writeFileSync(path.join(liveDataDir(), "settings.json"), JSON.stringify({ ...readLiveSettings(), stage: 2, enabled: false, resume: true }));
    expect(await attemptAutoResume(deps({ gate: () => ({ ok: false, why: "gate not passed" }) }))).toBe("refused");
    expect(readLiveSettings().enabled).toBe(false);
  });
  it("turned OFF by hand while the resume is waiting: it is not resumed afterwards", async () => {
    await turnSwitchOn(true, deps());
    restart();
    turnSwitchOff({ now: () => nowMs });
    expect(await attemptAutoResume(deps())).toBe("nothing");
    expect(readLiveSettings().enabled).toBe(false);
  });
  it("turned OFF by hand while Bybit is being asked: the resume does not turn it back ON", async () => {
    await turnSwitchOn(true, deps());
    restart();
    const racing = deps({ executor: () => ({ preflight: () => live.preflight(), getAccountPosition: async () => { turnSwitchOff({ now: () => nowMs }); return { side: null, size: 0, avgPrice: null, stopLoss: null }; } }) });
    expect(await attemptAutoResume(racing)).toBe("nothing");
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false });
    expect(ledgerKinds()).toHaveLength(0);
  });
  it("Bybit unreadable: not resumed YET (retry), the saved state is kept; when Bybit answers it resumes", async () => {
    await turnSwitchOn(true, deps());
    restart();
    fake.down = true;
    expect(await attemptAutoResume(deps())).toBe("retry");
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: true });
    fake.down = false;
    expect(await attemptAutoResume(deps())).toBe("resumed");
  });
});

describe("the resume schedule", () => {
  const reset = () => {
    (globalThis as { __liveResumeScheduled?: boolean }).__liveResumeScheduled = false;
  };
  it("tries again while Bybit cannot be read, resumes as soon as it can, and stops", async () => {
    reset();
    await turnSwitchOn(true, deps());
    restart();
    fake.down = true;
    let n = 0;
    const waits: number[] = [];
    await scheduleAutoResume(deps(), [1, 2, 3, 4], async (ms) => {
      waits.push(ms);
      if (++n === 3) fake.down = false;
    });
    expect(waits).toEqual([1, 2, 3]);
    expect(readLiveSettings()).toMatchObject({ enabled: true, mirrorEnabled: true });
    expect(ledgerKinds()).toHaveLength(1);
  });
  it("gives up after the last try: the toggle stays OFF and the saved state is dropped", async () => {
    reset();
    await turnSwitchOn(true, deps());
    restart();
    fake.down = true;
    await scheduleAutoResume(deps(), [1, 2], async () => undefined);
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false });
    expect(readLiveSettings().offReason).toMatch(/gave up/);
    expect(ledgerKinds()).toHaveLength(0);
  });
  it("is silent in a dry run (a rehearsal): Bybit is never asked", async () => {
    reset();
    await turnSwitchOn(true, deps());
    restart();
    fake.calls.length = 0;
    vi.stubEnv("AUTOMATION_DRY_RUN", "true");
    await scheduleAutoResume(deps(), [1], async () => undefined);
    expect(fake.calls).toHaveLength(0);
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: true });
  });
  it("runs once per process", async () => {
    reset();
    await turnSwitchOn(true, deps());
    restart();
    let waits = 0;
    await scheduleAutoResume(deps(), [1], async () => void waits++);
    await scheduleAutoResume(deps(), [1], async () => void waits++);
    expect(waits).toBe(1);
  });
  it("the delays are a few tries over about 15 minutes", () => {
    expect(RESUME_DELAYS_MS.length).toBeGreaterThanOrEqual(3);
    expect(RESUME_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20 * 60_000);
  });
});

describe("automatic OFF", () => {
  it("a STOP LOSS ALARM turns the switch OFF and raises the banner", async () => {
    await turnSwitchOn(true, deps());
    appLiveGuard.onAutoOff?.("STOP LOSS ALARM: the stop is missing");
    expect(readLiveSettings().enabled).toBe(false);
    expect(readLiveSettings().offReason).toMatch(/STOP LOSS ALARM/);
    expect(bot()).toMatchObject({ enabled: false, needsAttention: true });
    // it takes the confirm again, and that clears the banner
    expect(await turnSwitchOn(true, deps())).toMatchObject({ ok: true });
    expect(bot().needsAttention).toBe(false);
  });
  it("a failed account check while the toggle is ON turns it OFF", async () => {
    await turnSwitchOn(true, deps());
    fake.keyInfo.permissions.Wallet = ["Withdraw"];
    await runAccountCheck(deps());
    expect(readLiveSettings().enabled).toBe(false);
    expect(bot().needsAttention).toBe(true);
  });
  it("a tripped daily cap turns it OFF at the next risk check", async () => {
    await turnSwitchOn(true, deps());
    botsStore.update(LIVE_BOT_ID, { riskTrip: { day: (await import("./tradingHours")).easternDateKey(nowMs), reason: "daily_loss_limit_reached", at: nowMs } as never });
    await liveRiskTick(nowMs);
    expect(readLiveSettings().enabled).toBe(false);
  });
  it("the kill switch (the bot's own, or the environment one) turns it OFF at the next risk check", async () => {
    await turnSwitchOn(true, deps());
    vi.stubEnv("BYBIT_KILL_SWITCH", "1");
    await liveRiskTick(nowMs);
    expect(readLiveSettings().enabled).toBe(false);
    vi.unstubAllEnvs();
    await turnSwitchOn(true, deps());
    expect(readLiveSettings().enabled).toBe(true);
    botsStore.update(LIVE_BOT_ID, { killSwitch: true });
    await liveRiskTick(nowMs);
    expect(readLiveSettings().enabled).toBe(false);
  });
});

describe("the daily loss limit and the ceilings", () => {
  it("accepts a limit up to the $3 ceiling and refuses anything above it, zero, or a non-number", () => {
    expect(setDailyLoss(1.5)).toMatchObject({ ok: true });
    expect(readLiveSettings().dailyLossUsd).toBe(1.5);
    expect(setDailyLoss("2.5")).toMatchObject({ ok: true });
    expect(readLiveSettings().dailyLossUsd).toBe(2.5);
    expect(setDailyLoss(3)).toMatchObject({ ok: true });
    for (const bad of [3.01, 99, 0, -1, "abc", "", null, undefined, NaN, Infinity]) {
      expect(setDailyLoss(bad)).toMatchObject({ ok: false, status: 400 });
    }
    expect(readLiveSettings().dailyLossUsd).toBe(3);
  });
  it("the limits shown are the code's constants; the order size and trade count cannot be set from here", () => {
    expect(LIVE_LIMITS).toEqual({ maxQty: 0.001, dailyLossCeilingUsd: 3, defaultDailyLossUsd: 2, maxTradesPerDay: 5, maxOpenPositions: 1 });
    expect(liveStatus(sdeps()).limits.maxQty).toBe(0.001);
    expect(chooseStage(3, deps())).toMatchObject({ ok: false, status: 400 });
    expect(chooseStage("2", deps())).toMatchObject({ ok: false, status: 400 });
  });
  it("updateLiveSettings still cannot turn the switch ON", () => {
    updateLiveSettings({ dailyLossUsd: 1 });
    expect(readLiveSettings().enabled).toBe(false);
  });
});
