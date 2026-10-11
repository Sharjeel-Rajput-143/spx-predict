import { beforeEach, describe, expect, it } from "vitest";
import { ensureBotRecord } from "./bots";
import { exitMet, minutesToMarketClose, runExitChecks } from "./exitChecks";
import { MockExecutor } from "./executor";
import { validateOpenSettings } from "./openSettings";
import { botsStore, decisionsStore, positionsStore } from "./store";
import { NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";

// The expiration exit: close at market N minutes before the market closes, on the day the position expires. Needs only the clock:
// no option prices, no quote. Off unless a position was opened with it.

setNdxTestEnv();

const timing = { closeConfirmTimeoutMs: 100, pollIntervalMs: 4, ladderStepMs: 10 };
const et = (month: number, day: number, h: number, m: number, offset = 4) => Date.UTC(2026, month - 1, day, h + offset, m);
const TUE = (h: number, m: number) => et(10, 6, h, m); // Tuesday 6 October 2026, daylight time
let executor: MockExecutor;

const hold = (exit: object, over: Partial<Parameters<typeof buildPosition>[0]> = {}) =>
  positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 1, filledQuantity: 1, credit: 4, expiry: "2026-10-06", exitOptions: exit as never, ...over }));

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(NDX_BOT_ID);
  executor = new MockExecutor();
});

describe("minutes to the close", () => {
  it("counts from the clock to 4:00pm, or 1:00pm on an early-close day", () => {
    expect(minutesToMarketClose(TUE(15, 30))).toBe(30);
    expect(minutesToMarketClose(TUE(10, 0))).toBe(360);
    expect(minutesToMarketClose(TUE(15, 59))).toBe(1);
    expect(minutesToMarketClose(et(11, 27, 12, 30, 5))).toBe(30); // the day after Thanksgiving closes at 1pm
    expect(minutesToMarketClose(et(11, 27, 10, 0, 5))).toBe(180);
  });
});

describe("when the expiration exit is met", () => {
  const position = { type: "short_put_spread" as const, shortStrike: 20_970, credit: 4, filledQuantity: 1, requestedQuantity: 1 };
  it("exactly when the minutes left are at or under what was set, never before", () => {
    expect(exitMet(position, { expirationMinutes: 30 }, { debit: null, underlying: null, minutesToClose: 31 })).toBeNull();
    expect(exitMet(position, { expirationMinutes: 30 }, { debit: null, underlying: null, minutesToClose: 30 })?.kind).toBe("expiration");
    expect(exitMet(position, { expirationMinutes: 30 }, { debit: null, underlying: null, minutesToClose: 3 })?.kind).toBe("expiration");
  });
  it("not when the position doesn't expire today (no clock reading), and not when it wasn't set", () => {
    expect(exitMet(position, { expirationMinutes: 30 }, { debit: null, underlying: null, minutesToClose: null })).toBeNull();
    expect(exitMet(position, { expirationMinutes: 30 }, { debit: null, underlying: null })).toBeNull();
    expect(exitMet(position, { stopPercent: 100 }, { debit: null, underlying: null, minutesToClose: 1 })).toBeNull();
  });
  it("a stop loss or profit target that is met is reported as that, ahead of the clock", () => {
    expect(exitMet(position, { stopPercent: 50, expirationMinutes: 30 }, { debit: 7, underlying: null, minutesToClose: 10 })?.kind).toBe("stop_percent");
  });
});

describe("setting it", () => {
  it("takes whole minutes from 1 to 390, nothing else", () => {
    expect(validateOpenSettings({ exit: { expirationMinutes: 30 } })).toMatchObject({ ok: true, value: { exit: { expirationMinutes: 30 } } });
    for (const bad of [0, -5, 1.5, 391, "30", null, Number.NaN]) expect(validateOpenSettings({ exit: { expirationMinutes: bad } }), String(bad)).toMatchObject({ ok: false });
  });
});

describe("the bot acting on it", () => {
  it("closes the position at market once the time comes, with no quotes needed, and says why in the Log", async () => {
    const p = hold({ expirationMinutes: 30 });
    const r = await runExitChecks(NDX_BOT_ID, TUE(15, 31), { executor, ...timing });
    expect(r.closed).toBe(1);
    expect(positionsStore.get(p.id)?.status).toBe("closed");
    const close = executor.placedOrders.filter((o) => o.kind === "close");
    expect(close).toHaveLength(1);
    expect(close[0].price).toBeUndefined(); // at market: no limit price
    const log = decisionsStore.all().at(-1)!;
    expect(log).toMatchObject({ outcome: "exit_closed", signalId: null });
    expect(log.reason).toMatch(/expiration exit/);
  });

  it("does nothing before the time, and a minute earlier than that is still too early", async () => {
    hold({ expirationMinutes: 30 });
    expect((await runExitChecks(NDX_BOT_ID, TUE(10, 40), { executor, ...timing })).closed).toBe(0);
    expect((await runExitChecks(NDX_BOT_ID, TUE(15, 29), { executor, ...timing })).closed).toBe(0);
    expect(positionsStore.all()[0].status).toBe("open");
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("only on the day the position expires: an older expiry or a future one is left alone", async () => {
    hold({ expirationMinutes: 30 }, { expiry: "2026-10-07" }); // expires tomorrow
    expect((await runExitChecks(NDX_BOT_ID, TUE(15, 45), { executor, ...timing })).closed).toBe(0);
    expect(positionsStore.all()[0].status).toBe("open");
  });

  it("on an early-close day the close is 1pm, so 30 minutes before is 12:30pm", async () => {
    hold({ expirationMinutes: 30 }, { expiry: "2026-11-27" });
    expect((await runExitChecks(NDX_BOT_ID, et(11, 27, 12, 20, 5), { executor, ...timing })).closed).toBe(0); // 40 minutes left
    expect((await runExitChecks(NDX_BOT_ID, et(11, 27, 12, 31, 5), { executor, ...timing })).closed).toBe(1); // 29 minutes left
  });

  it("a position without the option is never closed by the clock, however late", async () => {
    hold({ stopPercent: 100 });
    hold({}, { shortStrike: 20_900, longStrike: 20_890 });
    expect((await runExitChecks(NDX_BOT_ID, TUE(15, 58), { executor, ...timing })).closed).toBe(0);
    expect(positionsStore.all().every((p) => p.status === "open")).toBe(true);
  });

  it("a position placed by hand is never closed by it, and it closes once, not on every minute after", async () => {
    hold({ expirationMinutes: 30 }, { manual: true });
    expect((await runExitChecks(NDX_BOT_ID, TUE(15, 40), { executor, ...timing })).closed).toBe(0);
    resetAutomationStores();
    setNdxTestEnv();
    ensureBotRecord(NDX_BOT_ID);
    executor = new MockExecutor();
    hold({ expirationMinutes: 30 });
    expect((await runExitChecks(NDX_BOT_ID, TUE(15, 40), { executor, ...timing })).closed).toBe(1);
    expect((await runExitChecks(NDX_BOT_ID, TUE(15, 41), { executor, ...timing })).closed).toBe(0);
    expect(executor.placedOrders.filter((o) => o.kind === "close")).toHaveLength(1);
  });

  it("it still works with the bot switched off (a close must not be blocked), and not with the kill switch on", async () => {
    hold({ expirationMinutes: 30 });
    botsStore.update(NDX_BOT_ID, { killSwitch: true });
    expect((await runExitChecks(NDX_BOT_ID, TUE(15, 40), { executor, ...timing })).skipped).toBe("kill_switch");
    botsStore.update(NDX_BOT_ID, { killSwitch: false, enabled: false });
    expect((await runExitChecks(NDX_BOT_ID, TUE(15, 40), { executor, ...timing })).closed).toBe(1);
  });

  it("a dry run only says it would close", async () => {
    hold({ expirationMinutes: 30 });
    const r = await runExitChecks(NDX_BOT_ID, TUE(15, 40), { executor, dryRun: true, ...timing });
    expect(r.wouldClose).toBe(1);
    expect(positionsStore.all()[0].status).toBe("open");
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("a close that fails is flagged for a person and not retried blindly", async () => {
    hold({ expirationMinutes: 30 });
    executor.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "market closed" });
    const r = await runExitChecks(NDX_BOT_ID, TUE(15, 40), { executor, ...timing });
    expect(r.failed).toBe(1);
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ needsAttention: true });
  });
});
