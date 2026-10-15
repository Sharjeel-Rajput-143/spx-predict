import { beforeEach, describe, expect, it } from "vitest";
import { assessPosition, resolvePosition } from "./positionResolve";
import { botsStore, decisionsStore, ordersStore, positionsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import type { BrokerExecutor, BrokerPosition, Order, OrderState, Position } from "./types";
import { ensureBotRecord } from "./bots";

// Resolve: a position stuck in "closing" or "opening". Each test is one broker answer from the table: what the broker says decides what
// is offered, and nothing is ever sent to the broker except the cancelling of an order that is still working.

setNdxTestEnv();

const SHORT = "NDXP261006P20970000";
const LONG = "NDXP261006P20960000";

/** A broker that only answers, and counts anything it is asked to place (which Resolve must never do). */
class Broker implements BrokerExecutor {
  readonly venue = "ibkr" as const;
  held: BrokerPosition[] = [];
  orders = new Map<string, OrderState>();
  placeCalls = 0;
  cancelled: string[] = [];
  unreachable = false;
  /** Orders whose cancel is never confirmed. */
  stubborn = new Set<string>();
  async placeOpenOrder() {
    this.placeCalls++;
    return { ref: "no" };
  }
  async placeCloseOrder() {
    this.placeCalls++;
    return { ref: "no" };
  }
  async getOrder(ref: string) {
    const s = this.orders.get(ref);
    if (!s) throw new Error(`Bridge GET /order/${ref} failed (HTTP 404): Order not found`);
    return { ...s };
  }
  async cancelOrder(ref: string) {
    this.cancelled.push(ref);
    if (!this.stubborn.has(ref)) this.orders.set(ref, { status: "canceled", filledQuantity: 0 });
  }
  async listPositions() {
    return [];
  }
  async listBrokerPositions() {
    if (this.unreachable) throw new Error("Bridge GET /positions failed (HTTP 503): bridge unavailable");
    return this.held;
  }
}

const spread = (n = 1): BrokerPosition[] => [{ symbol: SHORT, quantity: -n }, { symbol: LONG, quantity: n }];

let broker: Broker;
const stuck = (over: Partial<Position> = {}) =>
  positionsStore.insert(buildPosition({ id: "pos-1", botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "closing", shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 1, filledQuantity: 1, credit: 3.3, venue: "ibkr", closeSignalId: "sig-close", ...over }));
const order = (over: Partial<Order> & { ref: string }): Order =>
  ordersStore.insert({ id: `ord-${over.ref}`, positionId: "pos-1", kind: "close", status: "canceled", limitPrice: 3.3, filledQuantity: 0, createdAt: BASE_NOW, updatedAt: BASE_NOW, ...over });
const flag = () => botsStore.update(NDX_BOT_ID, { needsAttention: true, needsAttentionReason: "Close order ended without filling." });
const confirmed = (action: Parameters<typeof resolvePosition>[1]["action"], extra: { price?: number } = {}) => ({ action, confirm: true, ...extra });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(NDX_BOT_ID);
  broker = new Broker();
});

describe("a closing position: what the broker says decides what is offered", () => {
  it("it still holds the whole spread, nothing working -> return to open (or try the close again); resolving it sends nothing", async () => {
    stuck();
    flag();
    broker.held = spread();
    const a = await assessPosition("pos-1", broker);
    expect(a).toMatchObject({ resolvable: true, verdict: "holds_spread", actions: ["return_to_open"], canRetryClose: true, held: { short: -1, long: 1 }, noBroker: false });
    const done = await resolvePosition("pos-1", confirmed("return_to_open"), broker, BASE_NOW);
    expect(done.position).toMatchObject({ status: "open", closeSignalId: null });
    expect(broker.placeCalls).toBe(0);
    expect(broker.cancelled).toEqual([]);
    // Logged, with what the broker showed; the flag cleared because nothing is stuck any more.
    expect(decisionsStore.all().at(-1)).toMatchObject({ outcome: "position_resolved", botId: NDX_BOT_ID, detail: { action: "return_to_open", was: "closing", verdict: "holds_spread", held: { short: -1, long: 1 }, resolvedBy: "person" } });
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ needsAttention: false, needsAttentionReason: null });
  });

  it("it holds nothing and the broker's own order shows the fill -> mark closed at that price, no typing", async () => {
    stuck();
    order({ ref: "ib-9", status: "working" }); // our row never learned it filled
    broker.orders.set("ib-9", { status: "filled", filledQuantity: 1, averagePrice: 1.2 });
    const a = await assessPosition("pos-1", broker);
    expect(a).toMatchObject({ verdict: "holds_nothing", actions: ["mark_closed"], needsPrice: false, fill: { price: 1.2, quantity: 1 }, held: { short: 0, long: 0 } });
    const done = await resolvePosition("pos-1", confirmed("mark_closed"), broker, BASE_NOW + 1000);
    expect(done.position).toMatchObject({ status: "closed", closedAt: BASE_NOW + 1000, closePrice: 1.2 });
    expect(ordersStore.get("ord-ib-9")?.status).toBe("filled"); // the stale row is brought in line with the broker
    expect(broker.placeCalls).toBe(0);
  });

  it("it holds nothing and no fill can be read -> the person types the price; a missing or impossible price changes nothing", async () => {
    stuck();
    const a = await assessPosition("pos-1", broker);
    expect(a).toMatchObject({ verdict: "holds_nothing", needsPrice: true, fill: null });
    await expect(resolvePosition("pos-1", confirmed("mark_closed"), broker)).rejects.toThrow(/Enter the price it closed at/);
    for (const bad of [0, -1, 10, 12, Number.NaN]) await expect(resolvePosition("pos-1", confirmed("mark_closed", { price: bad }), broker)).rejects.toThrow(/price/);
    expect(positionsStore.get("pos-1")?.status).toBe("closing");
    expect(decisionsStore.all().filter((d) => d.outcome === "position_resolved")).toHaveLength(0);
    const done = await resolvePosition("pos-1", confirmed("mark_closed", { price: 2.4 }), broker, BASE_NOW);
    expect(done.position).toMatchObject({ status: "closed", closePrice: 2.4 });
  });

  it("an order is still working at the broker -> only cancel is offered; nothing else is allowed until it is over", async () => {
    stuck();
    order({ ref: "ib-1", status: "working" });
    broker.orders.set("ib-1", { status: "working", filledQuantity: 0 });
    broker.held = spread();
    const a = await assessPosition("pos-1", broker);
    expect(a).toMatchObject({ verdict: "order_working", actions: ["cancel_orders"], workingOrders: [{ ref: "ib-1", kind: "close", status: "working" }] });
    for (const action of ["return_to_open", "mark_closed"] as const) await expect(resolvePosition("pos-1", confirmed(action, { price: 2 }), broker)).rejects.toThrow(/isn't available now/);
    const done = await resolvePosition("pos-1", confirmed("cancel_orders"), broker, BASE_NOW);
    expect(broker.cancelled).toEqual(["ib-1"]);
    expect(ordersStore.get("ord-ib-1")?.status).toBe("canceled"); // the broker confirmed it, and the row says so
    expect(done.position.status).toBe("closing"); // cancelling changes nothing about the position
    expect(broker.placeCalls).toBe(0);
    // Asked again, the position can now be resolved from what is held.
    expect((await assessPosition("pos-1", broker)).verdict).toBe("holds_spread");
  });

  it("an order the broker can't be asked about counts as possibly working", async () => {
    stuck();
    order({ ref: "ib-lost", status: "working" }); // the bridge has no such order
    const a = await assessPosition("pos-1", broker);
    expect(a).toMatchObject({ verdict: "order_working", workingOrders: [{ ref: "ib-lost", status: "unknown" }] });
    expect(a.headline).toMatch(/can't be read/);
  });

  it("a row that still says 'working' for an order the broker says is over does not block", async () => {
    stuck();
    order({ ref: "ib-old", status: "working" });
    broker.orders.set("ib-old", { status: "canceled", filledQuantity: 0 });
    broker.held = spread();
    expect((await assessPosition("pos-1", broker)).verdict).toBe("holds_spread");
    await resolvePosition("pos-1", confirmed("return_to_open"), broker);
    expect(ordersStore.get("ord-ib-old")?.status).toBe("canceled");
  });

  it("a cancel the broker does not confirm changes nothing and says so", async () => {
    stuck();
    order({ ref: "ib-1", status: "working" });
    broker.orders.set("ib-1", { status: "working", filledQuantity: 0 });
    broker.stubborn.add("ib-1");
    await expect(resolvePosition("pos-1", confirmed("cancel_orders"), broker, BASE_NOW, { cancelConfirmMs: 40 })).rejects.toThrow(/not confirmed/);
    expect(ordersStore.get("ord-ib-1")?.status).toBe("working");
    expect(positionsStore.get("pos-1")?.status).toBe("closing");
  });

  it("one leg only, a smaller size, or the opposite spread -> nothing is offered, and it says what the account holds", async () => {
    stuck({ requestedQuantity: 2, filledQuantity: 2 });
    for (const held of [[{ symbol: SHORT, quantity: -2 }], spread(1), [{ symbol: SHORT, quantity: 2 }, { symbol: LONG, quantity: -2 }], [{ symbol: LONG, quantity: 2 }]]) {
      broker.held = held;
      const a = await assessPosition("pos-1", broker);
      expect(a, JSON.stringify(held)).toMatchObject({ verdict: "other_holdings", actions: [], canRetryClose: false });
      expect(a.detail).toMatch(/Expected 2 of the spread/);
      await expect(resolvePosition("pos-1", confirmed("return_to_open"), broker)).rejects.toThrow(/isn't available now/);
      await expect(resolvePosition("pos-1", confirmed("mark_closed", { price: 2 }), broker)).rejects.toThrow(/isn't available now/);
    }
    expect(positionsStore.get("pos-1")?.status).toBe("closing");
  });

  it("other positions in the account, even on the same series, are not this spread's business", async () => {
    stuck();
    broker.held = [...spread(), { symbol: "AAPL", quantity: 100 }, { symbol: "NDXP261006C21040000", quantity: -3 }];
    expect((await assessPosition("pos-1", broker)).verdict).toBe("holds_spread");
  });

  it("the broker can't be reached -> nothing is offered, and nothing changes", async () => {
    stuck();
    broker.unreachable = true;
    const a = await assessPosition("pos-1", broker);
    expect(a).toMatchObject({ verdict: "broker_unreachable", actions: [], held: null });
    expect(a.detail).toMatch(/HTTP 503/);
    await expect(resolvePosition("pos-1", confirmed("return_to_open"), broker)).rejects.toThrow();
    expect(positionsStore.get("pos-1")?.status).toBe("closing");
  });

  it("a position with no option series recorded can't be matched, so nothing is offered", async () => {
    stuck({ optionRoot: undefined });
    expect(await assessPosition("pos-1", broker)).toMatchObject({ verdict: "broker_unreachable", actions: [] });
  });
});

describe("an opening position", () => {
  const opening = (over: Partial<Position> = {}) => stuck({ status: "opening", filledQuantity: 0, credit: null, closeSignalId: null, ...over });

  it("the broker holds the whole spread -> mark open at that size, at the credit the broker's order shows", async () => {
    opening();
    flag();
    order({ ref: "ib-o", kind: "open", status: "working", limitPrice: 3.3 });
    broker.orders.set("ib-o", { status: "filled", filledQuantity: 1, averagePrice: 3.1 });
    broker.held = spread();
    const a = await assessPosition("pos-1", broker);
    expect(a).toMatchObject({ verdict: "holds_spread", actions: ["mark_open"], fill: { price: 3.1, quantity: 1 } });
    const done = await resolvePosition("pos-1", confirmed("mark_open"), broker, BASE_NOW);
    expect(done.position).toMatchObject({ status: "open", filledQuantity: 1, credit: 3.1 });
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(false);
  });

  it("the broker holds two spreads when one was asked for -> marked open at one: the size is capped at what the bot asked for", async () => {
    opening({ requestedQuantity: 1 });
    broker.held = spread(2);
    const a = await assessPosition("pos-1", broker);
    expect(a.verdict).toBe("holds_spread"); // a whole spread, two of it
    const done = await resolvePosition("pos-1", confirmed("mark_open", { price: 3 }), broker);
    expect(done.position.filledQuantity).toBe(1); // capped at the asked-for size
  });

  it("the broker holds nothing -> mark rejected, so it stops counting as held", async () => {
    opening();
    const a = await assessPosition("pos-1", broker);
    expect(a).toMatchObject({ verdict: "holds_nothing", actions: ["mark_rejected"] });
    const done = await resolvePosition("pos-1", confirmed("mark_rejected"), broker);
    expect(done.position.status).toBe("rejected");
  });

  it("no credit to be read and none typed -> asks for it; an impossible credit changes nothing", async () => {
    opening();
    broker.held = spread();
    await expect(resolvePosition("pos-1", confirmed("mark_open"), broker)).rejects.toThrow(/Enter the credit it opened at/);
    await expect(resolvePosition("pos-1", confirmed("mark_open", { price: 11 }), broker)).rejects.toThrow(/Enter the credit/);
    expect(positionsStore.get("pos-1")?.status).toBe("opening");
    expect((await resolvePosition("pos-1", confirmed("mark_open", { price: 2.9 }), broker)).position.credit).toBe(2.9);
  });

  it("a leg or two that doesn't make a spread -> nothing is offered", async () => {
    opening();
    broker.held = [{ symbol: SHORT, quantity: -1 }];
    expect(await assessPosition("pos-1", broker)).toMatchObject({ verdict: "other_holdings", actions: [] });
  });
});

describe("a simulated position has no broker to ask", () => {
  it("is offered the choices that fit, with the warning that no broker was asked", async () => {
    stuck({ venue: "mock" });
    const a = await assessPosition("pos-1", broker);
    expect(a).toMatchObject({ verdict: "no_broker", noBroker: true, actions: ["return_to_open", "mark_closed"], needsPrice: true });
    expect(a.headline).toMatch(/no broker account to ask/);
    expect(await assessPosition("pos-1", { ...broker, listBrokerPositions: undefined } as unknown as BrokerExecutor)).toMatchObject({ noBroker: true });
    positionsStore.update("pos-1", { status: "opening" });
    expect((await assessPosition("pos-1", broker)).actions).toEqual(["mark_open", "mark_rejected"]);
  });

  it("works through to the end, and the log says no broker was asked", async () => {
    stuck({ venue: "mock" });
    await resolvePosition("pos-1", confirmed("mark_closed", { price: 1 }), broker, BASE_NOW);
    const d = decisionsStore.all().at(-1)!;
    expect(d.reason).toMatch(/no broker account was asked/);
    expect(d.detail).toMatchObject({ noBroker: true });
    expect(broker.placeCalls).toBe(0);
  });

  it("a real-broker position while no broker is connected is treated the same way (and says so)", async () => {
    stuck();
    const noList = { ...broker, listBrokerPositions: undefined, getOrder: broker.getOrder.bind(broker) } as unknown as BrokerExecutor;
    const a = await assessPosition("pos-1", noList);
    expect(a).toMatchObject({ noBroker: true });
  });
});

describe("the rules that apply to every action", () => {
  it("nothing is changed without the person's confirmation", async () => {
    stuck();
    broker.held = spread();
    await expect(resolvePosition("pos-1", { action: "return_to_open", confirm: false }, broker)).rejects.toThrow(/Confirm/);
    expect(positionsStore.get("pos-1")?.status).toBe("closing");
  });

  it("only a stuck position can be resolved: open, closed, expired and rejected ones are refused", async () => {
    for (const status of ["open", "closed", "expired", "rejected"] as const) {
      positionsStore.insert(buildPosition({ id: `p-${status}`, botId: NDX_BOT_ID, type: "short_put_spread", status }));
      const a = await assessPosition(`p-${status}`, broker);
      expect(a).toMatchObject({ resolvable: false, actions: [] });
      await expect(resolvePosition(`p-${status}`, confirmed("return_to_open"), broker)).rejects.toThrow(/Nothing to resolve/);
    }
  });

  it("an unknown position is an error, and asking never writes anything", async () => {
    await expect(assessPosition("nope", broker)).rejects.toThrow(/not found/);
    stuck();
    order({ ref: "ib-x", status: "working" });
    broker.orders.set("ib-x", { status: "filled", filledQuantity: 1, averagePrice: 1 });
    const before = JSON.stringify([positionsStore.all(), ordersStore.all(), decisionsStore.all(), botsStore.all()]);
    await assessPosition("pos-1", broker);
    expect(JSON.stringify([positionsStore.all(), ordersStore.all(), decisionsStore.all(), botsStore.all()])).toBe(before);
  });

  it("the bot's flag is cleared only when no stuck position is left for it", async () => {
    stuck();
    stuck({ id: "pos-2", shortStrike: 20_950, longStrike: 20_940 });
    flag();
    broker.held = [...spread(), { symbol: "NDXP261006P20950000", quantity: -1 }, { symbol: "NDXP261006P20940000", quantity: 1 }];
    await resolvePosition("pos-1", confirmed("return_to_open"), broker);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true); // one is still stuck
    await resolvePosition("pos-2", confirmed("return_to_open"), broker);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(false);
  });

  it("cancelling an order never clears the flag", async () => {
    stuck();
    flag();
    order({ ref: "ib-1", status: "working" });
    broker.orders.set("ib-1", { status: "working", filledQuantity: 0 });
    await resolvePosition("pos-1", confirmed("cancel_orders"), broker);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);
  });

  it("never places an order, whatever is chosen", async () => {
    for (const [action, setup] of [
      ["return_to_open", () => { broker.held = spread(); }],
      ["mark_closed", () => { broker.held = []; }],
    ] as const) {
      resetAutomationStores();
      setNdxTestEnv();
      ensureBotRecord(NDX_BOT_ID);
      stuck();
      setup();
      await resolvePosition("pos-1", confirmed(action, { price: 2 }), broker);
    }
    expect(broker.placeCalls).toBe(0);
  });
});
