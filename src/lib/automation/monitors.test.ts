import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorCloseEditor, monitorNodeEditor } from "@/components/automation/builder/LiveNodeEditors";
import { monitorFlow } from "@/components/automation/builder/builtin";
import { alertsStore, botsStore, decisionsStore, errorsStore, ordersStore, positionsStore, runsStore } from "./store";
import { ensureBotRecord, updateBot } from "./bots";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { countTodayErrors } from "./errors";
import { __resetSweepState } from "./eodSweep";
import { MockExecutor } from "./executor";
import { latestConfirmedSignal, runCloseMonitor, runDueMonitors } from "./monitors";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import type { Position, SignalDirection } from "./types";

// The Bullish Close Monitor: a sweep for a short call spread that is against the latest confirmed signal. Off by default;
// it must never fight the flip. NDX bot only, mock executor only.

setTestBotEnv();
setNdxTestEnv();

let executor: MockExecutor;
const fast = { closeConfirmTimeoutMs: 60, orderFillTimeoutMs: 60, pollIntervalMs: 4, ladderStepMs: 20 };
const opts = () => ({ executor, closeConfirmTimeoutMs: 60, pollIntervalMs: 4, ladderStepMs: 20 });
let seq = 0;

/** A signal the engine really processed (a position is held; the flip may or may not act). */
async function signal(direction: SignalDirection, at = BASE_NOW) {
  const s = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 21_003.7, barTime: `b-${direction}-${at}-${seq++}`, interval: "5", raw: { symbol: "NDX" }, now: at });
  await processSignal(s, { executor, now: at, ...fast });
  return s;
}
const call = (over: Partial<Position> = {}) =>
  buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", type: "short_call_spread", status: "open", shortStrike: 21_100, longStrike: 21_110, requestedQuantity: 1, filledQuantity: 1, credit: 3.5, ...over });
const put = (over: Partial<Position> = {}) => call({ type: "short_put_spread", shortStrike: 21_000, longStrike: 20_990, ...over });
const monitorOn = (extra: Record<string, unknown> = {}) => updateBot(NDX_BOT_ID, { monitors: { bullishClose: { enabled: true, ...extra } } });
const bot = () => botsStore.get(NDX_BOT_ID)!;
const outcomes = () => decisionsStore.all().map((d) => d.outcome);
const closes = () => executor.placedOrders.filter((o) => o.kind === "close");
const at = (h: number, m: number) => Date.UTC(2026, 9, 6, h + 4, m);

/** A wrong-side position under a latest confirmed bullish signal, as a failed or skipped flip would leave it. The signal is
 * recorded as processed (a decision row), without letting the flip close the position first. */
function bullishConfirmedWithCallHeld() {
  const s = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: "bullish", price: 21_003.7, barTime: `b-${seq++}`, interval: "5", raw: { symbol: "NDX" }, now: BASE_NOW - 60_000 });
  decisionsStore.insert({ id: `d-${s.id}`, signalId: s.id, botId: NDX_BOT_ID, outcome: "already_in_position", reason: "test", detail: {}, createdAt: BASE_NOW - 59_000 });
  positionsStore.insert(call({ id: "wrong" }));
  return s;
}

beforeEach(() => {
  resetAutomationStores();
  __resetSweepState();
  setNdxTestEnv();
  executor = new MockExecutor();
  ensureBotRecord(NDX_BOT_ID);
});
afterEach(() => vi.unstubAllEnvs());

describe("off by default", () => {
  it("does nothing until a person switches it on", async () => {
    bullishConfirmedWithCallHeld();
    expect(bot().monitors).toBeUndefined();
    expect(await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts())).toMatchObject({ skipped: "off" });
    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.get("wrong")?.status).toBe("open");
  });

  it("is switched on and off through the bot's settings, and the memo and tags are kept", () => {
    monitorOn({ memo: " close the wrong side ", tags: ["monitor", "monitor", " bullish "] });
    expect(bot().monitors?.bullishClose).toEqual({ enabled: true, memo: "close the wrong side", tags: ["monitor", "bullish"] });
    updateBot(NDX_BOT_ID, { monitors: { bullishClose: { enabled: false } } });
    expect(bot().monitors?.bullishClose).toEqual({ enabled: false, memo: "close the wrong side", tags: ["monitor", "bullish"] });
  });
});

describe("when it acts", () => {
  it("closes a short call spread that is against the latest confirmed signal (bullish), and logs why", async () => {
    const s = bullishConfirmedWithCallHeld();
    monitorOn();
    const r = await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts());
    expect(r).toMatchObject({ closed: 1, failed: 0 });
    expect(closes()).toHaveLength(1);
    expect(positionsStore.get("wrong")).toMatchObject({ status: "closed", closeSignalId: s.id });
    const row = decisionsStore.all().at(-1)!;
    expect(row.outcome).toBe("monitor_closed");
    expect(row.reason).toContain("Bullish Close Monitor closed");
    expect(row.reason).toContain("against the latest confirmed signal (bullish");
    expect(alertsStore.all().some((a) => a.kind === "close" && a.outcome === "monitor_closed")).toBe(true);
  });

  it("leaves a run trace: the checks with their values, then the Close Position card", async () => {
    bullishConfirmedWithCallHeld();
    monitorOn();
    await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts());
    const run = runsStore.all()[0];
    expect(run).toMatchObject({ source: "monitor", automation: "Bullish Close Monitor", trigger: "Monitor" });
    expect(run.nodes.map((n) => (n.kind === "decision" ? `? ${n.text}` : `> ${n.title}`))).toEqual([
      "? Bot is switched on",
      expect.stringContaining("Current market time is between"),
      "? The latest confirmed signal is bullish",
      "? Bot has exactly or more than 1 position with Short Call Spread type and any status",
      "> Close Position (NDX, Short Call Spread)",
    ]);
  });

  it("writes its memo and tags on the position it closes", async () => {
    bullishConfirmedWithCallHeld();
    monitorOn({ memo: "wrong side", tags: ["monitor"] });
    await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts());
    expect(positionsStore.get("wrong")).toMatchObject({ notes: "wrong side", tags: ["monitor"] });
  });

  it("the scheduler's tick runs every enabled monitor", async () => {
    bullishConfirmedWithCallHeld();
    monitorOn();
    const results = await runDueMonitors(BASE_NOW, opts());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ key: "bullishClose", closed: 1 });
  });
});

describe("it never fights the flip", () => {
  it("never closes the side the latest signal wants: a bearish signal opened a call spread, the Bullish monitor leaves it alone", async () => {
    monitorOn();
    await signal("bearish"); // opens a short call spread
    expect(positionsStore.all().filter((p) => p.type === "short_call_spread" && p.status === "open")).toHaveLength(1);
    expect(await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW + 1000, opts())).toMatchObject({ skipped: "correct_side" });
    expect(closes()).toHaveLength(0);
  });

  it("a flip in either direction and a monitor pass in between: exactly the flip's closes, never an extra one", async () => {
    monitorOn();
    await signal("bearish", BASE_NOW);
    await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW + 1000, opts());
    await signal("bullish", BASE_NOW + 200_000); // the flip closes the call spread, opens a put spread
    await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW + 201_000, opts());
    expect(closes()).toHaveLength(1); // the flip's own
    expect(outcomes()).not.toContain("monitor_closed");
  });

  it("with no confirmed signal at all it can't say what is wrong, so it does nothing", async () => {
    monitorOn();
    positionsStore.insert(call());
    expect(await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts())).toMatchObject({ skipped: "no_confirmed_signal" });
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("a signal that was received but not acted on is not 'confirmed': the monitor looks back past it", async () => {
    // The real latest signal that counts is bearish; a later bullish one was a duplicate / outside hours / trigger off.
    await signal("bearish", BASE_NOW - 300_000);
    for (const outcome of ["duplicate_signal", "outside_hours", "trigger_disabled", "symbol_mismatch", "price_out_of_range", "automations_off", "kill_switch"] as const) {
      const s = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: "bullish", price: 21_000, barTime: `x-${outcome}`, interval: "5", raw: {}, now: BASE_NOW - 1000 });
      decisionsStore.insert({ id: `d-${outcome}`, signalId: s.id, botId: NDX_BOT_ID, outcome, reason: "", detail: {}, createdAt: BASE_NOW });
    }
    expect(latestConfirmedSignal(NDX_BOT_ID)?.signal).toBe("bearish");
    monitorOn();
    expect(await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts())).toMatchObject({ skipped: "correct_side" });
  });

  it("a signal still being processed (no decision yet) is unknown, not confirmed", () => {
    receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: "bullish", price: 21_000, barTime: "pending", interval: "5", raw: {}, now: BASE_NOW });
    expect(latestConfirmedSignal(NDX_BOT_ID)).toBeNull();
  });

  it("only looks at the wrong type: a put spread under a bullish signal is the right side", async () => {
    const s = bullishConfirmedWithCallHeld();
    positionsStore.remove("wrong");
    positionsStore.insert(put({ id: "right" }));
    monitorOn();
    expect(s.signal).toBe("bullish");
    expect(await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts())).toMatchObject({ skipped: "nothing_to_check" });
    expect(closes()).toHaveLength(0);
  });
});

describe("one close per position, and only the bot's own", () => {
  it("never a second close: a position that is already closing is left alone", async () => {
    bullishConfirmedWithCallHeld();
    positionsStore.update("wrong", { status: "closing" });
    monitorOn();
    expect(await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts())).toMatchObject({ skipped: "nothing_to_check" });
    expect(closes()).toHaveLength(0);
  });

  it("never a second close: one with a close order still working is left alone", async () => {
    bullishConfirmedWithCallHeld();
    ordersStore.insert({ id: "o1", positionId: "wrong", kind: "close", status: "working", limitPrice: 0, filledQuantity: 0, ref: "x", createdAt: BASE_NOW, updatedAt: BASE_NOW });
    monitorOn();
    expect((await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts())).skipped).toBe("nothing_to_check");
    expect(closes()).toHaveLength(0);
  });

  it("a position placed by hand is not touched", async () => {
    bullishConfirmedWithCallHeld();
    positionsStore.update("wrong", { manual: true });
    monitorOn();
    expect((await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts())).skipped).toBe("nothing_to_check");
    expect(closes()).toHaveLength(0);
  });

  it("a failed close is an error: it flags the bot, counts toward the failsafe, stops there, and is never retried", async () => {
    bullishConfirmedWithCallHeld();
    monitorOn();
    executor.queueScenario(NDX_BOT_ID, { kind: "never" });
    const r = await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts());
    expect(r).toMatchObject({ closed: 0, failed: 1 });
    expect(countTodayErrors(NDX_BOT_ID, BASE_NOW)).toBe(1);
    expect(errorsStore.all()[0].detail).toMatchObject({ monitor: "bullishClose" });
    expect(bot()).toMatchObject({ needsAttention: true });
    expect(bot().needsAttentionReason).toContain("Bullish Close Monitor");
    expect(positionsStore.get("wrong")?.status).toBe("closing");
    // the next look finds it closing and sends nothing
    await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW + 60_000, opts());
    expect(closes()).toHaveLength(1);
  });
});

describe("the switches and the clock", () => {
  it.each([
    ["the kill switch is on", () => botsStore.update(NDX_BOT_ID, { killSwitch: true }), "kill_switch"],
    ["the bot is off", () => botsStore.update(NDX_BOT_ID, { enabled: false }), "bot_off"],
  ] as const)("does nothing when %s", async (_why, set, skipped) => {
    bullishConfirmedWithCallHeld();
    monitorOn();
    set();
    expect(await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts())).toMatchObject({ skipped });
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("only runs inside the bot's trading window, on a trading day", async () => {
    bullishConfirmedWithCallHeld();
    monitorOn();
    expect((await runCloseMonitor(NDX_BOT_ID, "bullishClose", at(16, 0), opts())).skipped).toBe("outside_hours");
    expect((await runCloseMonitor(NDX_BOT_ID, "bullishClose", at(9, 0), opts())).skipped).toBe("outside_hours");
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("dry run says 'would close' and sends nothing", async () => {
    bullishConfirmedWithCallHeld();
    monitorOn();
    const r = await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, { ...opts(), dryRun: true });
    expect(r).toMatchObject({ wouldClose: 1, closed: 0 });
    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.get("wrong")?.status).toBe("open");
    expect(decisionsStore.all().at(-1)?.reason).toContain("would close");
  });

  it("is quiet when there is nothing to do: no log row, no run", async () => {
    monitorOn();
    await runCloseMonitor(NDX_BOT_ID, "bullishClose", BASE_NOW, opts());
    expect(decisionsStore.all()).toHaveLength(0);
    expect(runsStore.all()).toHaveLength(0);
  });

  it("the end-of-day sweep and Close position don't depend on it", async () => {
    const { sweepBot } = await import("./eodSweep");
    positionsStore.insert(call({ id: "a" }));
    monitorOn();
    botsStore.update(NDX_BOT_ID, { killSwitch: true });
    const r = await sweepBot(NDX_BOT_ID, at(16, 5), { underlyingPrice: () => 21_000 });
    expect(r.swept).toBe(1);
    expect(positionsStore.get("a")?.status).toBe("expired");
  });
});

describe("the Bearish Close Monitor is the mirror", () => {
  const bearishOn = () => updateBot(NDX_BOT_ID, { monitors: { bearishClose: { enabled: true } } });

  function bearishConfirmedWithPutHeld() {
    const s = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: "bearish", price: 21_003.7, barTime: `bb-${seq++}`, interval: "5", raw: { symbol: "NDX" }, now: BASE_NOW - 60_000 });
    decisionsStore.insert({ id: `d-${s.id}`, signalId: s.id, botId: NDX_BOT_ID, outcome: "already_in_position", reason: "test", detail: {}, createdAt: BASE_NOW - 59_000 });
    positionsStore.insert(put({ id: "wrong-put" }));
  }

  it("is off by default and independent of the Bullish one", async () => {
    bearishConfirmedWithPutHeld();
    expect(await runCloseMonitor(NDX_BOT_ID, "bearishClose", BASE_NOW, opts())).toMatchObject({ skipped: "off" });
    monitorOn(); // the Bullish one on does not switch the Bearish one on
    expect(bot().monitors?.bearishClose).toBeUndefined();
    expect(await runCloseMonitor(NDX_BOT_ID, "bearishClose", BASE_NOW, opts())).toMatchObject({ skipped: "off" });
  });

  it("closes a short put spread that is against the latest confirmed signal (bearish)", async () => {
    bearishConfirmedWithPutHeld();
    bearishOn();
    expect(await runCloseMonitor(NDX_BOT_ID, "bearishClose", BASE_NOW, opts())).toMatchObject({ closed: 1 });
    expect(positionsStore.get("wrong-put")?.status).toBe("closed");
    const row = decisionsStore.all().at(-1)!;
    expect(row.outcome).toBe("monitor_closed");
    expect(row.reason).toContain("Bearish Close Monitor closed");
    expect(runsStore.all()[0]).toMatchObject({ automation: "Bearish Close Monitor", source: "monitor" });
  });

  it("never closes the side the latest signal wants: a bullish signal opened a put spread, the Bearish monitor leaves it alone", async () => {
    bearishOn();
    await signal("bullish");
    expect(await runCloseMonitor(NDX_BOT_ID, "bearishClose", BASE_NOW + 1000, opts())).toMatchObject({ skipped: "correct_side" });
    expect(closes()).toHaveLength(0);
  });

  it("with both monitors on, a flip in either direction is still exactly the flip's own close", async () => {
    monitorOn();
    bearishOn();
    await signal("bearish", BASE_NOW);
    await runDueMonitors(BASE_NOW + 1000, opts());
    await signal("bullish", BASE_NOW + 200_000);
    await runDueMonitors(BASE_NOW + 201_000, opts());
    await signal("bearish", BASE_NOW + 400_000);
    await runDueMonitors(BASE_NOW + 401_000, opts());
    expect(closes()).toHaveLength(2); // the two flips' closes, nothing extra
    expect(outcomes()).not.toContain("monitor_closed");
  });

  it("its flow is the position check on a short put spread, the bearish guard, then Close Position", () => {
    const first = monitorFlow("bearish", null)[0];
    expect(first.conditions?.[0]).toMatchObject({ templateId: "bot_has_type", values: expect.objectContaining({ type: "Short put spread" }) });
    expect(first.yes?.[0].conditions?.[0]).toMatchObject({ templateId: "bot_latest_signal", values: { signal: "bearish" } });
    expect(first.yes?.[0].yes?.[0]).toMatchObject({ kind: "close_position", config: expect.objectContaining({ type: "short_put_spread" }) });
  });

  it("its Close Position form says Short Put Spread and saves its own memo and tags", () => {
    const ctx = { data: { config: { underlying: "NDX", closePricePercent: 100 }, bot: { monitors: { bearishClose: { enabled: false, memo: "p" } } } }, patch: async () => true } as never;
    const out = renderToStaticMarkup(createElement(MonitorCloseEditor, { monitor: "bearishClose", ctx, onClose: () => undefined }));
    expect(out).toContain("Position (NDX, Short Put Spread)");
    expect(out).toContain(">p</textarea>");
  });
});

describe("the flow on the canvas", () => {
  it("is Option Alpha's position check, then the confirmed-signal guard, then Close Position", () => {
    const steps = monitorFlow("bullish", null);
    expect(steps).toHaveLength(1);
    const first = steps[0];
    expect(first.kind).toBe("decision");
    expect(first.conditions?.[0]).toMatchObject({ templateId: "bot_has_type", values: expect.objectContaining({ type: "Short call spread" }) });
    const second = first.yes?.[0];
    expect(second?.conditions?.[0]).toMatchObject({ templateId: "bot_latest_signal", values: { signal: "bullish" } });
    expect(second?.yes?.[0].kind).toBe("close_position");
    expect(second?.yes?.[0].config).toMatchObject({ type: "short_call_spread", qty: "100% of position" });
  });

  it("its Close Position form has Position, Price, Quantity, Memo, Tags and Options, and Save", () => {
    const ctx = {
      data: { config: { underlying: "NDX", closePricePercent: 100 }, bot: { monitors: { bullishClose: { enabled: true, memo: "m", tags: ["a", "b"] } } } },
      patch: async () => true,
    } as never;
    const out = renderToStaticMarkup(createElement(MonitorCloseEditor, { monitor: "bullishClose", ctx, onClose: () => undefined }));
    for (const t of ["Close Position", "Position (NDX, Short Call Spread)", "100% of bid/ask", "100% of position", "Memo", "Tags", "Added immediately after the trade is filled", "Options", "Discard expiring OTM long leg(s) with no bid price", "Save"]) {
      expect(out, t).toContain(t);
    }
    expect(out).toContain(">m</textarea>");
    expect(out).toContain('value="a, b"');
    expect(monitorNodeEditor({ step: { kind: "decision" } as never, monitor: "bullishClose", ctx, onClose: () => undefined })).toBeNull();
  });
});
