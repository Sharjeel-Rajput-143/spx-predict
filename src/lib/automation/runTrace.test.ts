import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateBot } from "./bots";
import { manualClose, manualOpen, processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import { describeLegs } from "./runTrace";
import { botsStore, decisionsStore, positionsStore, runsStore } from "./store";
import { describeTradingTime, describeWindow } from "./tradingHours";
import { BASE_NOW, TEST_BOT_ID, buildPosition, resetAutomationStores, setTestBotEnv } from "./testSupport";
import type { SignalDirection, TraceAction, TraceDecision } from "./types";

setTestBotEnv();

let executor: MockExecutor;
const fast = { closeConfirmTimeoutMs: 50, orderFillTimeoutMs: 50, pollIntervalMs: 5 };

function emit(direction: SignalDirection, opts: { now?: number; barTime?: string; price?: number; raw?: unknown } = {}) {
  const now = opts.now ?? BASE_NOW;
  const signal = receiveAndSaveSignal({ botId: TEST_BOT_ID, signal: direction, price: opts.price ?? 7720, barTime: opts.barTime ?? `bar-${now}`, interval: "5", raw: opts.raw ?? {}, now });
  return processSignal(signal, { executor, now, ...fast }).then(() => signal);
}

const runOf = (signalId: string) => runsStore.get(signalId)!;
const decisions = (id: string) => runOf(id).nodes.filter((n): n is TraceDecision => n.kind === "decision");
const actions = (id: string) => runOf(id).nodes.filter((n): n is TraceAction => n.kind === "action");

beforeEach(() => {
  resetAutomationStores();
  executor = new MockExecutor();
});

describe("a flip is recorded step by step with the real values compared", () => {
  it("walks the checks in order, with a Close card then an Open card", async () => {
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "open", shortStrike: 7720, longStrike: 7725 }));
    const signal = await emit("bullish", { price: 7720.5 });
    const run = runOf(signal.id);

    expect(run).toMatchObject({ botId: TEST_BOT_ID, signalId: signal.id, source: "webhook", automation: "Bullish signal", trigger: "TradingView" });
    expect(run.nodes.map((n) => (n.kind === "decision" ? `? ${n.text}` : `> ${n.title}`))).toEqual([
      "? Bot is switched on",
      "? Current market time is between 9:35am - 3:55pm",
      "? Price is a positive number",
      "? Signal isn't a duplicate",
      "? Bot has exactly or more than 1 position with Short Call Spread type and any status",
      "? The position isn't already closing",
      "> Close Position (SPX, Short Call Spread)",
      "? Bot holds fewer than 1 Short Put Spread position",
      "? Bot has fewer than 1 open position",
      "? Bot opened fewer than 10 new positions today",
      "? The strikes use the price when the call arrived",
      "? Strikes pass the checks (order, not equal, on the increment, the right width)",
      "? Opening stays within the $20,000 allocation",
      "? No leg collides with an existing position",
      "? The price is at least the minimum credit of $0.55",
      "> Open SPX Short Put Spread",
    ]);
    // Every decision passed, and each kept the value behind it.
    const byText = Object.fromEntries(decisions(signal.id).map((d) => [d.text, d]));
    expect(decisions(signal.id).every((d) => d.result)).toBe(true);
    expect(byText["Current market time is between 9:35am - 3:55pm"].measured).toBe("Current time is 10:40am");
    expect(byText["Bot has exactly or more than 1 position with Short Call Spread type and any status"].measured).toBe("1 position");
    expect(byText["Bot holds fewer than 1 Short Put Spread position"].measured).toBe("0 positions");
    expect(byText["Strikes pass the checks (order, not equal, on the increment, the right width)"].measured).toBe("Target 7,700.5 (7,720.5 - 20), rounded down to 5 -> short 7,700, long 7,695");
  });

  it("the action cards carry the exact legs, the position they made, and a frozen snapshot of their settings", async () => {
    positionsStore.insert(buildPosition({ id: "old-call", type: "short_call_spread", status: "open", shortStrike: 7720, longStrike: 7725 }));
    const signal = await emit("bullish", { price: 7720.5 });
    const [close, open] = actions(signal.id);

    expect(close).toMatchObject({ action: "close", positionId: "old-call", outcome: "closed", summary: "SPX Short Call Spread Oct 6 / -7,720 call, +7,725 call" });
    expect(close.params).toEqual([
      { label: "Price", value: "100% of bid/ask (no limit price is sent yet)" },
      { label: "Quantity", value: "3 contracts (100% of position)" },
      { label: "Confirm timeout", value: "0s" }, // the test's 50ms timeout, rounded
    ]);

    const opened = positionsStore.query((p) => p.type === "short_put_spread")[0];
    expect(open).toMatchObject({ action: "open", positionId: opened.id, outcome: "opened", summary: "SPX Short Put Spread Oct 6 / -7,700 put, +7,695 put" });
    expect(open.params).toEqual(
      expect.arrayContaining([
        { label: "Price", value: "Limit credit $2.20 (100% of bid/ask)" },
        { label: "Quantity", value: "3 contracts" },
        { label: "Short put", value: "7700 (target 7,700.5 = 7720.5 - 20, rounded down to 5)" },
        { label: "Long put", value: "7695 (5 points below the short put)" },
      ]),
    );
  });
});

describe("a run that stops early records exactly the steps it reached", () => {
  it("outside hours: the clock check fails with the day and why", async () => {
    const saturday = Date.UTC(2026, 9, 10, 19, 0); // Sat Oct 10, 3:00pm ET
    const signal = await emit("bullish", { now: saturday });
    const nodes = decisions(signal.id);
    expect(nodes.map((n) => n.result)).toEqual([true, false]);
    expect(nodes[1]).toMatchObject({ text: "Current market time is between 9:35am - 3:55pm", measured: "Saturday 3:00pm - the market is closed on weekends" });
    expect(runOf(signal.id).nodes).toHaveLength(2);
  });

  it("kill switch: the first check fails and nothing else is recorded", async () => {
    botsStore.insert({ id: TEST_BOT_ID, enabled: false, needsAttention: false, needsAttentionReason: null, createdAt: 0 });
    const signal = await emit("bullish");
    expect(runOf(signal.id).nodes).toEqual([{ kind: "decision", text: "Bot is switched on", result: false, measured: "Bot is off" }]);
  });

  it("duplicate: says which earlier signal made it one", async () => {
    await emit("bullish", { barTime: "bar-1" });
    const second = await emit("bullish", { barTime: "bar-1", now: BASE_NOW + 2000 });
    const dup = decisions(second.id).find((d) => d.text === "Signal isn't a duplicate")!;
    expect(dup.result).toBe(false);
    expect(dup.measured).toMatch(/Same bar_time \(bar-1\) already processed/);
  });

  it("a switched-off trigger is recorded as its own check", async () => {
    botsStore.insert({ id: TEST_BOT_ID, enabled: true, needsAttention: false, needsAttentionReason: null, createdAt: 0 });
    updateBot(TEST_BOT_ID, { triggers: { bullish: false, bearish: true } });
    const signal = await emit("bullish");
    expect(decisions(signal.id).at(-1)).toMatchObject({ text: "The bullish trigger is switched on", result: false, measured: "Trigger is off" });
  });

  it("invalid strikes: the strike check fails with the reason and the numbers, and no open card is made", async () => {
    // A strike typed by hand that is off the 5-point grid is the one way bad strikes still reach the check.
    await manualOpen(TEST_BOT_ID, { type: "short_put_spread", shortStrike: 7702 }, { executor, now: BASE_NOW, ...fast });
    const run = runsStore.query((r) => r.source === "ui")[0];
    const strikes = run.nodes.find((n): n is TraceDecision => n.kind === "decision" && n.text.startsWith("Strikes pass"))!;
    expect(strikes.result).toBe(false);
    expect(strikes.measured).toMatch(/short 7702, long 7697/);
    expect(run.nodes.some((n) => n.kind === "action")).toBe(false);
  });

  it("a position limit shows the count that blocked it", async () => {
    positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open" }));
    const signal = await emit("bullish", { barTime: "b2" });
    const held = decisions(signal.id).find((d) => d.text.startsWith("Bot holds fewer than"))!;
    expect(held).toMatchObject({ result: false, measured: "1 position" });
  });

  it("a rejected close ends the run with the failed close card", async () => {
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "open" }));
    executor.queueScenario(TEST_BOT_ID, { kind: "reject", reason: "broker down" });
    const signal = await emit("bullish");
    const [close] = actions(signal.id);
    expect(close).toMatchObject({ outcome: "close_rejected", reason: "broker down" });
    expect(actions(signal.id)).toHaveLength(1); // never reached the open
  });

  it("the run is saved even when the executor throws partway", async () => {
    executor.queueScenario(TEST_BOT_ID, { kind: "throw", message: "connection reset" });
    const signal = await emit("bullish");
    const open = actions(signal.id).at(-1)!;
    expect(open).toMatchObject({ action: "open", outcome: "executor_error" });
  });
});

describe("manual actions are runs too", () => {
  it("a manual position records its checks and an Open card, and its decision points at the run", async () => {
    await manualOpen(TEST_BOT_ID, { type: "short_put_spread", shortStrike: 7700, underlyingPrice: 7721 }, { executor, now: BASE_NOW, ...fast });
    const run = runsStore.all()[0];
    expect(run).toMatchObject({ source: "ui", automation: "Manual position", trigger: "Manual action", signalId: null });
    expect(run.nodes.at(-1)).toMatchObject({ kind: "action", action: "open", outcome: "opened" });
    const open = run.nodes.at(-1) as TraceAction;
    expect(open.params).toContainEqual({ label: "Short put", value: "7700 (entered by hand)" });
    expect(decisionsStore.all()[0].detail.runId).toBe(run.id);
  });

  it("a manual position refused outside hours still records why", async () => {
    await manualOpen(TEST_BOT_ID, { type: "short_put_spread", shortStrike: 7700 }, { executor, now: Date.UTC(2026, 9, 10, 15, 0), ...fast });
    const run = runsStore.all()[0];
    expect(run.nodes).toEqual([{ kind: "decision", text: "Current market time is between 9:35am - 3:55pm", result: false, measured: "Saturday 11:00am - the market is closed on weekends" }]);
  });

  it("a manual close records the position check and a Close card", async () => {
    const pos = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open" }));
    await manualClose(pos.id, { executor, now: BASE_NOW, ...fast });
    const run = runsStore.all()[0];
    expect(run).toMatchObject({ automation: "Manual close", trigger: "Manual action" });
    expect(run.nodes[0]).toEqual({ kind: "decision", text: "Position is open", result: true, measured: "Status is open" });
    expect(run.nodes.at(-1)).toMatchObject({ kind: "action", action: "close", positionId: pos.id, outcome: "closed" });
  });

  it("a signal sent by 'Run automation' is labelled as a manual run", async () => {
    const signal = await emit("bearish", { raw: { source: "manual" } });
    expect(runOf(signal.id)).toMatchObject({ source: "manual", trigger: "Manual run", automation: "Bearish signal" });
  });
});

describe("an unexpected crash still leaves a decision row and a saved trace", () => {
  it("logs it, keeps the steps reached, and still throws to the caller", async () => {
    vi.spyOn(positionsStore, "insert").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const signal = receiveAndSaveSignal({ botId: TEST_BOT_ID, signal: "bullish", price: 7720, barTime: "b-crash", interval: "5", raw: {}, now: BASE_NOW });
    await expect(processSignal(signal, { executor, now: BASE_NOW, ...fast })).rejects.toThrow("disk full");
    vi.restoreAllMocks();

    const row = decisionsStore.query((d) => d.signalId === signal.id).at(-1)!;
    expect(row).toMatchObject({ outcome: "executor_error", reason: "Unexpected error: disk full" });
    const nodes = runsStore.get(signal.id)!.nodes;
    expect(nodes.length).toBeGreaterThan(3); // the checks it passed before the crash
    expect(nodes.at(-1)).toEqual({ kind: "decision", text: "Run finished without an unexpected error", result: false, measured: "disk full" });
  });
});

describe("wording helpers", () => {
  it("describes legs with the short leg negative and the long leg positive", () => {
    expect(describeLegs({ underlying: "SPX", type: "short_call_spread", expiry: "2026-10-02", shortStrike: 7720, longStrike: 7725 })).toBe("SPX Short Call Spread Oct 2 / -7,720 call, +7,725 call");
    expect(describeLegs({ underlying: "SPX", type: "short_put_spread", expiry: "2026-10-05", shortStrike: 7735, longStrike: 7730 })).toBe("SPX Short Put Spread Oct 5 / -7,735 put, +7,730 put");
  });

  it("formats the window and explains the time it saw", () => {
    expect(describeWindow()).toBe("9:35am - 3:55pm");
    expect(describeTradingTime(Date.UTC(2026, 9, 6, 13, 40))).toBe("Current time is 9:40am");
    expect(describeTradingTime(Date.UTC(2026, 9, 6, 12, 0))).toBe("Current time is 8:00am");
    expect(describeTradingTime(Date.UTC(2026, 10, 26, 17, 0))).toBe("Thursday 12:00pm - Thanksgiving Day, the market is closed");
    expect(describeTradingTime(Date.UTC(2026, 10, 27, 19, 0))).toBe("Current time is 2:00pm - early close day, the window ended 12:55pm");
  });
});
