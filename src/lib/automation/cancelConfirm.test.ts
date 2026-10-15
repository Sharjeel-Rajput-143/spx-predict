import { beforeEach, describe, expect, it } from "vitest";
import { confirmOver, watchOrder } from "./orderWatch";
import { placeAndWatch } from "./placeAndWatch";
import { ordersStore, positionsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import type { BrokerExecutor, OrderState, Position } from "./types";

// A cancel is only a request: a real broker answers a moment later. Until it has, the order is not over, and the next price of a ladder
// must not be sent (both could fill). These tests use a broker that answers a cancel slowly, or never, or too late.

setNdxTestEnv();

type Behaviour = "cancels" | "fills_first" | "never_confirms";

/** A broker that keeps the order "working" after a cancel request for `lag` looks, then settles it as `behaviour` says. */
class SlowCancelBroker implements BrokerExecutor {
  readonly venue = "ibkr" as const;
  log: string[] = [];
  private n = 0;
  private state = new Map<string, { state: OrderState; cancelAskedAt: number | null; looksSinceCancel: number }>();
  constructor(private readonly behaviours: Behaviour[], private readonly lag = 3) {}

  async placeOpenOrder() {
    const ref = `ib-${++this.n}`;
    this.log.push(`place ${ref}`);
    this.state.set(ref, { state: { status: "working", filledQuantity: 0 }, cancelAskedAt: null, looksSinceCancel: 0 });
    return { ref };
  }
  async placeCloseOrder(_p: Position) {
    return this.placeOpenOrder();
  }
  async getOrder(ref: string): Promise<OrderState> {
    const s = this.state.get(ref);
    if (!s) throw new Error("unknown order");
    if (s.cancelAskedAt !== null) {
      s.looksSinceCancel++;
      const behaviour = this.behaviours[Number(ref.slice(3)) - 1] ?? "cancels";
      if (behaviour !== "never_confirms" && s.looksSinceCancel > this.lag) {
        s.state = behaviour === "fills_first" ? { status: "filled", filledQuantity: 1, averagePrice: 3.1 } : { status: "canceled", filledQuantity: 0 };
        this.log.push(`settled ${ref} as ${s.state.status}`);
      }
    }
    return { ...s.state };
  }
  async cancelOrder(ref: string) {
    this.log.push(`cancel ${ref}`);
    const s = this.state.get(ref);
    if (s && s.cancelAskedAt === null) s.cancelAskedAt = Date.now();
  }
  async listPositions() {
    return [];
  }
}

let position: Position;
beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  position = positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", type: "short_put_spread", status: "opening", requestedQuantity: 1, filledQuantity: 0 }));
});

const run = (broker: BrokerExecutor, prices: number[], extra: { cancelConfirmMs?: number } = {}) =>
  placeAndWatch({
    executor: broker,
    kind: "open",
    positionId: position.id,
    now: BASE_NOW,
    place: (price) => broker.placeOpenOrder({ botId: NDX_BOT_ID, positionType: "short_put_spread", shortStrike: 1, longStrike: 0, quantity: 1, limitCredit: price ?? 3, expiry: "x" }),
    prices,
    stepMs: 15,
    finalMs: 15,
    pollMs: 2,
    defaultLimit: 3,
    quantity: 1,
    ...extra,
  });

describe("the next price is only sent once the broker has confirmed the last order is over", () => {
  it("waits through a slow cancel; every superseded price is recorded as cancelled, not working", async () => {
    const broker = new SlowCancelBroker(["cancels", "cancels", "cancels"]);
    const result = await run(broker, [3.3, 3.1, 2.9]);
    expect(result.ok).toBe(true);
    // Strictly in order: each cancel is confirmed (settled) before the next order is placed.
    expect(broker.log).toEqual(["place ib-1", "cancel ib-1", "settled ib-1 as canceled", "place ib-2", "cancel ib-2", "settled ib-2 as canceled", "place ib-3", "cancel ib-3", "settled ib-3 as canceled"]);
    expect(ordersStore.all().sort((a, b) => a.createdAt - b.createdAt || a.ref.localeCompare(b.ref)).map((o) => [o.limitPrice, o.status])).toEqual([[3.3, "canceled"], [3.1, "canceled"], [2.9, "canceled"]]);
    expect(ordersStore.all().filter((o) => o.status === "working")).toHaveLength(0);
  });

  it("an order that fills in the moment before the cancel lands is a fill: the ladder stops, nothing more is sent, no double position", async () => {
    const broker = new SlowCancelBroker(["fills_first", "cancels"]);
    const result = await run(broker, [3.3, 3.1, 2.9]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toMatchObject({ status: "filled", filledQuantity: 1, averagePrice: 3.1 });
      expect(result.rungsTried).toBe(1);
    }
    expect(broker.log.filter((l) => l.startsWith("place"))).toEqual(["place ib-1"]); // the second price was never sent
    expect(ordersStore.all().map((o) => o.status)).toEqual(["filled"]);
  });

  it("a cancel the broker never confirms stops everything: no further order, the order stays as unknown, and the failure says so", async () => {
    const broker = new SlowCancelBroker(["never_confirms"]);
    const result = await run(broker, [3.3, 3.1, 2.9], { cancelConfirmMs: 60 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("watch");
      expect(String(result.error)).toMatch(/not confirmed within/);
      expect(String(result.error)).toMatch(/may still be working at the broker/);
    }
    expect(broker.log.filter((l) => l.startsWith("place"))).toEqual(["place ib-1"]);
  });
});

describe("watchOrder and confirmOver on their own", () => {
  it("confirmOver returns the moment an order is terminal, and throws with the order named when it is not in time", async () => {
    const quick = new SlowCancelBroker(["cancels"], 1);
    const { ref } = await quick.placeOpenOrder();
    await quick.cancelOrder(ref);
    await expect(confirmOver(quick, ref, 500, 2)).resolves.toMatchObject({ status: "canceled" });

    const stuck = new SlowCancelBroker(["never_confirms"]);
    const { ref: r2 } = await stuck.placeOpenOrder();
    await stuck.cancelOrder(r2);
    await expect(confirmOver(stuck, r2, 40, 2)).rejects.toThrow(new RegExp(`order ${r2} was not confirmed`));
  });

  it("a timed-out order is cancelled and reported with its confirmed final state", async () => {
    const broker = new SlowCancelBroker(["cancels"], 2);
    const { ref } = await broker.placeOpenOrder();
    const watched = await watchOrder(broker, ref, { timeoutMs: 20, pollIntervalMs: 2 });
    expect(watched).toMatchObject({ timedOut: true, state: { status: "canceled", filledQuantity: 0 } });
  });

  it("an order that ends by itself is returned straight away with no cancel", async () => {
    const broker = new SlowCancelBroker([]);
    const { ref } = await broker.placeOpenOrder();
    broker["state"].set(ref, { state: { status: "filled", filledQuantity: 1, averagePrice: 3 }, cancelAskedAt: null, looksSinceCancel: 0 });
    const watched = await watchOrder(broker, ref, { timeoutMs: 1000, pollIntervalMs: 2 });
    expect(watched).toMatchObject({ timedOut: false, state: { status: "filled" } });
    expect(broker.log).toEqual(["place ib-1"]); // no cancel was sent
  });
});
