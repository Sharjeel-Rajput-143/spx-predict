import { beforeEach, describe, expect, it } from "vitest";
import { alertsStore, botsStore, decisionsStore, ordersStore, positionsStore } from "./store";
import { NDX_BOT_ID, buildPosition, resetAutomationStores } from "./testSupport";
import { recoverInFlightPositions } from "./recovery";
import type { BrokerExecutor, OrderState, Position } from "./types";

// Recovery after a restart, against a fake broker that answers from a table. No requests.
const broker = (orders: Record<string, OrderState | Error>) =>
  ({
    getOrder: async (ref: string) => {
      const o = orders[ref];
      if (!o) throw new Error(`unknown order ${ref}`);
      if (o instanceof Error) throw o;
      return o;
    },
    placeOpenOrder: async () => {
      throw new Error("recovery must never place an order");
    },
    placeCloseOrder: async () => {
      throw new Error("recovery must never place an order");
    },
    cancelOrder: async () => {
      throw new Error("recovery must never cancel an order");
    },
  }) as unknown as BrokerExecutor;

const pos = (over: Parameters<typeof buildPosition>[0] & { brokerOrderRef?: string | null }) => buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", requestedQuantity: 1, filledQuantity: 0, credit: null, brokerOrderRef: "ord-1", ...over });
const state = (over: Partial<OrderState>): OrderState => ({ status: "filled", filledQuantity: 1, averagePrice: 3.4, ...over });

beforeEach(() => resetAutomationStores());

describe("positions left opening", () => {
  it("an order that filled while we were down: the position is open, at the filled size and price", async () => {
    positionsStore.insert(pos({ id: "p", type: "short_put_spread", status: "opening" }));
    const r = await recoverInFlightPositions(broker({ "ord-1": state({}) }));
    expect(r.map((x) => x.action)).toEqual(["opened"]);
    expect(positionsStore.get("p")).toMatchObject({ status: "open", filledQuantity: 1, credit: 3.4 });
    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["opened"]);
  });

  it("an order that was rejected or canceled with no fill: the position is rejected", async () => {
    positionsStore.insert(pos({ id: "a", type: "short_put_spread", status: "opening" }));
    positionsStore.insert(pos({ id: "b", type: "short_call_spread", status: "opening", brokerOrderRef: "ord-2", shortStrike: 7740, longStrike: 7745 }));
    await recoverInFlightPositions(broker({ "ord-1": state({ status: "rejected", filledQuantity: 0 }), "ord-2": state({ status: "canceled", filledQuantity: 0 }) }));
    expect(positionsStore.get("a")?.status).toBe("rejected");
    expect(positionsStore.get("b")?.status).toBe("rejected");
  });

  it("an order still working is left alone and the bot is flagged", async () => {
    positionsStore.insert(pos({ id: "p", type: "short_put_spread", status: "opening" }));
    const r = await recoverInFlightPositions(broker({ "ord-1": state({ status: "working", filledQuantity: 0 }) }));
    expect(r[0].action).toBe("flagged");
    expect(positionsStore.get("p")?.status).toBe("opening"); // not touched
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ needsAttention: true });
    expect(alertsStore.all().map((a) => a.kind)).toEqual(["error"]);
  });

  it("a partial fill is flagged rather than guessed at", async () => {
    positionsStore.insert(pos({ id: "p", type: "short_put_spread", status: "opening", requestedQuantity: 3 }));
    const r = await recoverInFlightPositions(broker({ "ord-1": state({ status: "partially_filled", filledQuantity: 1 }) }));
    expect(r[0].action).toBe("flagged");
    expect(positionsStore.get("p")?.status).toBe("opening");
  });
});

describe("positions left closing", () => {
  const closing = (over: Partial<Position> = {}) => pos({ id: "p", type: "short_put_spread", status: "closing", filledQuantity: 1, credit: 3.5, ...over });

  it("a close that filled: the position is closed at the reported price", async () => {
    positionsStore.insert(closing());
    await recoverInFlightPositions(broker({ "ord-1": state({ averagePrice: 3.1 }) }));
    expect(positionsStore.get("p")).toMatchObject({ status: "closed", closePrice: 3.1 });
    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["closed"]);
  });

  it("a close that ended unfilled: the position is open again and the bot is flagged - the new side was never opened", async () => {
    positionsStore.insert(closing());
    const r = await recoverInFlightPositions(broker({ "ord-1": state({ status: "canceled", filledQuantity: 0 }) }));
    expect(r[0].action).toBe("reverted_to_open");
    expect(positionsStore.get("p")?.status).toBe("open");
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ needsAttention: true });
  });

  it("a close still working is left alone and flagged", async () => {
    positionsStore.insert(closing());
    const r = await recoverInFlightPositions(broker({ "ord-1": state({ status: "working", filledQuantity: 0 }) }));
    expect(r[0].action).toBe("flagged");
    expect(positionsStore.get("p")?.status).toBe("closing");
  });
});

describe("what it can't read", () => {
  it("no order reference, or an order the broker can't find, is flagged", async () => {
    positionsStore.insert(pos({ id: "a", type: "short_put_spread", status: "opening", brokerOrderRef: null }));
    positionsStore.insert(pos({ id: "b", type: "short_call_spread", status: "closing", brokerOrderRef: "ord-9", shortStrike: 7740, longStrike: 7745 }));
    const r = await recoverInFlightPositions(broker({}));
    expect(r.map((x) => x.action)).toEqual(["flagged", "flagged"]);
    expect(positionsStore.get("a")?.status).toBe("opening");
    expect(positionsStore.get("b")?.status).toBe("closing");
  });

  it("settled and open positions are not touched, and it never places or cancels an order", async () => {
    positionsStore.insert(pos({ id: "o", type: "short_put_spread", status: "open", filledQuantity: 1 }));
    positionsStore.insert(pos({ id: "c", type: "short_call_spread", status: "closed", shortStrike: 7740, longStrike: 7745 }));
    expect(await recoverInFlightPositions(broker({}))).toEqual([]);
    expect(ordersStore.all()).toHaveLength(0);
  });
});
