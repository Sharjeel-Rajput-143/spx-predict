import { beforeEach, describe, expect, it, vi } from "vitest";
import { ownerUserId } from "@/lib/auth/users";
import { updateAppSettings } from "./appSettings";
import { botsStore, decisionsStore, notificationsStore } from "./store";
import { ensureBotRecord } from "./bots";
import { logDecision } from "./decisions";
import { MockExecutor } from "./executor";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { NOTIFICATION_CAP, QUIET_WINDOW_MS, LIST_LIMIT, clearNotifications, linkFor, listNotifications, markAllRead, markRead } from "./notifications";
import { flagMismatches } from "./reconcile";
import { BASE_NOW, NDX_BOT_ID, TEST_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import { runAs } from "./userContext";
import type { DecisionOutcome } from "./types";

// The bell's records: which events raise one, what they say, that the same alert is listed once, and that only the latest 200 are kept.

setTestBotEnv();
setNdxTestEnv();

const MIN = 60_000;
let t = BASE_NOW;
const raise = (outcome: DecisionOutcome, reason = `A reason for ${outcome}`, extra: { signalId?: string | null; detail?: Record<string, unknown>; botId?: string; at?: number } = {}) =>
  logDecision({ signalId: extra.signalId ?? null, botId: extra.botId ?? NDX_BOT_ID, outcome, reason, detail: extra.detail, now: extra.at ?? t });
const all = () => notificationsStore.all().sort((a, b) => a.createdAt - b.createdAt);

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(NDX_BOT_ID);
  t = BASE_NOW;
});

describe("which events raise a notification", () => {
  const ERRORS: DecisionOutcome[] = ["close_rejected", "close_timeout", "close_partial_fill", "open_rejected", "open_timeout_no_fill", "executor_error", "error_failsafe", "run_interrupted", "config_error", "invalid_strikes", "webhook_text_mismatch"];

  it("every kind of failure raises an error: a failed or rejected close, an open that was rejected or never filled, an unsafe account, a mismatch", () => {
    ERRORS.forEach((o, i) => raise(o, `trouble ${i}`));
    expect(all().map((n) => [n.outcome, n.severity])).toEqual(ERRORS.map((o) => [o, "error"]));
  });

  it("errors are raised even when the bot's own error-alert switch is off and warnings and trades are switched off", () => {
    botsStore.update(NDX_BOT_ID, { alerts: { open: false, close: false, warning: false, error: false } });
    updateAppSettings({ notifications: { trades: false, warnings: false } });
    raise("close_rejected", "Closing order rejected");
    raise("opened", "Opened");
    raise("no_live_price", "No price");
    expect(all().map((n) => n.severity)).toEqual(["error"]);
  });

  it("a broker mismatch found by the broker check raises an error for the bot", () => {
    ensureBotRecord(NDX_BOT_ID);
    flagMismatches({ checkedAt: t, ok: false, expectedLegs: 2, brokerLegs: 0, problems: [{ kind: "missing_at_broker", symbol: "NDXP261006P20970000", expected: 1, actual: 0, botId: NDX_BOT_ID, text: "NDXP261006P20970000: we show 1 but the broker holds none." }] });
    expect(all().map((n) => [n.severity, n.outcome])).toEqual([["error", "executor_error"]]);
    expect(all()[0].message).toContain("Broker position mismatch");
  });

  it("warnings are on to begin with and trades are off; each follows its tick box", () => {
    raise("no_live_price", "No live price");
    raise("opened", "Opened a position");
    expect(all().map((n) => n.severity)).toEqual(["warning"]);

    updateAppSettings({ notifications: { trades: true, warnings: false } });
    raise("closed", "Closed a position");
    raise("price_out_of_range", "Out of range");
    expect(all().map((n) => n.severity)).toEqual(["warning", "trade"]);
  });

  it("opening and closing are both trades", () => {
    updateAppSettings({ notifications: { trades: true } });
    raise("opened", "o", { signalId: "s1" });
    raise("closed", "c", { signalId: "s1" });
    raise("exit_closed", "x", { signalId: "s2" });
    expect(all().map((n) => n.severity)).toEqual(["trade", "trade", "trade"]);
  });

  it("routine skips raise nothing", () => {
    for (const o of ["already_in_position", "bot_off", "outside_hours", "trigger_off", "dry_run", "entry_retry"] as DecisionOutcome[]) raise(o, "routine");
    expect(all()).toHaveLength(0);
  });

  it("a notification failing never breaks the call that raised it", () => {
    const spy = vi.spyOn(notificationsStore, "insert").mockImplementation(() => {
      throw new Error("storage hiccup");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => raise("close_rejected")).not.toThrow();
    expect(decisionsStore.all()).toHaveLength(1); // the decision itself was still logged
    spy.mockRestore();
    err.mockRestore();
  });
});

describe("what a notification says", () => {
  it("the message is the decision's own words, without the bot's name in front, and cut when very long", () => {
    raise("close_rejected", "NDX Bias Bot: Closing order rejected: Insufficient margin");
    raise("open_rejected", `${"word ".repeat(100)}`, { at: t + 5 * MIN });
    const [a, b] = all();
    expect(a.message).toBe("Closing order rejected: Insufficient margin");
    expect(b.message.length).toBeLessThanOrEqual(240);
    expect(b.message.endsWith("…")).toBe(true);
  });

  it("links to the bot's positions when a position is concerned, and to its Log otherwise", () => {
    raise("close_rejected", "with position", { detail: { positionId: "pos-7" } });
    raise("executor_error", "no position", { at: t + 5 * MIN });
    const [a, b] = all();
    expect(a).toMatchObject({ positionId: "pos-7", link: "/automation/bots/ndx_ema_bias?tab=positions" });
    expect(b).toMatchObject({ link: "/automation/bots/ndx_ema_bias?tab=log" });
    expect(b.positionId).toBeUndefined();
    expect(linkFor("a b/c", undefined)).toBe("/automation/bots/a%20b%2Fc?tab=log"); // never a link that leaves the app
  });

  it("starts unread, with the bot, the time and the outcome", () => {
    raise("close_rejected", "x");
    expect(all()[0]).toMatchObject({ botId: NDX_BOT_ID, createdAt: t, readAt: null, repeats: 1, outcome: "close_rejected" });
    expect(listNotifications().notifications[0]).toMatchObject({ botName: "NDX Bias Bot", read: false, severity: "error", link: expect.stringContaining("/automation/bots/") });
  });
});

describe("the same alert is listed once", () => {
  it("an error that comes in again inside the quiet window is counted, not listed again, and stays as read or unread as it was", () => {
    raise("close_rejected", "Closing order rejected");
    markAllRead(t);
    raise("close_rejected", "Closing order rejected", { at: t + 10 * MIN });
    raise("close_rejected", "Closing order rejected", { at: t + 20 * MIN });
    expect(all()).toHaveLength(1);
    expect(all()[0]).toMatchObject({ repeats: 3, lastSeenAt: t + 20 * MIN, createdAt: t });
    expect(all()[0].readAt).not.toBeNull();
    expect(listNotifications().unread).toBe(0);
  });

  it("after the quiet window the same error is listed again; a different message, outcome or bot is a different alert", () => {
    raise("close_rejected", "Closing order rejected");
    raise("close_rejected", "Closing order rejected", { at: t + QUIET_WINDOW_MS + MIN });
    raise("close_rejected", "A different reason", { at: t + QUIET_WINDOW_MS + 2 * MIN });
    raise("close_timeout", "Closing order rejected", { at: t + QUIET_WINDOW_MS + 3 * MIN });
    expect(all()).toHaveLength(4);
  });

  it("the window runs from the LAST time it came in, so a steady loop of one error stays one entry", () => {
    for (let i = 0; i < 12; i++) raise("executor_error", "Lost track of order ib-1", { at: t + i * 30 * MIN });
    expect(all()).toHaveLength(1);
    expect(all()[0].repeats).toBe(12);
  });

  it("an error that belongs to a different signal each time (a retry loop) is still one error", () => {
    raise("open_rejected", "Rejected by the broker", { signalId: "sig-1" });
    raise("open_rejected", "Rejected by the broker", { signalId: "sig-2", at: t + MIN });
    raise("open_rejected", "Rejected by the broker", { signalId: "sig-3", at: t + 2 * MIN });
    expect(all()).toHaveLength(1);
    expect(all()[0].repeats).toBe(3);
  });

  it("two trades with the same words are two trades when they belong to different signals, and one when it is the same signal", () => {
    updateAppSettings({ notifications: { trades: true } });
    raise("opened", "Opened short put spread 20970/20960", { signalId: "sig-1" });
    raise("opened", "Opened short put spread 20970/20960", { signalId: "sig-2", at: t + 5 * MIN });
    raise("opened", "Opened short put spread 20970/20960", { signalId: "sig-2", at: t + 6 * MIN });
    expect(all()).toHaveLength(2);
    expect(all()[1].repeats).toBe(2);
  });
});

describe("only the latest 200 are kept", () => {
  it("210 different alerts leave the newest 200", () => {
    for (let i = 0; i < NOTIFICATION_CAP + 10; i++) raise("executor_error", `Error number ${i}`, { at: t + i * MIN });
    expect(all()).toHaveLength(NOTIFICATION_CAP);
    const messages = all().map((n) => n.message);
    expect(messages).not.toContain("Error number 0");
    expect(messages).not.toContain("Error number 9");
    expect(messages).toContain("Error number 10");
    expect(messages).toContain(`Error number ${NOTIFICATION_CAP + 9}`);
  });

  it("the cap is for each person: another person's list is not trimmed by this one's", () => {
    // A notification belongs to whoever owns its bot: this bot is the other person's.
    runAs("other-person", () => {
      ensureBotRecord(TEST_BOT_ID);
      raise("executor_error", "someone else's", { botId: TEST_BOT_ID });
    });
    for (let i = 0; i < NOTIFICATION_CAP + 5; i++) raise("executor_error", `Error ${i}`, { at: t + i * MIN });
    expect(runAs(ownerUserId(), () => notificationsStore.all())).toHaveLength(NOTIFICATION_CAP);
    expect(runAs("other-person", () => notificationsStore.all())).toHaveLength(1);
  });
});

describe("the list", () => {
  it("is newest first, at most 50, and says how many are unread and how many there are in all", () => {
    for (let i = 0; i < 60; i++) raise("executor_error", `Error ${i}`, { at: t + i * MIN });
    markRead([all()[59].id, all()[58].id]);
    const list = listNotifications();
    expect(list.notifications).toHaveLength(LIST_LIMIT);
    expect(list.notifications[0].message).toBe("Error 59");
    expect(list.notifications[0].read).toBe(true);
    expect(list.notifications[2].read).toBe(false);
    expect(list).toMatchObject({ unread: 58, total: 60 });
  });

  it("a person sees only their own", () => {
    raise("executor_error", "mine");
    expect(listNotifications().total).toBe(1);
    expect(runAs("other-person", () => listNotifications().total)).toBe(0);
    expect(runAs("other-person", () => markAllRead())).toBe(0);
    expect(runAs("other-person", () => clearNotifications())).toBe(0);
    expect(listNotifications().total).toBe(1);
  });
});

describe("mark as read, mark all as read, and clear", () => {
  beforeEach(() => {
    for (let i = 0; i < 4; i++) raise("executor_error", `Error ${i}`, { at: t + i * MIN });
  });

  it("marks the ones asked for, once, and ignores ids that are unknown or already read", () => {
    const [a, b] = all();
    expect(markRead([a.id, a.id, "no-such-id"], t + 10 * MIN)).toBe(1);
    expect(notificationsStore.get(a.id)?.readAt).toBe(t + 10 * MIN);
    expect(markRead([a.id, b.id], t + 20 * MIN)).toBe(1);
    expect(notificationsStore.get(a.id)?.readAt).toBe(t + 10 * MIN); // not overwritten
    expect(listNotifications().unread).toBe(2);
  });

  it("marks everything read", () => {
    expect(markAllRead()).toBe(4);
    expect(listNotifications()).toMatchObject({ unread: 0, total: 4 });
    expect(markAllRead()).toBe(0);
  });

  it("clears the ones asked for, or everything", () => {
    const [a, b] = all();
    expect(clearNotifications([a.id, "no-such-id"])).toBe(1);
    expect(listNotifications().total).toBe(3);
    expect(notificationsStore.get(b.id)).toBeDefined();
    expect(clearNotifications()).toBe(3);
    expect(listNotifications()).toMatchObject({ total: 0, unread: 0, notifications: [] });
  });

  it("clearing an empty list is fine, and a new alert after a clear is listed as new", () => {
    clearNotifications();
    expect(clearNotifications()).toBe(0);
    raise("executor_error", "Error 0", { at: t + 90 * MIN });
    expect(listNotifications()).toMatchObject({ total: 1, unread: 1 });
  });
});

describe("through the real engine", () => {
  const fast = { closeConfirmTimeoutMs: 100, orderFillTimeoutMs: 100, pollIntervalMs: 5 };
  const alert = (direction: "bullish" | "bearish", barTime: string, now = BASE_NOW) => receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 21_003.7, barTime, interval: "5", raw: { symbol: "NDX" }, now });

  it("an open the broker rejects raises an error that says why, with a link to the Log", async () => {
    const broker = new MockExecutor();
    broker.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "Insufficient margin" });
    await processSignal(alert("bullish", "b1"), { executor: broker, now: BASE_NOW, ...fast });
    expect(all().map((n) => [n.severity, n.outcome])).toEqual([["error", "open_rejected"]]);
    expect(all()[0].message).toContain("Insufficient margin");
    expect(all()[0].signalId).not.toBeNull();
    expect(all()[0].link).toContain("tab=");
  });

  it("an open that never fills raises an error", async () => {
    const broker = new MockExecutor();
    broker.queueScenario(NDX_BOT_ID, { kind: "never" });
    await processSignal(alert("bullish", "b1"), { executor: broker, now: BASE_NOW, ...fast });
    expect(all().map((n) => n.outcome)).toEqual(["open_timeout_no_fill"]);
  });

  it("an order that cannot even be sent raises an error, and a flip whose close fails raises one for the close", async () => {
    const broker = new MockExecutor();
    broker.queueScenario(NDX_BOT_ID, { kind: "throw", message: "connection dropped" });
    await processSignal(alert("bullish", "b1"), { executor: broker, now: BASE_NOW, ...fast });
    expect(all().map((n) => [n.severity, n.outcome])).toEqual([["error", "executor_error"]]);
    expect(all()[0].message).toContain("connection dropped");
    expect(all()[0].positionId).toBe(decisionsStore.all().find((d) => d.outcome === "executor_error")?.detail.positionId);
    expect(all()[0].link).toContain("tab=positions");
  });

  it("a normal open and flip raises nothing by default, and a trade notification for each when trades are ticked", async () => {
    const broker = new MockExecutor();
    await processSignal(alert("bullish", "b1"), { executor: broker, now: BASE_NOW, ...fast });
    await processSignal(alert("bearish", "b2", BASE_NOW + 5 * MIN), { executor: broker, now: BASE_NOW + 5 * MIN, ...fast });
    expect(all()).toHaveLength(0);

    updateAppSettings({ notifications: { trades: true } });
    await processSignal(alert("bullish", "b3", BASE_NOW + 10 * MIN), { executor: broker, now: BASE_NOW + 10 * MIN, ...fast });
    expect(all().map((n) => [n.severity, n.outcome])).toEqual([["trade", "closed"], ["trade", "opened"]]);
  });

  it("a safeguard stop raises a warning by default", async () => {
    const broker = new MockExecutor();
    await processSignal(receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: "bullish", price: 5_000, barTime: "low", interval: "5", raw: { symbol: "NDX" }, now: BASE_NOW }), { executor: broker, now: BASE_NOW, ...fast });
    expect(all().map((n) => [n.severity, n.outcome])).toEqual([["warning", "price_out_of_range"]]);
  });
});
