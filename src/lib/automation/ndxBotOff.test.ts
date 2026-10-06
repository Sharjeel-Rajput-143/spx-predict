import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as killRoute } from "@/app/api/automation/bots/[id]/kill/route";
import { alertsStore, botsStore, decisionsStore, ordersStore, positionsStore, runsStore } from "./store";
import { ensureBotRecord, updateBot } from "./bots";
import { manualClose, manualOpen, processSignal, receiveAndSaveSignal } from "./engine";
import { countTodayErrors, recordError } from "./errors";
import { __resetSweepState, sweepBot } from "./eodSweep";
import { MockExecutor } from "./executor";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import type { Position, SignalDirection } from "./types";

// "Always On" in Option Alpha (a webhook trigger that runs even when the bot's automations are off) is copied only
// for closes here. Bot off, by a person or tripped by a limit or the 10-error failsafe: a webhook may close the
// opposite position and may never open. The kill switch stops every webhook run, closes included. The end-of-day
// sweep and the Close position button are never blocked by either. NDX bot only; mock executor only.

setTestBotEnv();
setNdxTestEnv();

let executor: MockExecutor;
const fast = { closeConfirmTimeoutMs: 60, orderFillTimeoutMs: 60, pollIntervalMs: 4, ladderStepMs: 20 };
let seq = 0;

function emit(direction: SignalDirection, opts: { now?: number; dryRun?: boolean } = {}) {
  const now = opts.now ?? BASE_NOW;
  const signal = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 21_003.7, barTime: `bar-${direction}-${now}-${seq++}`, interval: "5", raw: { symbol: "NDX" }, now });
  return processSignal(signal, { executor, now, ...fast, ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}) });
}

const outcomes = () => decisionsStore.all().filter((d) => d.botId === NDX_BOT_ID).map((d) => d.outcome);
const reasons = () => decisionsStore.all().map((d) => d.reason);
const bot = () => botsStore.get(NDX_BOT_ID)!;
const put = (over: Partial<Position> = {}) =>
  buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", type: "short_put_spread", status: "open", shortStrike: 21_000, longStrike: 20_990, requestedQuantity: 1, filledQuantity: 1, credit: 3.5, ...over });
const call = (over: Partial<Position> = {}) => put({ type: "short_call_spread", shortStrike: 21_100, longStrike: 21_110, ...over });
const botOff = () => botsStore.update(NDX_BOT_ID, { enabled: false });
const killOn = () => botsStore.update(NDX_BOT_ID, { killSwitch: true });
const at = (h: number, m: number) => Date.UTC(2026, 9, 6, h + 4, m);
const closes = () => executor.placedOrders.filter((o) => o.kind === "close");
const opens = () => executor.placedOrders.filter((o) => o.kind === "open");

beforeEach(() => {
  resetAutomationStores();
  __resetSweepState();
  setNdxTestEnv();
  executor = new MockExecutor();
  ensureBotRecord(NDX_BOT_ID);
});
afterEach(() => vi.unstubAllEnvs());

describe("bot off: a webhook may still close, and may never open", () => {
  it("bullish with the bot off and a call spread held: the call spread is closed, no put spread is opened", async () => {
    positionsStore.insert(call({ id: "held" }));
    botOff();
    await emit("bullish");

    expect(outcomes()).toEqual(["bot_off_close_only", "closed", "automations_off"]);
    expect(closes()).toHaveLength(1);
    expect(opens()).toHaveLength(0);
    expect(positionsStore.get("held")?.status).toBe("closed");
    expect(positionsStore.all()).toHaveLength(1); // no new position
  });

  it("the Bearish direction is the mirror: a put spread held is closed, no call spread is opened", async () => {
    positionsStore.insert(put({ id: "held" }));
    botOff();
    await emit("bearish");
    expect(outcomes()).toEqual(["bot_off_close_only", "closed", "automations_off"]);
    expect(closes()).toHaveLength(1);
    expect(opens()).toHaveLength(0);
    expect(positionsStore.get("held")?.status).toBe("closed");
    expect(positionsStore.all()).toHaveLength(1);
  });

  it("a same-side signal with the bot off does nothing: nothing closed, nothing opened, the position is untouched", async () => {
    positionsStore.insert(put({ id: "held" }));
    botOff();
    await emit("bullish");
    expect(outcomes()).toEqual(["automations_off"]);
    expect(decisionsStore.all()[0].reason).toContain("Bot off");
    expect(decisionsStore.all()[0].reason).toContain("nothing to close");
    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.get("held")?.status).toBe("open");
  });

  it("same side, bearish mirror: a held call spread and a bearish signal with the bot off does nothing", async () => {
    positionsStore.insert(call({ id: "held" }));
    botOff();
    await emit("bearish");
    expect(outcomes()).toEqual(["automations_off"]);
    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.get("held")?.status).toBe("open");
  });

  it("nothing held and the bot off: nothing happens", async () => {
    botOff();
    await emit("bullish");
    expect(outcomes()).toEqual(["automations_off"]);
    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.all()).toHaveLength(0);
  });

  it("a limit that tripped the bot off: the next opposite signal closes and does not open", async () => {
    updateBot(NDX_BOT_ID, { safeguards: { allocationLimit: 600 } });
    await emit("bullish"); // would risk $650 against $600: the allocation limit switches the bot off
    expect(outcomes()).toEqual(["allocation_limit_reached"]);
    expect(bot().enabled).toBe(false);

    positionsStore.insert(call({ id: "held" })); // a position is held when the next signal arrives
    await emit("bullish", { now: BASE_NOW + 300_000 });
    expect(outcomes().slice(1)).toEqual(["bot_off_close_only", "closed", "automations_off"]);
    expect(closes()).toHaveLength(1);
    expect(opens()).toHaveLength(0);
    expect(positionsStore.get("held")?.status).toBe("closed");
  });

  it("the 10-error failsafe tripped the bot off: the next opposite signal closes and does not open", async () => {
    positionsStore.insert(put({ id: "held" }));
    for (let i = 0; i < 10; i++) recordError(NDX_BOT_ID, "open_failed", { i }, BASE_NOW + i);
    expect(bot().enabled).toBe(false);

    await emit("bearish", { now: BASE_NOW + 300_000 });
    expect(outcomes().filter((o) => o !== "error_failsafe")).toEqual(["bot_off_close_only", "closed", "automations_off"]);
    expect(closes()).toHaveLength(1);
    expect(opens()).toHaveLength(0);
  });

  it("the logs and the run trace say why: 'bot off, close only', then the Open step blocked for 'bot off'", async () => {
    positionsStore.insert(call({ id: "held" }));
    botOff();
    await emit("bullish");

    const [closeOnly, , blocked] = decisionsStore.all();
    expect(closeOnly.reason).toContain("Bot off, close only");
    expect(blocked.reason).toContain("Bot off: the Open step is blocked");
    expect(blocked.detail).toMatchObject({ botOff: true });

    const nodes = runsStore.all()[0].nodes;
    expect(nodes.find((n) => n.kind === "decision" && n.text === "Bot is switched on")).toMatchObject({ result: false, measured: "Bot is off - this run may close, never open" });
    expect(nodes.find((n) => n.kind === "decision" && n.text === "Bot is switched on (the Open step)")).toMatchObject({ result: false, measured: "Bot off: the Open step is blocked" });
    expect(nodes.some((n) => n.kind === "action" && n.action === "close")).toBe(true);
    expect(nodes.some((n) => n.kind === "action" && n.action === "open")).toBe(false);
  });

  it("the hours guard still applies to the close: outside the window, nothing is closed", async () => {
    positionsStore.insert(call({ id: "held" }));
    botOff();
    await emit("bullish", { now: at(17, 0) });
    expect(outcomes()).toEqual(["outside_hours"]);
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("a failed close counts as an error, stops the run, and is never retried automatically", async () => {
    positionsStore.insert(call({ id: "held" }));
    botOff();
    executor.queueScenario(NDX_BOT_ID, { kind: "never" });
    await emit("bullish");

    expect(outcomes()).toEqual(["bot_off_close_only", "close_timeout"]); // the run stopped here: no "Open step blocked" row, no open
    expect(countTodayErrors(NDX_BOT_ID, BASE_NOW)).toBe(1);
    expect(bot().needsAttention).toBe(true);
    expect(positionsStore.get("held")?.status).toBe("closing");
    expect(closes()).toHaveLength(1);

    // The next signal does not send a second close for that position.
    await emit("bullish", { now: BASE_NOW + 300_000 });
    expect(closes()).toHaveLength(1);
    expect(outcomes().at(-1)).toBe("close_in_flight");
    expect(opens()).toHaveLength(0);
  });

  it("dry run with the bot off: 'would close', the Open step blocked, no order, nothing changed", async () => {
    positionsStore.insert(call({ id: "held" }));
    botOff();
    await emit("bullish", { dryRun: true });
    expect(outcomes()).toEqual(["bot_off_close_only", "dry_run", "automations_off"]);
    expect(reasons()[1]).toContain("would close");
    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.get("held")?.status).toBe("open");
  });

  it("a position placed by hand also respects the switch: with the bot off, nothing is opened", async () => {
    botOff();
    const result = await manualOpen(NDX_BOT_ID, { type: "short_put_spread", shortStrike: 20_970 }, { executor, now: BASE_NOW, ...fast });
    expect(result).toMatchObject({ ok: false, outcome: "automations_off" });
    expect(executor.placedOrders).toHaveLength(0);
  });
});

describe("kill switch: stops every webhook run completely", () => {
  it("blocks the close and the open: an opposite signal does nothing", async () => {
    positionsStore.insert(call({ id: "held" }));
    killOn();
    await emit("bullish");
    expect(outcomes()).toEqual(["kill_switch"]);
    expect(decisionsStore.all()[0].reason).toContain("Kill switch is on");
    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.get("held")?.status).toBe("open");
    expect(runsStore.all()[0].nodes).toEqual([{ kind: "decision", text: "Kill switch is off", result: false, measured: "Kill switch is on - nothing runs" }]);
  });

  it("blocks a same-side signal and the Bearish mirror too", async () => {
    positionsStore.insert(put({ id: "held" }));
    killOn();
    await emit("bullish");
    await emit("bearish", { now: BASE_NOW + 300_000 });
    expect(outcomes()).toEqual(["kill_switch", "kill_switch"]);
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("wins over the bot switch: with the bot off as well, still nothing is closed", async () => {
    positionsStore.insert(call({ id: "held" }));
    botOff();
    killOn();
    await emit("bullish");
    expect(outcomes()).toEqual(["kill_switch"]);
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("with the kill switch on and the bot on, nothing opens either", async () => {
    killOn();
    await emit("bullish");
    expect(outcomes()).toEqual(["kill_switch"]);
    expect(positionsStore.all()).toHaveLength(0);
  });

  it("turning it off lets the next signal through", async () => {
    killOn();
    await emit("bullish");
    botsStore.update(NDX_BOT_ID, { killSwitch: false });
    await emit("bullish", { now: BASE_NOW + 300_000 });
    expect(outcomes()).toEqual(["kill_switch", "opened"]);
  });

  it("a manual open respects it", async () => {
    killOn();
    const result = await manualOpen(NDX_BOT_ID, { type: "short_put_spread", shortStrike: 20_970 }, { executor, now: BASE_NOW, ...fast });
    expect(result).toMatchObject({ ok: false, outcome: "kill_switch" });
    expect(executor.placedOrders).toHaveLength(0);
  });

  it("the switch is toggled through the API, by a person", async () => {
    const toggle = () => killRoute(new NextRequest(`http://localhost/api/automation/bots/${NDX_BOT_ID}/kill`, { method: "POST" }), { params: Promise.resolve({ id: NDX_BOT_ID }) });
    expect((await (await toggle()).json()).bot.killSwitch).toBe(true);
    expect(bot().killSwitch).toBe(true);
    expect((await (await toggle()).json()).bot.killSwitch).toBe(false);
    const unknown = await killRoute(new NextRequest("http://localhost/api/automation/bots/nope/kill", { method: "POST" }), { params: Promise.resolve({ id: "nope" }) });
    expect(unknown.status).toBe(404);
  });
});

describe("the sweep and Close position are never blocked by the switches", () => {
  const priced = { underlyingPrice: () => 21_100 };

  it("the end-of-day sweep runs with the kill switch on, and with the bot off", async () => {
    positionsStore.insert(put({ id: "a" }));
    killOn();
    botOff();
    const r = await sweepBot(NDX_BOT_ID, at(16, 5), priced);
    expect(r).toMatchObject({ swept: 1, estimated: 1 });
    expect(positionsStore.get("a")).toMatchObject({ status: "expired", settlement: { kind: "estimated" } });
  });

  it("the market-close sweep sends its close order with the kill switch on", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_EOD_SWEEP_MODE", "market");
    positionsStore.insert(put({ id: "a" }));
    killOn();
    const r = await sweepBot(NDX_BOT_ID, at(16, 5), { executor, closeConfirmTimeoutMs: 40, pollIntervalMs: 4, underlyingPrice: () => 21_000 });
    expect(r).toMatchObject({ closedAtMarket: 1 });
    expect(closes()).toHaveLength(1);
  });

  it("Close position works with the kill switch on, and with the bot off", async () => {
    positionsStore.insert(put({ id: "a" }));
    positionsStore.insert(call({ id: "b" }));
    killOn();
    botOff();
    expect(await manualClose("a", { executor, now: BASE_NOW, ...fast })).toMatchObject({ ok: true, outcome: "closed" });
    expect(await manualClose("b", { executor, now: BASE_NOW, ...fast })).toMatchObject({ ok: true, outcome: "closed" });
    expect(positionsStore.get("a")?.status).toBe("closed");
    expect(positionsStore.get("b")?.status).toBe("closed");
    expect(alertsStore.all().every((a) => a.kind !== "error")).toBe(true);
    expect(ordersStore.all()).toHaveLength(2);
  });
});
