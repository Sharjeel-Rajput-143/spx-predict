import { beforeEach, describe, expect, it } from "vitest";
import { __registerBotForTests, getBotStaticConfig } from "./bots";
import { MockExecutor } from "./executor";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { botsStore, decisionsStore, errorsStore, ordersStore, positionsStore } from "./store";
import { BASE_NOW, TEST_BOT_ID, buildPosition, resetAutomationStores, setTestBotEnv } from "./testSupport";
import type { SignalDirection } from "./types";

setTestBotEnv();

let executor: MockExecutor;

function emit(direction: SignalDirection, opts: { price?: number; barTime?: string; now?: number } = {}) {
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
  return processSignal(signal, {
    executor,
    now,
    closeConfirmTimeoutMs: 50,
    orderFillTimeoutMs: 50,
    pollIntervalMs: 5,
  });
}

function botPositions() {
  return positionsStore.query((p) => p.botId === TEST_BOT_ID);
}

beforeEach(() => {
  resetAutomationStores();
  executor = new MockExecutor();
});

describe("processSignal - close failures block the flip", () => {
  it("#11 a rejected close leaves the new side unopened and flags needs_attention", async () => {
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "open" }));
    executor.queueScenario(TEST_BOT_ID, { kind: "reject", reason: "broker down" });

    await emit("bullish");

    const positions = botPositions();
    // Stays "closing" (still active, still blocking a new entry) rather than
    // reverting to "open" - a rejected close needs an operator to resolve it.
    expect(positions.find((p) => p.type === "short_call_spread")?.status).toBe("closing");
    expect(positions.find((p) => p.type === "short_put_spread")).toBeUndefined(); // never opened
    expect(botsStore.get(TEST_BOT_ID)?.needsAttention).toBe(true);
    expect(errorsStore.query((e) => e.botId === TEST_BOT_ID)).toHaveLength(1);
  });

  it("#11 a close that never fills times out, leaves the new side unopened, flags needs_attention", async () => {
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "open" }));
    executor.queueScenario(TEST_BOT_ID, { kind: "never" });

    await emit("bullish");

    const positions = botPositions();
    expect(positions.find((p) => p.type === "short_call_spread")?.status).toBe("closing");
    expect(positions.find((p) => p.type === "short_put_spread")).toBeUndefined();
    expect(botsStore.get(TEST_BOT_ID)?.needsAttention).toBe(true);
  });

  it("#11 a close that only partially fills leaves the new side unopened, flags needs_attention", async () => {
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "open", requestedQuantity: 3, filledQuantity: 3 }));
    executor.queueScenario(TEST_BOT_ID, { kind: "partial", firstFillRatio: 1 / 3, remainderDelayMs: null });

    await emit("bullish");

    const positions = botPositions();
    expect(positions.find((p) => p.type === "short_call_spread")?.status).toBe("closing");
    expect(positions.find((p) => p.type === "short_put_spread")).toBeUndefined();
    expect(botsStore.get(TEST_BOT_ID)?.needsAttention).toBe(true);
  });
});

describe("processSignal - partial fill on open", () => {
  it("#13 the open timeout cancels the remainder and the position opens at the partially filled size", async () => {
    executor.queueScenario(TEST_BOT_ID, { kind: "partial", firstFillRatio: 2 / 3, remainderDelayMs: null });

    await emit("bullish");

    const position = botPositions()[0];
    expect(position.status).toBe("open");
    expect(position.filledQuantity).toBe(2);
    expect(position.requestedQuantity).toBe(3);
  });

  it("#13 a partial fill resets the timeout so a later fill before it elapses still completes", async () => {
    // First fill arrives at 20ms (partial), remainder fills 20ms after that -
    // both comfortably inside the 50ms close/open timeout *from when each
    // arrives*, which only works if the timeout resets on the partial.
    executor.queueScenario(TEST_BOT_ID, { kind: "partial", firstFillRatio: 1 / 3, delayMs: 20, remainderDelayMs: 20 });

    await emit("bullish");

    const position = botPositions()[0];
    expect(position.status).toBe("open");
    expect(position.filledQuantity).toBe(3);
  });
});

describe("processSignal - in-flight close guard", () => {
  it("#14 sends nothing new when a close order for the position is already in flight", async () => {
    const position = positionsStore.insert(buildPosition({ type: "short_call_spread", status: "closing" }));
    ordersStore.insert({
      id: "ord-in-flight",
      positionId: position.id,
      kind: "close",
      status: "working",
      limitPrice: 0,
      filledQuantity: 0,
      ref: "mock-existing",
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
    });

    await emit("bullish");

    // No new close order should have been placed - the only order row is the
    // pre-existing one, untouched.
    const orders = ordersStore.query((o) => o.positionId === position.id);
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe("ord-in-flight");
    expect(positionsStore.get(position.id)?.status).toBe("closing");
  });
});

describe("processSignal - overlap", () => {
  it("#15 rejects a new position whose legs collide with an active position in another bot on the same account", async () => {
    const SHADOW_BOT_ID = "spx_ema_bias_shadow";
    __registerBotForTests(SHADOW_BOT_ID, () => ({
      ...getBotStaticConfig(TEST_BOT_ID),
      id: SHADOW_BOT_ID,
      name: "Shadow bot (same account)",
    }));

    // A bullish 7720 signal computes short_put_spread 7700/7695 (offset -20,
    // width 5). Seed exactly that under the shadow bot, same account.
    positionsStore.insert(
      buildPosition({
        botId: SHADOW_BOT_ID,
        type: "short_put_spread",
        status: "open",
        shortStrike: 7700,
        longStrike: 7695,
      }),
    );

    await emit("bullish");

    expect(botPositions()).toHaveLength(0);
    const decisions = decisionsStore.query((d) => d.botId === TEST_BOT_ID);
    expect(decisions.some((d) => d.outcome === "overlapping_strikes")).toBe(true);
  });
});
