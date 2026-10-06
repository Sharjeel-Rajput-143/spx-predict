import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertKindFor } from "./alerts";
import { ensureBotRecord, updateBot } from "./bots";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import { alertsStore, botsStore, decisionsStore, positionsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, TEST_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import { logDecision } from "./decisions";
import type { DecisionOutcome } from "./types";

setTestBotEnv();
setNdxTestEnv();

let executor: MockExecutor;
const fast = { closeConfirmTimeoutMs: 50, orderFillTimeoutMs: 50, pollIntervalMs: 5 };

function emit(botId: string, direction: "bullish" | "bearish", opts: { price?: number; barTime?: string; now?: number; symbol?: string } = {}) {
  const now = opts.now ?? BASE_NOW;
  const signal = receiveAndSaveSignal({ botId, signal: direction, price: opts.price ?? (botId === NDX_BOT_ID ? 21_003.7 : 7720), barTime: opts.barTime ?? `b-${direction}-${now}`, interval: "5", raw: { symbol: opts.symbol ?? (botId === NDX_BOT_ID ? "NDX" : "SPX") }, now });
  return processSignal(signal, { executor, now, ...fast });
}
const outcomesOf = () => decisionsStore.all().map((d) => d.outcome);
const kinds = (bot?: string) => alertsStore.query((a) => !bot || a.botId === bot).map((a) => a.kind);

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  executor = new MockExecutor();
});
afterEach(() => vi.unstubAllEnvs());

describe("which outcomes raise an alert", () => {
  it.each<[DecisionOutcome, string | null]>([
    ["opened", "open"],
    ["closed", "close"],
    ["executor_error", "error"],
    ["open_rejected", "error"],
    ["close_timeout", "error"],
    ["config_error", "error"],
    ["symbol_mismatch", "warning"],
    ["price_out_of_range", "warning"],
    ["daily_limit_reached", "warning"],
    ["allocation_limit_reached", "warning"],
    ["automations_off", null], // routine
    ["outside_hours", null],
    ["already_in_position", null],
    ["duplicate_signal", null],
    ["dry_run", null],
  ])("%s -> %s", (outcome, kind) => {
    expect(alertKindFor(outcome)).toBe(kind);
  });
});

describe("alerts from real runs", () => {
  it("an open and a flip raise Opened, then Closed + Opened", async () => {
    await emit(NDX_BOT_ID, "bullish");
    await emit(NDX_BOT_ID, "bearish", { barTime: "b2", now: BASE_NOW + 200_000 });
    expect(kinds()).toEqual(["open", "close", "open"]);
    expect(alertsStore.all()[0]).toMatchObject({ botId: NDX_BOT_ID, outcome: "opened", email: "off" });
    expect(alertsStore.all()[0].message).toMatch(/^NDX Bias Bot: Opened new position/);
  });

  it("a safeguard stopping a signal is a warning; a wrong-chart signal too", async () => {
    await emit(NDX_BOT_ID, "bullish", { symbol: "SPX" });
    await emit(NDX_BOT_ID, "bullish", { price: 7720, barTime: "r" });
    expect(kinds()).toEqual(["warning", "warning"]);
  });

  it("an executor failure is an error", async () => {
    executor.queueScenario(NDX_BOT_ID, { kind: "throw", message: "connection reset" });
    await emit(NDX_BOT_ID, "bullish");
    expect(kinds()).toEqual(["error"]);
    expect(alertsStore.all()[0].message).toMatch(/connection reset/);
  });

  it("routine skips raise nothing: bot off, and outside hours", async () => {
    ensureBotRecord(NDX_BOT_ID);
    botsStore.update(NDX_BOT_ID, { enabled: false });
    await emit(NDX_BOT_ID, "bullish", { barTime: "off" });
    botsStore.update(NDX_BOT_ID, { enabled: true });
    await emit(NDX_BOT_ID, "bearish", { barTime: "sat", now: Date.UTC(2026, 9, 10, 19, 0) }); // a Saturday
    expect(outcomesOf()).toEqual(["automations_off", "outside_hours"]);
    expect(kinds()).toEqual([]);
  });

  it("routine skips raise nothing: the same side already held", async () => {
    await emit(NDX_BOT_ID, "bullish", { barTime: "o1" });
    await emit(NDX_BOT_ID, "bullish", { barTime: "o2", now: BASE_NOW + 200_000 });
    expect(outcomesOf()).toEqual(["opened", "already_in_position"]);
    expect(kinds()).toEqual(["open"]); // only the opening
  });

  it("routine skips raise nothing: a dry run", async () => {
    const signal = receiveAndSaveSignal({ botId: TEST_BOT_ID, signal: "bullish", price: 7720, barTime: "dry", interval: "5", raw: { symbol: "SPX" }, now: BASE_NOW });
    await processSignal(signal, { executor, now: BASE_NOW, dryRun: true, ...fast });
    expect(outcomesOf()).toEqual(["dry_run"]);
    expect(kinds()).toEqual([]);
  });

  it("each bot's alert toggles decide: switch 'open' off and an opening raises none, closes still do", async () => {
    ensureBotRecord(NDX_BOT_ID);
    updateBot(NDX_BOT_ID, { alerts: { open: false, close: true, warning: true, error: true } });
    await emit(NDX_BOT_ID, "bullish");
    await emit(NDX_BOT_ID, "bearish", { barTime: "b2", now: BASE_NOW + 200_000 });
    expect(kinds()).toEqual(["close"]);
  });

  it("one bot's alerts are its own", async () => {
    await emit(NDX_BOT_ID, "bullish");
    await emit(TEST_BOT_ID, "bullish");
    expect(kinds(NDX_BOT_ID)).toEqual(["open"]);
    expect(kinds(TEST_BOT_ID)).toEqual(["open"]);
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "open" })); // no alert for a seeded row
    expect(alertsStore.all()).toHaveLength(2);
  });
});

describe("email is optional and off by default", () => {
  it("off: alerts are on the status page only", async () => {
    vi.stubEnv("ALERT_EMAIL_ENABLED", "");
    vi.stubEnv("ALERT_EMAIL_TO", "owner@example.invalid");
    await emit(NDX_BOT_ID, "bullish");
    expect(alertsStore.all().map((a) => a.email)).toEqual(["off"]);
  });

  it("on without a recipient is still off", async () => {
    vi.stubEnv("ALERT_EMAIL_ENABLED", "true");
    vi.stubEnv("ALERT_EMAIL_TO", "");
    await emit(NDX_BOT_ID, "bullish");
    expect(alertsStore.all().map((a) => a.email)).toEqual(["off"]);
  });

  it("on with a recipient: each alert is queued - and nothing is sent (no sender is wired)", async () => {
    vi.stubEnv("ALERT_EMAIL_ENABLED", "true");
    vi.stubEnv("ALERT_EMAIL_TO", "owner@example.invalid");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await emit(NDX_BOT_ID, "bullish");
    expect(alertsStore.all().map((a) => a.email)).toEqual(["queued"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("logging a decision directly", () => {
  it("raises the alert from the decision's own words and time", () => {
    logDecision({ signalId: "s1", botId: NDX_BOT_ID, outcome: "close_rejected", reason: "Rejected by broker", now: 1234 });
    expect(alertsStore.all()[0]).toMatchObject({ kind: "error", signalId: "s1", createdAt: 1234, outcome: "close_rejected" });
  });
});
