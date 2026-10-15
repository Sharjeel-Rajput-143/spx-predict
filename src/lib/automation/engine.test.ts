import { beforeEach, describe, expect, it } from "vitest";
import { withBotLock } from "./botLock";
import { MockExecutor } from "./executor";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { decisionsStore, ordersStore, positionsStore } from "./store";
import { BASE_NOW, TEST_BOT_ID, buildPosition, resetAutomationStores, setTestBotEnv } from "./testSupport";
import { ACTIVE_POSITION_STATUSES } from "./types";
import type { SignalDirection } from "./types";

setTestBotEnv();

let executor: MockExecutor;

function emit(
  direction: SignalDirection,
  opts: { price?: number; barTime?: string; now?: number; dryRun?: boolean } = {},
) {
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
    dryRun: opts.dryRun,
    closeConfirmTimeoutMs: 50,
    orderFillTimeoutMs: 50,
    pollIntervalMs: 5,
  });
}

function botPositions() {
  return positionsStore.query((p) => p.botId === TEST_BOT_ID);
}

function botDecisions(outcome?: string) {
  return decisionsStore.query((d) => d.botId === TEST_BOT_ID && (!outcome || d.outcome === outcome));
}

beforeEach(() => {
  resetAutomationStores();
  executor = new MockExecutor();
});

describe("processSignal - opening", () => {
  it("#1 opens a short put spread on a bullish signal with no existing positions", async () => {
    await emit("bullish");
    const positions = botPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ type: "short_put_spread", status: "open", filledQuantity: 3 });
    expect(botDecisions("opened")).toHaveLength(1);
  });

  it("#4 opens a short call spread on a bearish signal with no existing positions", async () => {
    await emit("bearish");
    const positions = botPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ type: "short_call_spread", status: "open" });
    expect(botDecisions("opened")).toHaveLength(1);
  });

  it("#2 does nothing on a second bullish signal while a put spread is already open", async () => {
    await emit("bullish", { barTime: "bar-1" });
    await emit("bullish", { barTime: "bar-2", now: BASE_NOW + 130_000 });
    expect(botPositions()).toHaveLength(1);
    expect(botDecisions("already_in_position")).toHaveLength(1);
  });

  it("#4 does nothing on a second bearish signal while a call spread is already open", async () => {
    await emit("bearish", { barTime: "bar-1" });
    await emit("bearish", { barTime: "bar-2", now: BASE_NOW + 130_000 });
    expect(botPositions()).toHaveLength(1);
    expect(botDecisions("already_in_position")).toHaveLength(1);
  });
});

describe("processSignal - flips", () => {
  it("#3 closes an existing call spread, confirms it, then opens a put spread on a bullish signal", async () => {
    await emit("bearish", { barTime: "bar-1" });
    await emit("bullish", { barTime: "bar-2", now: BASE_NOW + 130_000 });

    const positions = botPositions();
    expect(positions).toHaveLength(2);
    const call = positions.find((p) => p.type === "short_call_spread")!;
    const put = positions.find((p) => p.type === "short_put_spread")!;
    expect(call.status).toBe("closed");
    expect(put.status).toBe("open");

    // The first emit() (opening the call spread) also logs an "opened" -
    // only the flip's own order matters here, so look past the close.
    const all = decisionsStore.all().filter((d) => d.botId === TEST_BOT_ID);
    const closedIdx = all.findIndex((d) => d.outcome === "closed");
    const openedAfterCloseIdx = all.findIndex((d, i) => d.outcome === "opened" && i > closedIdx);
    expect(closedIdx).toBeGreaterThanOrEqual(0);
    expect(openedAfterCloseIdx).toBeGreaterThan(closedIdx);
  });

  it("#4 closes an existing put spread, confirms it, then opens a call spread on a bearish signal", async () => {
    await emit("bullish", { barTime: "bar-1" });
    await emit("bearish", { barTime: "bar-2", now: BASE_NOW + 130_000 });

    const positions = botPositions();
    const put = positions.find((p) => p.type === "short_put_spread")!;
    const call = positions.find((p) => p.type === "short_call_spread")!;
    expect(put.status).toBe("closed");
    expect(call.status).toBe("open");
  });
});

describe("processSignal - dedupe", () => {
  it("#6 acts exactly once for an identical signal with the same bar_time", async () => {
    await emit("bullish", { barTime: "bar-dup" });
    await emit("bullish", { barTime: "bar-dup" });
    expect(botPositions()).toHaveLength(1);
    expect(botDecisions("duplicate_signal")).toHaveLength(1);
  });

  it("#6 acts exactly once for an identical signal two seconds apart", async () => {
    await emit("bullish", { barTime: "bar-1" });
    await emit("bullish", { barTime: "bar-2", now: BASE_NOW + 2000 });
    expect(botPositions()).toHaveLength(1);
    expect(botDecisions("duplicate_signal")).toHaveLength(1);
  });
});

describe("processSignal - concurrency", () => {
  it("#7 serializes two opposite signals arriving nearly simultaneously, ending in the correct final state", async () => {
    const first = withBotLock(TEST_BOT_ID, () => emit("bullish", { barTime: "bar-1", now: BASE_NOW }));
    const second = withBotLock(TEST_BOT_ID, () => emit("bearish", { barTime: "bar-2", now: BASE_NOW + 1 }));
    await Promise.all([first, second]);

    const active = botPositions().filter((p) => ACTIVE_POSITION_STATUSES.includes(p.status));
    expect(active).toHaveLength(1);
    expect(active[0].type).toBe("short_call_spread");
  });
});

describe("processSignal - active-status counting", () => {
  it("#12 counts an opening-status position for the already-in-position check", async () => {
    positionsStore.insert(buildPosition({ type: "short_put_spread", status: "opening" }));
    await emit("bullish");
    expect(botDecisions("already_in_position")).toHaveLength(1);
  });

  it("#12 a closing-status position counts as held: it isn't closed a second time, and nothing opens until it is gone", async () => {
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "closing" }));
    await emit("bullish");
    const call = botPositions().find((p) => p.type === "short_call_spread")!;
    expect(call.status).toBe("closing"); // no second close was sent
    expect(botDecisions("stuck_position")).toHaveLength(1);
    expect(botPositions().filter((p) => p.type === "short_put_spread")).toHaveLength(0); // and the other side never opened
  });
});

describe("processSignal - safeguards", () => {
  it("#16 daily new-position limit still allows closing the old side but opens nothing new", async () => {
    for (let i = 0; i < 10; i++) {
      positionsStore.insert(
        buildPosition({ type: "short_put_spread", status: "expired", openedAt: BASE_NOW, id: `pos-today-${i}` }),
      );
    }
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "open", id: "pos-call-active" }));

    await emit("bullish");

    const call = positionsStore.get("pos-call-active")!;
    expect(call.status).toBe("closed");
    expect(botDecisions("daily_limit_reached")).toHaveLength(1);
    expect(botPositions().filter((p) => p.type === "short_put_spread" && p.status === "open")).toHaveLength(0);
  });

  it("#17 refuses to open when it would exceed the allocation limit", async () => {
    process.env.BOT_SPX_EMA_BIAS_ALLOCATION_LIMIT = "500"; // projected risk is 840 at qty 3 / width 5 / credit 2.20
    await emit("bullish");
    process.env.BOT_SPX_EMA_BIAS_ALLOCATION_LIMIT = "20000";

    expect(botPositions()).toHaveLength(0);
    expect(botDecisions("allocation_limit_reached")).toHaveLength(1);
  });

});

describe("processSignal - dry run", () => {
  it("#21 logs the intended decision but creates no positions and no orders", async () => {
    await emit("bullish", { dryRun: true });
    expect(botPositions()).toHaveLength(0);
    expect(ordersStore.all()).toHaveLength(0);
    expect(botDecisions("dry_run")).toHaveLength(1);
  });
});
