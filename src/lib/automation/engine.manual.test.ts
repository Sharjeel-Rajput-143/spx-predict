import { beforeEach, describe, expect, it } from "vitest";
import { MockExecutor, simulatedCloseDebit } from "./executor";
import { manualClose, manualOpen, processSignal, receiveAndSaveSignal } from "./engine";
import { botsStore, decisionsStore, errorsStore, positionsStore } from "./store";
import { BASE_NOW, TEST_BOT_ID, buildPosition, resetAutomationStores, setTestBotEnv } from "./testSupport";
import { createEmptyBot, updateBot } from "./bots";
import type { SignalDirection } from "./types";

setTestBotEnv();

let executor: MockExecutor;
const fast = { closeConfirmTimeoutMs: 50, orderFillTimeoutMs: 50, pollIntervalMs: 5 };

function emit(direction: SignalDirection, opts: { now?: number; barTime?: string; price?: number } = {}) {
  const now = opts.now ?? BASE_NOW;
  const signal = receiveAndSaveSignal({
    botId: TEST_BOT_ID,
    signal: direction,
    price: opts.price ?? 7720,
    barTime: opts.barTime ?? `bar-${now}`,
    interval: "5",
    raw: {},
    now,
  });
  return processSignal(signal, { executor, now, ...fast });
}
const outcomes = () => decisionsStore.all().map((d) => d.outcome);

beforeEach(() => {
  resetAutomationStores();
  executor = new MockExecutor();
});

describe("per-trigger switches", () => {
  it("logs trigger_disabled for a switched-off direction and still acts on the other", async () => {
    botsStore.insert({ id: TEST_BOT_ID, enabled: true, needsAttention: false, needsAttentionReason: null, createdAt: 0 });
    updateBot(TEST_BOT_ID, { triggers: { bullish: false, bearish: true } });
    await emit("bullish", { barTime: "b1" });
    await emit("bearish", { barTime: "b2", now: BASE_NOW + 130_000 });
    expect(outcomes()).toEqual(["trigger_disabled", "opened"]);
    expect(executor.placedOrders.map((o) => o.positionType)).toEqual(["short_call_spread"]);
  });
});

describe("per-bot safeguards", () => {
  it("uses the bot's own daily limit and honours a reset", async () => {
    updateBot(TEST_BOT_ID, { safeguards: { dailyNewPositionLimit: 1 } });
    await emit("bullish", { barTime: "b1" });
    await emit("bearish", { barTime: "b2", now: BASE_NOW + 130_000 }); // closes the put, then hits the limit
    expect(outcomes()).toEqual(["opened", "closed", "daily_limit_reached"]);

    // The limit switched the bot off; a person checks it, resets the counter and switches it back on.
    expect(botsStore.get(TEST_BOT_ID)?.enabled).toBe(false);
    botsStore.update(TEST_BOT_ID, { dailyResetAt: BASE_NOW + 140_000, enabled: true, needsAttention: false, needsAttentionReason: null });
    await emit("bearish", { barTime: "b3", now: BASE_NOW + 300_000 });
    expect(outcomes().at(-1)).toBe("opened");
  });
});

describe("close price capture", () => {
  it("records no close price when the executor reports none (so P/L stays unknown)", async () => {
    await emit("bullish", { barTime: "b1" });
    await emit("bearish", { barTime: "b2", now: BASE_NOW + 130_000 });
    const put = positionsStore.query((p) => p.type === "short_put_spread")[0];
    expect(put.status).toBe("closed");
    expect(put.closePrice ?? null).toBeNull();
    expect(put.underlyingAtOpen).toBe(7720);
    expect(put.underlyingAtClose).toBe(7720);
  });

  it("records the close debit the executor reports", async () => {
    await emit("bullish", { barTime: "b1" });
    executor.queueScenario(TEST_BOT_ID, { kind: "instant", averagePrice: 1.85 });
    await emit("bearish", { barTime: "b2", now: BASE_NOW + 130_000 });
    expect(positionsStore.query((p) => p.type === "short_put_spread")[0].closePrice).toBe(1.85);
  });

  it("simulated pricing is deterministic and stays inside the spread width", async () => {
    const sim = new MockExecutor({ simulatePricing: true });
    const p = buildPosition({ type: "short_put_spread", status: "open", credit: 2.2, id: "pos-fixed" });
    const debit = simulatedCloseDebit(p);
    expect(simulatedCloseDebit(p)).toBe(debit);
    expect(debit).toBeGreaterThan(0);
    expect(debit).toBeLessThan(5);
    const { ref } = await sim.placeCloseOrder(p);
    await new Promise((r) => setTimeout(r, 10)); // the mock fills on the next tick
    expect((await sim.getOrder(ref)).averagePrice).toBe(debit);
  });
});

describe("manual open", () => {
  it("opens at the given short strike, long derived from the width, through the same guards", async () => {
    const result = await manualOpen(TEST_BOT_ID, { type: "short_put_spread", shortStrike: 7700, underlyingPrice: 7721 }, { executor, now: BASE_NOW, ...fast });
    expect(result).toMatchObject({ ok: true, outcome: "opened" });
    const pos = positionsStore.all()[0];
    expect(pos).toMatchObject({ shortStrike: 7700, longStrike: 7695, manual: true, status: "open", openSignalId: null });
    expect(decisionsStore.all()[0]).toMatchObject({ signalId: null, outcome: "opened", detail: expect.objectContaining({ manual: true }) });
  });

  it("is blocked by the hours guard and by the position limit", async () => {
    const outside = await manualOpen(TEST_BOT_ID, { type: "short_put_spread", shortStrike: 7700 }, { executor, now: Date.UTC(2026, 9, 10, 15, 0), ...fast });
    expect(outside.outcome).toBe("outside_hours");

    await manualOpen(TEST_BOT_ID, { type: "short_put_spread", shortStrike: 7700 }, { executor, now: BASE_NOW, ...fast });
    const second = await manualOpen(TEST_BOT_ID, { type: "short_put_spread", shortStrike: 7650 }, { executor, now: BASE_NOW, ...fast });
    expect(second).toMatchObject({ ok: false, outcome: "already_in_position" });
    expect(executor.placedOrders).toHaveLength(1);
  });

  it("rejects off-grid strikes without sending an order and flags the bot", async () => {
    const result = await manualOpen(TEST_BOT_ID, { type: "short_call_spread", shortStrike: 7703 }, { executor, now: BASE_NOW, ...fast });
    expect(result.outcome).toBe("invalid_strikes");
    expect(executor.placedOrders).toHaveLength(0);
    expect(botsStore.get(TEST_BOT_ID)?.needsAttention).toBe(true);
  });
});

describe("manual close", () => {
  it("closes the position through the executor and logs it", async () => {
    const pos = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open" }));
    const result = await manualClose(pos.id, { executor, now: BASE_NOW, underlyingPrice: 7733, ...fast });
    expect(result).toMatchObject({ ok: true, outcome: "closed" });
    expect(positionsStore.get(pos.id)).toMatchObject({ status: "closed", closeSignalId: null, underlyingAtClose: 7733 });
    expect(executor.placedOrders.map((o) => o.kind)).toEqual(["close"]);
  });

  it("a failed close flags the bot just like a failed flip", async () => {
    const pos = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open" }));
    executor.queueScenario(TEST_BOT_ID, { kind: "reject", reason: "broker down" });
    const result = await manualClose(pos.id, { executor, now: BASE_NOW, ...fast });
    expect(result).toMatchObject({ ok: false, outcome: "close_rejected" });
    expect(botsStore.get(TEST_BOT_ID)?.needsAttention).toBe(true);
    expect(errorsStore.all()).toHaveLength(1);
  });

  it("refuses to close something that isn't open", async () => {
    const pos = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "closed" }));
    await expect(manualClose(pos.id, { executor, now: BASE_NOW, ...fast })).rejects.toThrow(/closed/);
  });
});

describe("day trading switched off", () => {
  it("holds a same-day position to expiry instead of flipping it, and opens nothing", async () => {
    updateBot(TEST_BOT_ID, { safeguards: { dayTrading: false } });
    await emit("bullish", { barTime: "b1" });
    await emit("bearish", { barTime: "b2", now: BASE_NOW + 130_000 });

    expect(outcomes()).toEqual(["opened", "day_trading_blocked"]);
    expect(executor.placedOrders.map((o) => o.kind)).toEqual(["open"]); // no close, no second open
    expect(positionsStore.all().map((p) => p.status)).toEqual(["open"]);
    expect(botsStore.get(TEST_BOT_ID)?.needsAttention ?? false).toBe(false); // a deliberate skip is not an error
  });

  it("is unaffected when allowed (the default)", async () => {
    await emit("bullish", { barTime: "b1" });
    await emit("bearish", { barTime: "b2", now: BASE_NOW + 130_000 });
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
  });

  it("still lets a position carried from an earlier day be closed", async () => {
    updateBot(TEST_BOT_ID, { safeguards: { dayTrading: false } });
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "open", openedAt: BASE_NOW - 86_400_000, expiry: "2026-10-05" }));
    await emit("bullish", { barTime: "b1" });
    // The stale-position safety net expires yesterday's position, then the new side opens.
    expect(outcomes()).toEqual(["opened"]);
  });

  it("rejects a non-boolean setting", () => {
    expect(() => updateBot(TEST_BOT_ID, { safeguards: { dayTrading: "yes" as unknown as boolean } })).toThrow(/Day trading/);
  });
});

describe("a bot that is still waiting for its inputs doesn't break the others", () => {
  it("a signal, a manual open and a close still work with an empty bot on the same account", async () => {
    // The overlap check asks every bot for its account; an empty bot used to make that throw.
    const empty = createEmptyBot({ name: "Blank", accountId: "test-account", allocationLimit: 1000 });
    expect(empty.draftInputs?.accountId).toBe("test-account");

    await emit("bullish", { barTime: "b1" });
    expect(outcomes()).toEqual(["opened"]);

    const pos = positionsStore.all()[0];
    const closed = await manualClose(pos.id, { executor, now: BASE_NOW, ...fast });
    expect(closed.outcome).toBe("closed");

    const manual = await manualOpen(TEST_BOT_ID, { type: "short_call_spread", shortStrike: 7740 }, { executor, now: BASE_NOW, ...fast });
    expect(manual.outcome).toBe("opened");
  });
});
