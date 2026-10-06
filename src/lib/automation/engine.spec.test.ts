import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withBotLock } from "./botLock";
import { MockExecutor } from "./executor";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { botsStore, decisionsStore, errorsStore, positionsStore } from "./store";
import { BASE_NOW, TEST_BOT_ID, buildPosition, resetAutomationStores, setTestBotEnv } from "./testSupport";
import { ACTIVE_POSITION_STATUSES } from "./types";
import type { SignalDirection } from "./types";

// Spec tests 3, 5-8, 10 driven through the whole engine, asserting on what the
// MockExecutor actually received - not just on the rows the engine wrote.

setTestBotEnv();

let executor: MockExecutor;

function save(direction: SignalDirection, opts: { price?: number; barTime?: string; now?: number } = {}) {
  const now = opts.now ?? BASE_NOW;
  return receiveAndSaveSignal({
    botId: TEST_BOT_ID,
    signal: direction,
    price: opts.price ?? 7720,
    barTime: opts.barTime ?? `bar-${now}`,
    interval: "5",
    raw: {},
    now,
  });
}

function process(signal: ReturnType<typeof save>, now = signal.receivedAt) {
  return processSignal(signal, { executor, now, closeConfirmTimeoutMs: 50, orderFillTimeoutMs: 50, pollIntervalMs: 5 });
}

const emit = (direction: SignalDirection, opts: Parameters<typeof save>[1] = {}) => process(save(direction, opts));

const outcomes = () => decisionsStore.query((d) => d.botId === TEST_BOT_ID).map((d) => d.outcome);
const bot = () => botsStore.get(TEST_BOT_ID);

beforeEach(() => {
  resetAutomationStores();
  executor = new MockExecutor();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("flip order", () => {
  it("#3 sends the close to the executor before the open", async () => {
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "open" }));
    await emit("bullish");
    expect(executor.placedOrders.map((o) => `${o.kind}:${o.positionType}`)).toEqual([
      "close:short_call_spread",
      "open:short_put_spread",
    ]);
  });

  it("#4 sends the close to the executor before the open (bearish)", async () => {
    positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open" }));
    await emit("bearish");
    expect(executor.placedOrders.map((o) => `${o.kind}:${o.positionType}`)).toEqual([
      "close:short_put_spread",
      "open:short_call_spread",
    ]);
  });
});

describe("hours guard", () => {
  it.each([
    ["before 9:35 ET", Date.UTC(2026, 9, 6, 13, 34)],
    ["after 3:55 ET", Date.UTC(2026, 9, 6, 19, 56)],
    ["on a Saturday", Date.UTC(2026, 9, 10, 15, 0)],
    ["on a Sunday", Date.UTC(2026, 9, 11, 15, 0)],
  ])("#5 does nothing %s and logs outside_hours", async (_label, now) => {
    await emit("bullish", { now });
    expect(outcomes()).toEqual(["outside_hours"]);
    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.all()).toHaveLength(0);
  });
});

describe("dedupe", () => {
  it("#6 acts once when both copies of a double delivery are saved before either is processed", async () => {
    // This is how the webhook route behaves: persist on receipt, process later.
    const a = save("bullish", { barTime: "bar-1", now: BASE_NOW });
    const b = save("bullish", { barTime: "bar-1", now: BASE_NOW + 2000 });
    await Promise.all([withBotLock(TEST_BOT_ID, () => process(a)), withBotLock(TEST_BOT_ID, () => process(b))]);

    expect(executor.placedOrders).toHaveLength(1);
    expect(outcomes().sort()).toEqual(["duplicate_signal", "opened"]);
  });

  it("#6 acts once for two copies with different bar_time two seconds apart, saved up front", async () => {
    const a = save("bearish", { barTime: "bar-1", now: BASE_NOW });
    const b = save("bearish", { barTime: "bar-2", now: BASE_NOW + 2000 });
    await Promise.all([withBotLock(TEST_BOT_ID, () => process(a)), withBotLock(TEST_BOT_ID, () => process(b))]);

    expect(executor.placedOrders).toHaveLength(1);
    expect(outcomes().sort()).toEqual(["duplicate_signal", "opened"]);
  });
});

describe("concurrency", () => {
  it("#7 two opposite signals saved together run one after the other, in arrival order", async () => {
    const bull = save("bullish", { barTime: "bar-1", now: BASE_NOW });
    const bear = save("bearish", { barTime: "bar-2", now: BASE_NOW + 1 });
    await Promise.all([withBotLock(TEST_BOT_ID, () => process(bull)), withBotLock(TEST_BOT_ID, () => process(bear))]);

    expect(executor.placedOrders.map((o) => `${o.kind}:${o.positionType}`)).toEqual([
      "open:short_put_spread",
      "close:short_put_spread",
      "open:short_call_spread",
    ]);
    const active = positionsStore.query((p) => ACTIVE_POSITION_STATUSES.includes(p.status));
    expect(active.map((p) => p.type)).toEqual(["short_call_spread"]);
  });
});

describe("strike invariants through the engine", () => {
  it("#8 refuses a width that is not a multiple of the increment: config_error, nothing sent, needs_attention", async () => {
    // Width 3 against an increment of 5 can never produce a long strike on the grid.
    vi.stubEnv("BOT_SPX_EMA_BIAS_WIDTH_POINTS", "3");
    await emit("bullish", { price: 7720 });

    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.all()).toHaveLength(0);
    const decision = decisionsStore.query((d) => d.outcome === "config_error")[0];
    expect(decision.reason).toMatch(/width_not_multiple_of_increment/);
    expect(bot()?.needsAttention).toBe(true);
  });

  it.each([["0", "equal strikes"], ["-5", "a reversed put spread"]])("#8 refuses width %s (%s) without sending an order", async (width) => {
    vi.stubEnv("BOT_SPX_EMA_BIAS_WIDTH_POINTS", width);
    await emit("bearish");
    expect(executor.placedOrders).toHaveLength(0);
    expect(outcomes()).toEqual(["config_error"]);
  });

  it("opens with the long strike derived from the short strike, not the price (default rounding: out of the money)", async () => {
    await emit("bullish", { price: 7720.5 });
    await emit("bearish", { price: 7720.5, barTime: "bar-2", now: BASE_NOW + 130_000 });
    const [open1, , open2] = executor.placedOrders;
    expect([open1.shortStrike, open1.longStrike]).toEqual([7700, 7695]); // 7700.5 rounded DOWN, then width below
    expect([open2.shortStrike, open2.longStrike]).toEqual([7745, 7750]); // 7740.5 rounded UP, then width above
  });

  it("with nearest rounding the same signals land on the closest strikes", async () => {
    vi.stubEnv("BOT_SPX_EMA_BIAS_STRIKE_ROUNDING", "nearest");
    await emit("bullish", { price: 7720.5 });
    await emit("bearish", { price: 7720.5, barTime: "bar-2", now: BASE_NOW + 130_000 });
    const [open1, , open2] = executor.placedOrders;
    expect([open1.shortStrike, open1.longStrike]).toEqual([7700, 7695]);
    expect([open2.shortStrike, open2.longStrike]).toEqual([7740, 7745]);
  });
});

describe("bot off", () => {
  it("#10 with the bot off and an opposite position open, the webhook closes it and never opens (Always On, copied only for closes)", async () => {
    botsStore.insert({ id: TEST_BOT_ID, enabled: false, needsAttention: false, needsAttentionReason: null, createdAt: 0 });
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "open" }));
    await emit("bullish");

    expect(outcomes()).toEqual(["bot_off_close_only", "closed", "automations_off"]);
    expect(executor.placedOrders.map((o) => o.kind)).toEqual(["close"]);
    expect(positionsStore.all()).toHaveLength(1);
    expect(positionsStore.all()[0].status).toBe("closed");
  });
});

describe("executor exceptions", () => {
  it("a throwing close logs executor_error, flags needs_attention, and never opens the new side", async () => {
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "open" }));
    executor.queueScenario(TEST_BOT_ID, { kind: "throw", message: "connection reset" });
    await emit("bullish");

    expect(outcomes()).toEqual(["executor_error"]);
    expect(bot()?.needsAttention).toBe(true);
    expect(executor.placedOrders).toHaveLength(0);
    expect(positionsStore.query((p) => p.type === "short_put_spread")).toHaveLength(0);
    expect(errorsStore.all()).toHaveLength(1);
  });

  it("a throwing open logs executor_error, flags needs_attention, and keeps blocking duplicate entries", async () => {
    executor.queueScenario(TEST_BOT_ID, { kind: "throw", message: "connection reset" });
    await emit("bullish");

    expect(outcomes()).toEqual(["executor_error"]);
    expect(bot()?.needsAttention).toBe(true);

    await emit("bullish", { barTime: "bar-2", now: BASE_NOW + 130_000 });
    expect(outcomes()).toEqual(["executor_error", "already_in_position"]);
    expect(executor.placedOrders).toHaveLength(0);
  });
});

describe("missing required config", () => {
  it("logs config_error and flags the bot instead of failing silently when a setting is wrong", async () => {
    vi.stubEnv("BOT_SPX_EMA_BIAS_OPENING_CREDIT_ESTIMATE", "abc");
    await emit("bullish");

    expect(outcomes()).toEqual(["config_error"]);
    expect(decisionsStore.all()[0].reason).toContain("BOT_SPX_EMA_BIAS_OPENING_CREDIT_ESTIMATE");
    expect(bot()?.needsAttention).toBe(true);
    expect(executor.placedOrders).toHaveLength(0);
  });
});

describe("flip cooldown (off by default)", () => {
  it("flips immediately when unset", async () => {
    await emit("bullish", { barTime: "bar-1" });
    await emit("bearish", { barTime: "bar-2", now: BASE_NOW + 1000 });
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
  });

  it("leaves the position alone when a flip arrives inside the cooldown", async () => {
    vi.stubEnv("FLIP_COOLDOWN_SECONDS", "600");
    await emit("bullish", { barTime: "bar-1" });
    await emit("bearish", { barTime: "bar-2", now: BASE_NOW + 60_000 });

    expect(outcomes()).toEqual(["opened", "cooldown_active"]);
    expect(executor.placedOrders).toHaveLength(1);
  });

  it("flips once the cooldown has elapsed", async () => {
    vi.stubEnv("FLIP_COOLDOWN_SECONDS", "600");
    await emit("bullish", { barTime: "bar-1" });
    await emit("bearish", { barTime: "bar-2", now: BASE_NOW + 601_000 });
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
  });
});
