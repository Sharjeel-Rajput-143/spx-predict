import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as hookRoute } from "@/app/api/webhook/hook/[token]/route";
import { ensureBotRecord } from "./bots";
import { MockExecutor } from "./executor";
import { manualClose, processSignal, receiveAndSaveSignal } from "./engine";
import { runEntryRetry } from "./entryRetry";
import { IbkrExecutor, type BridgeFetch, type IbkrConfig } from "./ibkrExecutor";
import { OrderNotPlacedError } from "./orderErrors";
import { assessPosition, resolvePosition } from "./positionResolve";
import { reconcile } from "./reconcile";
import { recoverInFlightPositions } from "./recovery";
import { botsStore, decisionsStore, ordersStore, positionsStore, runsStore, signalsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import { occSymbol } from "./tradierExecutor";
import { createWebhook } from "./webhooks";

// The bot, end to end, against a stateful FAKE bridge: it keeps orders, fills them, refuses repeats of an order id and reports the account's
// positions, the way docs/ibkr-bridge-contract.md says a real one must. Nothing here touches a network or a real webhook address.
//
// The price is the NDX at 21,003.7, so the strikes are fixed:  bullish -> short PUT spread 20,970 / 20,960   bearish -> short CALL spread 21,035 / 21,045

setNdxTestEnv();

const BASE = "https://bridge.example.test";
const SECRET = "test-bridge-secret-not-real";
const cfg: IbkrConfig = { baseUrl: BASE, secret: SECRET, allowLive: false, maxContracts: null, maxRiskPerOrder: null, maxQuoteAgeMs: 60_000 };
const MIN = 60_000;
const EXPIRY_ROOT = "NDXP";

interface Req {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  secret: string | undefined;
}
interface BridgeOrder {
  ref: string;
  clientOrderId: string | null;
  kind: "open" | "close";
  body: Record<string, unknown>;
  status: "working" | "filled" | "rejected" | "canceled";
  filledQuantity: number;
  averagePrice?: number;
  band?: { edge: number; marketPrice: number };
}

class FakeBridge {
  account = "DU1234567";
  connected = true;
  price = 21_003.7;
  /** How old the index quote is, in ms. */
  quoteAgeMs = 1_000;
  /** What a new order does: fill at once, be rejected, or sit working forever. */
  fill: "fill" | "reject" | "never" | "cancelNow" = "fill";
  /** What the bridge adds to the answer for an order that ended canceled or rejected: reason, priceBand, ibkrStatus, permId, events. */
  endExtras: Record<string, unknown> = {};
  /** What /health says about `paper` (default: true for a DU account). */
  paperOverride: boolean | undefined = undefined;
  /** A close is filled only at this limit debit or higher; below it the order just sits working. null = the usual `fill` rule. */
  closeFillAtOrAbove: number | null = null;
  /** A close at this limit debit or higher is refused at once with a price band (market price and edge), as IBKR's error 202. */
  band: { edge: number; marketPrice: number } | null = null;
  /** Paths (without the leading slash) that never answer at all: the connection fails. */
  unreachable = new Set<string>();
  /** Paths (without the leading slash) that answer with this HTTP status and body (a refusal such as 422). */
  refuse = new Map<string, { status: number; body: unknown }>();
  /** Paths (without the leading slash) that answer 503. */
  down = new Set<string>();
  /** Fill price used for closes (a debit). */
  closeDebit = 1.2;
  /** What GET /quote/spread answers (null: no usable quote). Credit market 2.70 to 3.90, mid 3.30; debit market the same numbers. */
  spreadQuote: { short: Record<string, number | null>; long: Record<string, number | null> } | null = { short: { bid: 12, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } };
  orders = new Map<string, BridgeOrder>();
  requests: Req[] = [];
  private n = 0;

  fetch: BridgeFetch = async (url, init) => {
    if (!url.startsWith(BASE)) throw new Error(`no network in tests: ${url}`);
    const u = new URL(url);
    const path = u.pathname;
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.requests.push({ method: init.method, path, body, secret: init.headers["X-Bridge-Secret"] });
    const reply = (status: number, json: unknown) => ({ ok: status < 300, status, text: async () => (typeof json === "string" ? json : JSON.stringify(json)) });
    if (init.headers["X-Bridge-Secret"] !== SECRET) return reply(401, "bad secret");
    if (this.down.has(path.slice(1))) return reply(503, "bridge unavailable");
    if (this.unreachable.has(path.slice(1))) throw new TypeError("fetch failed");
    const refusal = this.refuse.get(path.slice(1));
    if (refusal) return reply(refusal.status, refusal.body);

    if (path === "/health") return reply(200, { connected: this.connected, account: this.account, paper: this.paperOverride ?? this.account.startsWith("DU") });
    if (path === "/quote/ndx") return reply(200, { price: this.price, asOf: Date.now() - this.quoteAgeMs });
    if (path === "/quote/spread") return this.spreadQuote ? reply(200, this.spreadQuote) : reply(503, "No bid and ask for an option leg (market closed or no data)");
    if (path === "/positions") return reply(200, { positions: this.heldLegs() });
    if (path === "/open_spread" || path === "/close_spread") {
      const clientOrderId = typeof body?.clientOrderId === "string" ? body.clientOrderId : null;
      const repeat = clientOrderId ? [...this.orders.values()].find((o) => o.clientOrderId === clientOrderId) : undefined;
      // The real bridge remembers every id: the same id with the same order gives the same reference, with a different order it is refused.
      if (repeat) return JSON.stringify(repeat.body) === JSON.stringify(body ?? {}) ? reply(200, { ref: repeat.ref }) : reply(409, { detail: "clientOrderId was already used with a different order" });
      const order: BridgeOrder = { ref: `ib-${++this.n}`, clientOrderId, kind: path === "/open_spread" ? "open" : "close", body: body ?? {}, status: "working", filledQuantity: 0 };
      if (this.fill === "fill") {
        order.status = "filled";
        order.filledQuantity = Number(body?.quantity);
        order.averagePrice = order.kind === "open" ? Number(body?.limitCredit) : Number(body?.limitDebit ?? this.closeDebit);
      } else if (this.fill === "reject") order.status = "rejected";
      else if (this.fill === "cancelNow") order.status = "canceled";
      if (order.kind === "close") {
        const price = Number(body?.limitDebit);
        if (this.band && price >= this.band.edge) {
          order.status = "canceled";
          order.filledQuantity = 0;
          order.averagePrice = undefined;
          order.band = this.band;
        } else if (this.closeFillAtOrAbove !== null) {
          if (price >= this.closeFillAtOrAbove) {
            order.status = "filled";
            order.filledQuantity = Number(body?.quantity);
            order.averagePrice = price;
          } else {
            order.status = "working";
            order.filledQuantity = 0;
            order.averagePrice = undefined;
          }
        }
      }
      this.orders.set(order.ref, order);
      return reply(200, { ref: order.ref });
    }
    const m = /^\/order\/(.+)$/.exec(path);
    if (m) {
      const order = this.orders.get(decodeURIComponent(m[1]));
      if (!order) return reply(404, "unknown order");
      if (init.method === "DELETE") {
        if (order.status === "working") order.status = "canceled";
        return reply(200, { ok: true });
      }
      return reply(200, { status: order.status, filledQuantity: order.filledQuantity, ...(order.averagePrice !== undefined && order.filledQuantity > 0 ? { averagePrice: order.averagePrice } : {}), ...(order.status === "rejected" ? { rejectReason: "Insufficient margin" } : {}) , ...(order.status === "canceled" || order.status === "rejected" ? this.endExtras : {}), ...(order.band ? { priceBand: order.band } : {}) });
    }
    return reply(404, "no such endpoint");
  };

  /** The account's positions, worked out from the filled orders. */
  heldLegs() {
    const held = new Map<string, number>();
    for (const o of this.orders.values()) {
      if (o.filledQuantity === 0) continue;
      const right = o.body.right as "put" | "call";
      const sign = o.kind === "open" ? 1 : -1;
      const q = o.filledQuantity;
      const add = (strike: unknown, qty: number) => {
        const sym = occSymbol(EXPIRY_ROOT, String(o.body.expiry), right, Number(strike));
        held.set(sym, (held.get(sym) ?? 0) + qty);
      };
      add(o.body.shortStrike, -sign * q);
      add(o.body.longStrike, sign * q);
    }
    return [...held].filter(([, q]) => q !== 0).map(([symbol, quantity]) => ({ symbol, quantity }));
  }

  calls(path: string) {
    return this.requests.filter((r) => r.path === path);
  }
  placed() {
    return this.requests.filter((r) => r.path === "/open_spread" || r.path === "/close_spread").map((r) => `${r.path === "/open_spread" ? "open" : "close"} ${r.body?.right === "put" ? "PUT" : "CALL"} ${r.body?.shortStrike}/${r.body?.longStrike}`);
  }
}

let bridge: FakeBridge;
let executor: IbkrExecutor;
const fast = { closeConfirmTimeoutMs: 100, orderFillTimeoutMs: 100, pollIntervalMs: 5, ladderStepMs: 20 };
const mine = () => positionsStore.all().filter((p) => p.botId === NDX_BOT_ID);
const held = () => mine().filter((p) => p.status === "open" || p.status === "opening" || p.status === "closing");
const outcomes = () => decisionsStore.all().filter((d) => d.signalId !== null).map((d) => d.outcome);

const alert = (direction: "bullish" | "bearish", barTime: string, now: number) =>
  receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 21_003.7, barTime, interval: "5", raw: { symbol: "NDX" }, now });
const run = (direction: "bullish" | "bearish", barTime: string, now = BASE_NOW) => processSignal(alert(direction, barTime, now), { executor, now, ...fast });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  bridge = new FakeBridge();
  executor = new IbkrExecutor(cfg, bridge.fetch);
  ensureBotRecord(NDX_BOT_ID);
});

describe("an alert on the IBKR adapter: open", () => {
  it("opens the put spread as one combo order, and the fill becomes the position", async () => {
    await run("bullish", "b1");
    expect(bridge.placed()).toEqual(["open PUT 20970/20960"]);
    expect(bridge.calls("/open_spread")[0].body).toMatchObject({ underlying: "NDX", root: "NDXP", type: "short_put_spread", quantity: 1, limitCredit: 3.3, tif: "DAY" });
    expect(bridge.requests.every((r) => r.secret === SECRET)).toBe(true);
    const [p] = held();
    expect(p).toMatchObject({ type: "short_put_spread", status: "open", shortStrike: 20_970, longStrike: 20_960, filledQuantity: 1, credit: 3.3, venue: "ibkr", brokerOrderRef: "ib-1" });
    expect(ordersStore.all().map((o) => [o.kind, o.status, o.ref])).toEqual([["open", "filled", "ib-1"]]);
    expect(outcomes()).toEqual(["opened"]);
  });

  it("the account then holds exactly the two legs our records say", async () => {
    await run("bullish", "b1");
    expect(bridge.heldLegs()).toEqual([{ symbol: "NDXP261006P20970000", quantity: -1 }, { symbol: "NDXP261006P20960000", quantity: 1 }]);
    expect(await reconcile(executor)).toMatchObject({ ok: true, expectedLegs: 2, brokerLegs: 2, problems: [] });
  });

  it("a second alert for the side already held places nothing", async () => {
    await run("bullish", "b1");
    await run("bullish", "b2", BASE_NOW + 5 * MIN);
    expect(bridge.calls("/open_spread")).toHaveLength(1);
    expect(outcomes()).toEqual(["opened", "already_in_position"]);
  });
});

describe("an alert on the IBKR adapter: a leg has no quote", () => {
  const cases: Array<[string, { short: Record<string, number | null>; long: Record<string, number | null> }]> = [
    ["no bid on the short leg", { short: { ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } }],
    ["no ask on the long leg", { short: { bid: 12, ask: 12.6 }, long: { bid: 8.7, ask: null } }],
    ["IBKR's -1 for no data", { short: { bid: -1, ask: -1 }, long: { bid: 8.7, ask: 9.3 } }],
  ];
  for (const [name, quote] of cases) {
    it(`${name}: the open is refused with a clear message and a log entry, and nothing is sent`, async () => {
      bridge.spreadQuote = quote;
      await run("bullish", "b1");
      expect(bridge.placed()).toEqual([]);
      expect(mine()).toHaveLength(0);
      expect(outcomes()).toEqual(["open_no_quote"]);
      const d = decisionsStore.all().find((x) => x.outcome === "open_no_quote");
      expect(d?.reason).toMatch(/Open refused: there is no usable quote of the spread/);
      expect(d?.reason).toMatch(/bid and ask for one or both legs/);
      expect(d?.reason).toMatch(/Nothing was sent/);
    });
  }
});

describe("an alert on the IBKR adapter: flip", () => {
  it("closes the put spread first, waits for that fill, then opens the call spread", async () => {
    await run("bullish", "b1");
    await run("bearish", "b2", BASE_NOW + 5 * MIN);

    expect(bridge.placed()).toEqual(["open PUT 20970/20960", "close PUT 20970/20960", "open CALL 21035/21045"]);
    const close = bridge.calls("/close_spread")[0].body!;
    expect(close).toMatchObject({ positionId: mine()[0].id, quantity: 1, orderType: "limit", tif: "DAY" });
    expect(close.limitDebit).toBeGreaterThan(0); // a combo is never sent without a limit price
    expect(mine().map((p) => [p.type, p.status])).toEqual([["short_put_spread", "closed"], ["short_call_spread", "open"]]);
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
    // The account ends up holding only the call spread, which is what our records say.
    expect(bridge.heldLegs()).toEqual([{ symbol: "NDXP261006C21035000", quantity: -1 }, { symbol: "NDXP261006C21045000", quantity: 1 }]);
    expect(await reconcile(executor)).toMatchObject({ ok: true, problems: [] });
  });

  it("every order carries its own id built from the alert, and none repeats", async () => {
    await run("bullish", "b1");
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    const ids = bridge.requests.filter((r) => r.path === "/open_spread" || r.path === "/close_spread").map((r) => r.body?.clientOrderId as string);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    const [s1, s2] = signalsStore.all().sort((a, b) => a.receivedAt - b.receivedAt);
    expect(ids[0]).toBe(`${s1.id}:open:1`);
    expect(ids[1]).toBe(`${mine()[0].id}:close:1:1`); // the position's id, the attempt, the rung
    expect(ids[2]).toBe(`${s2.id}:open:1`);
  });

  it("a position closed by hand at the broker is never 'closed' again by an order that would open the opposite spread", async () => {
    await run("bullish", "b1");
    bridge.orders.clear(); // someone closed it in TWS: the account holds nothing now
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(bridge.calls("/close_spread")).toHaveLength(0);
    expect(bridge.calls("/open_spread")).toHaveLength(1); // only the first open: no new side either
    expect(bridge.heldLegs()).toEqual([]);
    expect(mine().map((p) => [p.type, p.status])).toEqual([["short_put_spread", "closing"]]);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).toMatch(/does not hold this spread/);
  });

  it("a close that fails opens nothing on the new side: the old position is left for a person", async () => {
    await run("bullish", "b1");
    bridge.unreachable.add("close_spread"); // no answer at all: the order may or may not exist
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(bridge.calls("/open_spread")).toHaveLength(1); // only the first open
    expect(mine().map((p) => [p.type, p.status])).toEqual([["short_put_spread", "closing"]]);
    expect(bridge.heldLegs()).toHaveLength(2); // the put spread is still there
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);
  });
});

describe("an alert on the IBKR adapter: the broker says no", () => {
  it("a rejected open leaves nothing held, and says why in the log", async () => {
    bridge.fill = "reject";
    await run("bullish", "b1");
    expect(held()).toHaveLength(0);
    expect(mine().map((p) => p.status)).toEqual(["rejected"]);
    expect(outcomes()).toEqual(["open_rejected"]);
    expect(decisionsStore.all().find((d) => d.outcome === "open_rejected")?.reason).toContain("Insufficient margin");
    expect(bridge.heldLegs()).toEqual([]);
  });

  it("an open that never fills is cancelled at the bridge, and nothing is held", async () => {
    bridge.fill = "never";
    await run("bullish", "b1");
    // Every price of the ladder was tried and every order was cancelled at the bridge: none is left working.
    const orders = [...bridge.orders.values()];
    expect(orders).toHaveLength(4);
    expect(orders.map((o) => o.status)).toEqual(["canceled", "canceled", "canceled", "canceled"]);
    expect(ordersStore.all().map((o) => o.status)).toEqual(["canceled", "canceled", "canceled", "canceled"]);
    expect(bridge.calls("/order/ib-1").map((r) => r.method)).toContain("DELETE");
    expect(held()).toHaveLength(0);
    expect(outcomes()).toEqual(["open_timeout_no_fill"]);
  });
});

describe("an alert on the IBKR adapter: unsafe or unreachable bridge", () => {
  it("an account that isn't a paper account gets no order at all, and the bot is flagged", async () => {
    bridge.account = "U7654321";
    await run("bullish", "b1");
    expect(bridge.calls("/open_spread")).toHaveLength(0);
    expect(bridge.heldLegs()).toEqual([]);
    expect(outcomes()).toEqual(["executor_error"]);
    expect(decisionsStore.all().find((d) => d.outcome === "executor_error")?.reason).toMatch(/not a paper account/);
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ needsAttention: true });
  });

  it("Gateway not connected: no order, flagged", async () => {
    bridge.connected = false;
    await run("bullish", "b1");
    expect(bridge.calls("/open_spread")).toHaveLength(0);
    expect(decisionsStore.all().find((d) => d.outcome === "executor_error")?.reason).toMatch(/not connected/);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);
  });

  it("a wrong secret is refused by the bridge, and the error never repeats the secret", async () => {
    const wrong = new IbkrExecutor({ ...cfg, secret: "a-different-secret-entirely" }, bridge.fetch);
    await processSignal(alert("bullish", "b1", BASE_NOW), { executor: wrong, now: BASE_NOW, ...fast });
    expect(bridge.calls("/open_spread")).toHaveLength(0);
    const text = JSON.stringify([decisionsStore.all(), botsStore.all()]);
    expect(text).toMatch(/HTTP 401/);
    expect(text).not.toContain("a-different-secret-entirely");
    expect(text).not.toContain(SECRET);
  });

  it("the bridge going down as the order is sent leaves the open UNKNOWN: it blocks a second order and the retry job leaves it alone", async () => {
    bridge.down.add("open_spread");
    await run("bullish", "b1");
    expect(mine().map((p) => p.status)).toEqual(["opening"]);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);

    bridge.down.clear();
    await run("bullish", "b2", BASE_NOW + 5 * MIN);
    expect(bridge.calls("/open_spread")).toHaveLength(1); // the failed attempt only: nothing was sent again
    const r = await runEntryRetry(NDX_BOT_ID, BASE_NOW + 10 * MIN, { executor, price: async () => 21_003.7 });
    expect(r.retried).toBe(false);
    expect(bridge.calls("/open_spread")).toHaveLength(1);
  });
});

describe("after a restart, an order is read back from the bridge", () => {
  const stuck = (status: "opening" | "closing", ref: string | null) =>
    positionsStore.insert(buildPosition({ id: "pos-stuck", botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status, shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 1, filledQuantity: 0, credit: 3.5, ...(ref ? { brokerOrderRef: ref } : {}) }));

  it("an opening order that filled makes the position open", async () => {
    await run("bullish", "b1");
    const filledRef = bridge.calls("/open_spread").length ? "ib-1" : "";
    positionsStore.update(mine()[0].id, { status: "opening" });
    const results = await recoverInFlightPositions(executor);
    expect(results.map((r) => r.action)).toEqual(["opened"]);
    expect(positionsStore.get(mine()[0].id)).toMatchObject({ status: "open", filledQuantity: 1, credit: 3.3, brokerOrderRef: filledRef });
  });

  it("an order the bridge doesn't know is flagged for a person, never guessed", async () => {
    stuck("opening", "ib-404");
    const results = await recoverInFlightPositions(executor);
    expect(results.map((r) => r.action)).toEqual(["flagged"]);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);
  });

  it("an order still working is left alone and flagged", async () => {
    bridge.fill = "never";
    const { ref } = await executor.placeOpenOrder({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", positionType: "short_put_spread", shortStrike: 20_970, longStrike: 20_960, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06" });
    stuck("opening", ref);
    const results = await recoverInFlightPositions(executor);
    expect(results.map((r) => r.action)).toEqual(["flagged"]);
    expect(bridge.orders.get(ref)?.status).toBe("working"); // nothing was cancelled or changed
  });
});

describe("checking our records against the account", () => {
  it("finds a position we show that the account does not hold", async () => {
    positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 1, filledQuantity: 1 }));
    const r = await reconcile(executor);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.kind)).toEqual(["missing_at_broker", "missing_at_broker"]);
  });

  it("finds something the account holds that we have no record of", async () => {
    await run("bullish", "b1");
    positionsStore.update(mine()[0].id, { status: "closed", closedAt: BASE_NOW });
    const r = await reconcile(executor);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.kind)).toEqual(["unknown_at_broker", "unknown_at_broker"]);
  });

  it("a bridge that can't be reached is an error, not a clean report", async () => {
    bridge.down.add("positions");
    await expect(reconcile(executor)).rejects.toThrow(/HTTP 503/);
  });
});

describe("a close that gets stuck, and Resolve, end to end through the bridge", () => {
  const stuckPut = async () => {
    await run("bullish", "b1");
    bridge.unreachable.add("close_spread");
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    bridge.unreachable.clear();
    return mine()[0];
  };

  it("the bridge gave no answer to the close: the broker still holds the spread -> a repeat alert sends nothing and says to Resolve; Return to open puts it right and the next alert flips normally", async () => {
    const p = await stuckPut();
    expect(p.status).toBe("closing");
    const sentBefore = bridge.placed().length;
    await run("bearish", "b3", BASE_NOW + 10 * MIN);
    expect(bridge.placed().length).toBe(sentBefore); // no second close, no new side
    expect(outcomes().at(-1)).toBe("stuck_position");

    const a = await assessPosition(p.id, executor);
    expect(a).toMatchObject({ verdict: "holds_spread", actions: ["return_to_open"], held: { short: -1, long: 1 } });
    await resolvePosition(p.id, { action: "return_to_open", confirm: true }, executor, BASE_NOW + 11 * MIN);
    expect(positionsStore.get(p.id)?.status).toBe("open");
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(false);

    await run("bearish", "b4", BASE_NOW + 15 * MIN);
    expect(mine().map((x) => [x.type, x.status])).toEqual([["short_put_spread", "closed"], ["short_call_spread", "open"]]);
    expect(await reconcile(executor)).toMatchObject({ ok: true });
  });

  it("someone closed it by hand at the broker: the broker holds nothing -> Mark closed, with the price typed since no fill can be read", async () => {
    const p = await stuckPut();
    bridge.orders.clear(); // gone at the broker, and the bridge has forgotten its orders
    const a = await assessPosition(p.id, executor);
    expect(a).toMatchObject({ verdict: "holds_nothing", actions: ["mark_closed"], needsPrice: true });
    await expect(resolvePosition(p.id, { action: "mark_closed", confirm: true }, executor)).rejects.toThrow(/Enter the price/);
    const ordersSent = bridge.placed().length;
    await resolvePosition(p.id, { action: "mark_closed", confirm: true, price: 1.4 }, executor, BASE_NOW + 12 * MIN);
    expect(positionsStore.get(p.id)).toMatchObject({ status: "closed", closePrice: 1.4 });
    expect(bridge.placed().length).toBe(ordersSent); // Resolve itself sent nothing to the bridge
    expect(await reconcile(executor)).toMatchObject({ ok: true });
  });

  it("a close that never fills at any price: every rung is cancelled and confirmed, and the account still holding the spread puts the position back to open", async () => {
    await run("bullish", "b1");
    bridge.fill = "never";
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    const p = mine()[0];
    expect(outcomes().at(-1)).toBe("close_timeout");
    const closes = [...bridge.orders.values()].filter((o) => o.kind === "close");
    expect(closes.length).toBeGreaterThan(1);
    expect(closes.every((o) => o.status === "canceled")).toBe(true);
    expect(ordersStore.all().filter((o) => o.kind === "close").every((o) => o.status === "canceled")).toBe(true);
    expect(closes.every((o) => typeof o.body.limitDebit === "number")).toBe(true); // every rung a limit order

    // The broker confirmed every order over, and the account still shows the whole spread: so the position is back to open, not stuck.
    expect(positionsStore.get(p.id)?.status).toBe("open");
    expect(decisionsStore.all().find((d) => d.outcome === "close_timeout")?.reason).toMatch(/back to open/);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true); // still flagged: a person should look
    bridge.fill = "fill";
    // The Close position button works: a fresh, priced close that fills.
    const { manualClose } = await import("./engine");
    expect(await manualClose(p.id, { executor, ...fast })).toMatchObject({ ok: true, outcome: "closed" });
    expect(positionsStore.get(p.id)?.status).toBe("closed");
  });

  it("a position stuck in opening: the broker holds the spread -> Mark open at the size and the credit the broker's own order shows", async () => {
    await run("bullish", "b1");
    const p = mine()[0];
    positionsStore.update(p.id, { status: "opening", filledQuantity: 0, credit: null });
    const a = await assessPosition(p.id, executor);
    expect(a).toMatchObject({ verdict: "holds_spread", actions: ["mark_open"], fill: { price: 3.3, quantity: 1 } });
    await resolvePosition(p.id, { action: "mark_open", confirm: true }, executor);
    expect(positionsStore.get(p.id)).toMatchObject({ status: "open", filledQuantity: 1, credit: 3.3 });
  });

  it("when no quote is available the close is refused, the position stays open and the bridge is sent nothing", async () => {
    await run("bullish", "b1");
    const before = bridge.placed().length;
    bridge.spreadQuote = null;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(mine().map((x) => [x.type, x.status])).toEqual([["short_put_spread", "open"]]);
    expect(bridge.placed().length).toBe(before);
    expect(outcomes().at(-1)).toBe("close_no_quote");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// TradingView -> the webhook address -> the bot -> the bridge, with the price taken from the bridge as well.

describe("TradingView alert, through the webhook, on BROKER=ibkr with PRICE_SOURCE=broker", () => {
  let bull: ReturnType<typeof createWebhook>;
  let bear: ReturnType<typeof createWebhook>;
  let clock = 0;
  let day = 0;

  beforeAll(() => {
    // The live-price poller (started by the first quote lookup) keeps asking, so the fake stays installed for the rest of this file: it
    // answers 503 to anything that is not the bridge, and so nothing here can ever reach a network.
    globalThis.fetch = (async (url: string, init: Parameters<BridgeFetch>[1]) => {
      const res = await currentBridge().fetch(String(url), init);
      return res;
    }) as unknown as typeof fetch;
  });
  let live: FakeBridge;
  const currentBridge = () => live;

  const tradingView = async (hook: typeof bull) => {
    clock += 2 * MIN;
    vi.setSystemTime(clock);
    const res = await hookRoute(new NextRequest(`http://localhost/hook/${hook.token}`, { method: "POST", body: hook === bull ? "bullish" : "bearish", headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token: hook.token }) });
    // Finished when the log, the bridge's requests and the position rows have stopped changing for a moment.
    let last = "";
    let stable = 0;
    for (let i = 0; i < 300 && stable < 4; i++) {
      const now = `${decisionsStore.all().length}|${live.requests.length}|${signalsStore.all().length}|${mine().map((p) => p.status).join(",")}`;
      stable = now === last ? stable + 1 : 0;
      last = now;
      await new Promise((r) => setTimeout(r, 15));
    }
    return res;
  };

  beforeEach(() => {
    live = new FakeBridge();
    vi.stubEnv("BROKER", "ibkr");
    vi.stubEnv("BRIDGE_URL", BASE);
    vi.stubEnv("BRIDGE_SECRET", SECRET);
    vi.stubEnv("PRICE_SOURCE", "broker");
    vi.stubEnv("AUTOMATION_TEST_MODE", "");
    (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
    vi.useFakeTimers({ toFake: ["Date"] });
    // A new half hour for every test, always later than the one before: the live-price store remembers a quote for 15 seconds.
    clock = BASE_NOW - 2 * MIN + ++day * 30 * MIN;
    vi.setSystemTime(clock);
    bull = createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
    bear = createWebhook({ name: "BearishNDX", botId: NDX_BOT_ID, direction: "bearish" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  });

  it("a Bullish alert asks the bridge for the price, then opens the put spread on it, on a paper account", async () => {
    const res = await tradingView(bull);
    expect(res.status).toBe(200);
    expect(live.calls("/quote/ndx").length).toBeGreaterThan(0);
    expect(live.placed()).toEqual(["open PUT 20970/20960"]);
    expect(held().map((p) => [p.type, p.status, p.venue])).toEqual([["short_put_spread", "open", "ibkr"]]);
    expect(outcomes()).toEqual(["opened"]);
  });

  it("the strikes follow the BRIDGE's price", async () => {
    live.price = 21_503.7;
    await tradingView(bull);
    expect(live.placed()).toEqual(["open PUT 21470/21460"]);
  });

  it("a Bearish alert while holding the put spread flips it: close, then open the call spread", async () => {
    await tradingView(bull);
    await tradingView(bear);
    expect(live.placed()).toEqual(["open PUT 20970/20960", "close PUT 20970/20960", "open CALL 21035/21045"]);
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
    expect(await reconcile(new IbkrExecutor(cfg, live.fetch))).toMatchObject({ ok: true });
  });

  it("a bridge quote that is ten minutes old is no price: nothing is opened, and the call is logged as having no price", async () => {
    live.quoteAgeMs = 10 * MIN;
    await tradingView(bull);
    expect(live.calls("/open_spread")).toHaveLength(0);
    expect(held()).toHaveLength(0);
    expect(signalsStore.all().map((s) => [s.status, s.rejectReason])).toEqual([["rejected", "no_price"]]);
  });

  it("with the bridge down, there is no price and no order, and Google's price is not used instead", async () => {
    live.down.add("quote/ndx");
    await tradingView(bull);
    expect(live.calls("/open_spread")).toHaveLength(0);
    expect(held()).toHaveLength(0);
    expect(signalsStore.all().map((s) => s.rejectReason)).toEqual(["no_price"]);
  });

  it("an account that isn't a paper account: the price is read, but no order is sent and the bot is flagged", async () => {
    live.account = "U7654321";
    await tradingView(bull);
    expect(live.calls("/open_spread")).toHaveLength(0);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);
    expect(live.heldLegs()).toEqual([]);
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// A close that failed, and the next one: fresh order ids, failures before an order exists, and what the broker said.
// ---------------------------------------------------------------------------------------------------------------------------------
describe("a failed close, and the next close", () => {
  const closeRequests = () => bridge.calls("/close_spread");
  const closeIds = () => closeRequests().map((r) => r.body?.clientOrderId as string);
  const manual = (id: string, now = BASE_NOW + 8 * MIN) => manualClose(id, { executor, now, ...fast });
  const openPut = async () => {
    await run("bullish", "b1");
    return mine()[0];
  };

  it("the second manual Close after a failed first one is sent under a new id, so the bridge does not refuse it (the 409 bug)", async () => {
    const p = await openPut();
    bridge.fill = "cancelNow"; // the first close is sent at one price and ends canceled
    await manual(p.id);
    expect(positionsStore.get(p.id)?.status).toBe("open"); // the account still holds the spread
    const firstIds = closeIds();
    expect(firstIds.length).toBeGreaterThan(0);

    bridge.fill = "fill";
    bridge.spreadQuote = { short: { bid: 11, ask: 11.4 }, long: { bid: 8.7, ask: 9.3 } }; // a different price now: the same id would be refused with 409
    const second = await manual(p.id, BASE_NOW + 9 * MIN);
    expect(second.ok).toBe(true);
    expect(positionsStore.get(p.id)?.status).toBe("closed");
    expect(bridge.requests.filter((r) => r.path === "/close_spread" && r.body?.clientOrderId === firstIds[0])).toHaveLength(1);
    const all = closeIds();
    expect(new Set(all).size).toBe(all.length); // no id was ever sent twice
    expect(all.at(-1)).toBe(`${p.id}:close:2:1`);
    expect(firstIds[0]).toBe(`${p.id}:close:1:1`);
    expect(positionsStore.get(p.id)?.closeAttempts).toBe(2);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).not.toMatch(/HTTP 409/);
  });

  it("the bridge itself refuses an id sent again with a different order (so a reused id would have failed), and that refusal is a 'not placed' one", async () => {
    const p = await openPut();
    bridge.fill = "never"; // the first order just sits there, so the account still holds the spread for the second
    const send = (limitDebit: number) => executor.placeCloseOrder(p, { clientOrderId: "same-id", limitDebit, quantity: 1 });
    const first = await send(1.2);
    expect((await send(1.2)).ref).toBe(first.ref); // the identical request again (a network retry) gives the same order back
    const err = await send(1.3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect((err as Error).message).toMatch(/HTTP 409.*clientOrderId was already used with a different order/);
    expect((err as OrderNotPlacedError).needsResolve).toBe(false);
  });

  it("an automated close (a flip alert) after a failed one also gets a new id", async () => {
    const p = await openPut();
    bridge.down.add("close_spread"); // the first flip's close is refused with 503
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(positionsStore.get(p.id)?.status).toBe("open");
    bridge.down.clear();
    await run("bearish", "b3", BASE_NOW + 10 * MIN);
    const ids = closeIds();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(`${p.id}:close:1:1`);
    expect(ids[1]).toBe(`${p.id}:close:2:1`);
    expect(mine().map((x) => [x.type, x.status])).toEqual([["short_put_spread", "closed"], ["short_call_spread", "open"]]);
  });

  it("the attempt count is saved on the position, so it survives a restart: a new run of the app does not start over at 1", async () => {
    const p = await openPut();
    bridge.fill = "cancelNow";
    await manual(p.id);
    const saved = positionsStore.get(p.id)?.closeAttempts;
    expect(saved).toBe(1);
    executor = new IbkrExecutor(cfg, bridge.fetch); // a fresh process: no memory of the first attempt
    bridge.fill = "fill";
    await manual(p.id, BASE_NOW + 9 * MIN);
    expect(closeIds().at(-1)).toBe(`${p.id}:close:2:1`);
  });

  for (const [name, setup, words] of [
    ["503 (Gateway or bridge unavailable)", (b: FakeBridge) => b.down.add("close_spread"), /HTTP 503.*bridge unavailable/],
    ["422 (the bridge refuses the order)", (b: FakeBridge) => b.refuse.set("close_spread", { status: 422, body: { detail: "market orders are not accepted" } }), /HTTP 422.*market orders are not accepted/],
    ["409 (an id used before)", (b: FakeBridge) => b.refuse.set("close_spread", { status: 409, body: { detail: "clientOrderId was already used with a different order" } }), /HTTP 409.*already used with a different order/],
  ] as const) {
    it(`a manual close the bridge refuses with ${name} puts the position back to open, with the bridge's words in the Log`, async () => {
      const p = await openPut();
      setup(bridge);
      const res = await manual(p.id);
      expect(res.ok).toBe(false);
      expect(positionsStore.get(p.id)?.status).toBe("open"); // never left "closing"
      expect(closeRequests()).toHaveLength(1);
      const d = decisionsStore.all().find((x) => x.signalId === null && x.outcome === "executor_error");
      expect(d?.reason).toMatch(/Close order not placed/);
      expect(d?.reason).toMatch(words);
      expect(d?.reason).toMatch(/back to open/);
      const node = runsStore.all().flatMap((r) => r.nodes).find((n) => n.kind === "action" && n.action === "close");
      expect(node && node.kind === "action" ? node.reason : "").toMatch(words);
      expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true); // the person still sees it
      // and the next press works once the cause is gone
      bridge.down.clear();
      bridge.refuse.clear();
      expect((await manual(p.id, BASE_NOW + 9 * MIN)).ok).toBe(true);
    });
  }

  it("a close with no answer at all (a dropped connection) is NOT put back: the order may exist, so it stays 'closing' for Resolve", async () => {
    const p = await openPut();
    bridge.unreachable.add("close_spread");
    await manual(p.id);
    expect(positionsStore.get(p.id)?.status).toBe("closing");
  });

  it("a close the account cannot honour (it does not hold the spread) stays 'closing' for Resolve, as before", async () => {
    const p = await openPut();
    bridge.orders.clear();
    await manual(p.id);
    expect(positionsStore.get(p.id)?.status).toBe("closing");
    expect(closeRequests()).toHaveLength(0);
  });

  it("a quote that fails before the close is priced leaves the position open and sends nothing", async () => {
    const p = await openPut();
    bridge.spreadQuote = null;
    await manual(p.id);
    expect(positionsStore.get(p.id)?.status).toBe("open");
    expect(closeRequests()).toHaveLength(0);
    expect(decisionsStore.all().at(-1)?.outcome).toBe("close_no_quote");
  });

  it("a position that was already 'closing' stays 'closing' when a retry is refused (it was stuck before, Resolve is still its way out)", async () => {
    const p = await openPut();
    bridge.unreachable.add("close_spread");
    await manual(p.id);
    bridge.unreachable.clear();
    expect(positionsStore.get(p.id)?.status).toBe("closing");
    bridge.refuse.set("close_spread", { status: 422, body: { detail: "refused" } });
    await manual(p.id, BASE_NOW + 9 * MIN);
    expect(positionsStore.get(p.id)?.status).toBe("closing");
  });
});

describe("a close that ends canceled says what the broker said", () => {
  const manual = (id: string) => manualClose(id, { executor, now: BASE_NOW + 8 * MIN, ...fast });
  const closeNode = () => {
    const n = runsStore.all().flatMap((r) => r.nodes).find((x) => x.kind === "action" && x.action === "close");
    return n && n.kind === "action" ? n : null;
  };
  const trail = {
    ibkrStatus: "Cancelled",
    permId: 98765,
    events: [
      { time: "14:02:10", status: "PendingSubmit" },
      { time: "14:02:11", status: "Submitted" },
      { time: "14:02:12", status: "Cancelled", code: 202, message: "Order Canceled - reason: price too far from the market" },
    ],
  };

  it("the reason, price band and last events are in the Log entry and stored on the order row", async () => {
    await run("bullish", "b1");
    const p = mine()[0];
    bridge.fill = "cancelNow";
    bridge.endExtras = { rejectReason: "Order Canceled - reason: price too far from the market", priceBand: { marketPrice: 1.1, edge: 1.6 }, ...trail };
    await manual(p.id);

    const rows = ordersStore.all().filter((o) => o.kind === "close");
    expect(rows.length).toBeGreaterThan(0);
    for (const o of rows) {
      expect(o).toMatchObject({ status: "canceled", rejectReason: "Order Canceled - reason: price too far from the market", priceBand: { marketPrice: 1.1, edge: 1.6 }, ibkrStatus: "Cancelled", permId: 98765 });
      expect(o.events).toHaveLength(3);
      expect(o.events?.[2]).toEqual({ time: "14:02:12", status: "Cancelled", code: 202, message: "Order Canceled - reason: price too far from the market" });
    }
    const d = decisionsStore.all().find((x) => x.signalId === null && x.outcome.startsWith("close_"));
    expect(d?.reason).toMatch(/too far through its market \(the market is 1\.10/);
    expect(d?.reason).toMatch(/price too far from the market/);
    expect(d?.reason).toMatch(/IBKR status Cancelled \(permId 98765\)/);
    expect(d?.reason).toMatch(/last events: 14:02:10 PendingSubmit; 14:02:11 Submitted; 14:02:12 Cancelled \[202\] "Order Canceled/);
    const steps = (closeNode()?.steps ?? []).join(" | ");
    expect(steps).toMatch(/refused by the broker's price band/);
    expect(steps).toMatch(/IBKR status Cancelled \(permId 98765\)/);
    expect(positionsStore.get(p.id)?.status).toBe("open");
  });

  it("a cancel with a reason and a trail but no price band is worded the same way, in the steps and in the entry", async () => {
    await run("bullish", "b1");
    const p = mine()[0];
    bridge.fill = "cancelNow";
    bridge.endExtras = { rejectReason: "Order Canceled - reason: Gateway cancelled it", ...trail };
    await manual(p.id);
    const d = decisionsStore.all().find((x) => x.signalId === null && x.outcome === "close_timeout");
    expect(d?.reason).toMatch(/Close order ended without filling\. The broker's words: Order Canceled - reason: Gateway cancelled it IBKR status Cancelled \(permId 98765\); last events: .*Cancelled \[202\]/);
    expect((closeNode()?.steps ?? []).join(" ")).toMatch(/ended without a fill\. The broker's words: .*IBKR status Cancelled/);
  });

  it("a cancel the broker explains nothing about is said plainly, never left blank", async () => {
    await run("bullish", "b1");
    const p = mine()[0];
    bridge.fill = "cancelNow";
    await manual(p.id);
    const d = decisionsStore.all().find((x) => x.signalId === null && x.outcome === "close_timeout");
    expect(d?.reason).toMatch(/The broker gave no reason, price band or events\./);
    expect((closeNode()?.steps ?? []).join(" ")).toMatch(/The broker gave no reason, price band or events\./);
  });

  it("a rejected close shows the rejection and the trail", async () => {
    await run("bullish", "b1");
    const p = mine()[0];
    bridge.fill = "reject";
    bridge.endExtras = trail;
    await manual(p.id);
    const d = decisionsStore.all().find((x) => x.signalId === null && x.outcome === "close_rejected");
    expect(d?.reason).toMatch(/Insufficient/);
    expect(d?.reason).toMatch(/IBKR status Cancelled \(permId 98765\)/);
    expect(ordersStore.all().find((o) => o.kind === "close")).toMatchObject({ status: "rejected", permId: 98765 });
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// REHEARSAL close chase (CLOSE_CHASE_MAX): after a close ladder's top price fails to fill, more prices above the quote's worst price.
// The fake quote makes the close ladder 3.30, 3.50, 3.70, 3.90 (mid 3.30, worst price 3.90) on a spread 10 wide.
// ---------------------------------------------------------------------------------------------------------------------------------
describe("the rehearsal close chase", () => {
  const LADDER = [3.3, 3.5, 3.7, 3.9];
  const closePrices = () => bridge.calls("/close_spread").map((r) => Number(r.body?.limitDebit));
  const manual = (id: string) => manualClose(id, { executor, now: BASE_NOW + 8 * MIN, ...fast });
  const closeSteps = () => {
    const n = runsStore.all().flatMap((r) => r.nodes).filter((x) => x.kind === "action" && x.action === "close").at(-1);
    return n && n.kind === "action" ? (n.steps ?? []) : [];
  };
  const openPut = async () => {
    await run("bullish", "b1");
    bridge.closeFillAtOrAbove = 99; // nothing fills at any price below 99 unless a test says otherwise
    return mine()[0];
  };
  afterEach(() => vi.unstubAllEnvs());

  it("is off by default: the close ladder ends at its top price, as before", async () => {
    const p = await openPut();
    await manual(p.id);
    expect(closePrices()).toEqual(LADDER);
    expect(closeSteps().join(" ")).not.toMatch(/chase/i);
    expect(positionsStore.get(p.id)?.status).toBe("open");
  });

  it("CLOSE_CHASE_MAX=0 is off too, and so is a value that is not a number", async () => {
    for (const v of ["0", "nonsense", "-1"]) {
      resetAutomationStores();
      setNdxTestEnv();
      bridge = new FakeBridge();
      executor = new IbkrExecutor(cfg, bridge.fetch);
      ensureBotRecord(NDX_BOT_ID);
      vi.stubEnv("CLOSE_CHASE_MAX", v);
      const p = await openPut();
      await manual(p.id);
      expect(closePrices()).toEqual(LADDER);
    }
  });

  it("on and a paper account: more prices follow the top price, in the same step, up to the worst price plus the maximum", async () => {
    vi.stubEnv("CLOSE_CHASE_MAX", "1");
    const p = await openPut();
    await manual(p.id);
    expect(closePrices()).toEqual([...LADDER, 4.1, 4.3, 4.5, 4.7, 4.9]); // the worst price 3.90 + 1.00 = 4.90 at most
    const steps = closeSteps().join("\n");
    expect(steps).toMatch(/Rehearsal chase \(CLOSE_CHASE_MAX \$1\.00, paper account\).*4\.10, 4\.30, 4\.50, 4\.70, 4\.90/);
    expect(steps).toMatch(/Price 5 of 9 \(rehearsal chase\): \$4\.10/);
    expect(steps).toMatch(/Price 9 of 9 \(rehearsal chase\): \$4\.90/);
    expect(steps).not.toMatch(/Price 4 of 9 \(rehearsal chase\)/); // the ladder's own top price is not a chase rung
    // waits: the ladder's top price keeps its full final wait (100ms here), the chase rungs wait a step (20ms), the very last the full final wait
    expect(steps).toMatch(/Price 4 of 9: \$3\.90, waited up to 100ms/);
    expect(steps).toMatch(/Price 5 of 9 \(rehearsal chase\): \$4\.10, waited up to 20ms/);
    expect(steps).toMatch(/Price 9 of 9 \(rehearsal chase\): \$4\.90, waited up to 100ms/);
    expect(steps).not.toMatch(/Price 1 of 9 \(rehearsal chase\)/);
    expect(positionsStore.get(p.id)?.status).toBe("open"); // never filled: the account still holds it
  });

  it("on and NOT a paper account (the bridge's /health says paper is false): the setting is ignored, and the Log says so", async () => {
    vi.stubEnv("CLOSE_CHASE_MAX", "3");
    bridge.paperOverride = false;
    const p = await openPut();
    await manual(p.id);
    expect(closePrices()).toEqual(LADDER);
    expect(closeSteps().join(" ")).toMatch(/Rehearsal chase: CLOSE_CHASE_MAX is \$3\.00 but it is ignored, because the bridge does not say this is a paper account/);
    expect(closeSteps().join(" ")).not.toMatch(/\(rehearsal chase\)/);
  });

  it("on and /health cannot be read: ignored the same way (never assumed to be paper)", async () => {
    vi.stubEnv("CLOSE_CHASE_MAX", "3");
    const p = await openPut();
    const real = executor.isPaperAccount.bind(executor);
    vi.spyOn(executor, "isPaperAccount").mockImplementation(async () => {
      bridge.unreachable.add("health");
      try {
        return await real();
      } finally {
        bridge.unreachable.delete("health");
      }
    });
    await manual(p.id);
    expect(closePrices()).toEqual(LADDER);
    expect(closeSteps().join(" ")).toMatch(/ignored, because the bridge does not say this is a paper account/);
  });

  it("is never at or above the spread's width: a huge maximum stops under it", async () => {
    vi.stubEnv("CLOSE_CHASE_MAX", "50");
    const p = await openPut();
    await manual(p.id);
    const prices = closePrices();
    expect(prices.slice(0, 4)).toEqual(LADDER);
    expect(prices.length).toBeGreaterThan(8);
    expect(prices.every((x) => x < 10)).toBe(true); // the spread is 10 wide
    expect(Math.max(...prices)).toBe(9.9);
    expect(prices.every((x, i) => i === 0 || x > prices[i - 1])).toBe(true);
  });

  it("a price band refusal during the chase still re-prices inside the band", async () => {
    vi.stubEnv("CLOSE_CHASE_MAX", "3");
    bridge.band = { edge: 4.5, marketPrice: 4.0 }; // IBKR refuses 4.50 and above, and says the market is 4.00
    const p = await openPut();
    await manual(p.id);
    const prices = closePrices();
    const at = prices.indexOf(4.5);
    expect(at).toBeGreaterThan(3); // reached on the chase, after the ladder's own four
    const after = prices.slice(at + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((x) => x < 4.5)).toBe(true); // nothing at or above the edge is sent again
    expect(Math.max(...after)).toBeLessThanOrEqual(4.4); // the highest tick below the edge
    expect(Math.max(...after)).toBeGreaterThan(3.9); // inside the band but above the ladder's own top price: the chase's limit, not the ladder's, bounds it
    expect(prices.filter((x) => x >= 4.5)).toEqual([4.5]); // refused once, not argued with
    const steps = closeSteps().join("\n");
    expect(steps).toMatch(/\(rehearsal chase\): \$4\.50 - refused by the broker's price band \(the market is 4\.00, it will not take 4\.50 or beyond\).*re-priced to/);
  });

  it("the cap above the broker's market price still applies after a band refusal during the chase", async () => {
    vi.stubEnv("CLOSE_CHASE_MAX", "3");
    vi.stubEnv("CLOSE_MAX_ABOVE_MARKET", "0.2");
    bridge.band = { edge: 4.9, marketPrice: 4.0 };
    const p = await openPut();
    await manual(p.id);
    const prices = closePrices();
    const at = prices.indexOf(4.9);
    expect(at).toBeGreaterThan(3);
    const after = prices.slice(at + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(Math.max(...after)).toBeLessThanOrEqual(4.2); // market 4.00 + 0.20, though the edge would have allowed 4.80
  });

  it("a band refusal BEFORE the chase hands the rest of the ladder to the broker's numbers: no chase follows it", async () => {
    vi.stubEnv("CLOSE_CHASE_MAX", "3");
    bridge.band = { edge: 3.7, marketPrice: 3.5 };
    const p = await openPut();
    await manual(p.id);
    const prices = closePrices();
    expect(prices.slice(0, 3)).toEqual([3.3, 3.5, 3.7]);
    expect(prices.slice(3).every((x) => x < 3.7)).toBe(true);
    expect(Math.max(...prices.slice(3))).toBeLessThanOrEqual(3.6);
    expect(closeSteps().join(" ")).not.toMatch(/Price \d+ of \d+ \(rehearsal chase\)/);
  });

  it("a fill on a chase rung closes the position and the Log names the rung and the final price", async () => {
    vi.stubEnv("CLOSE_CHASE_MAX", "1");
    const p = await openPut();
    bridge.closeFillAtOrAbove = 4.3; // the market is above the delayed quote's worst price: only the second chase rung is high enough
    const res = await manual(p.id);
    expect(res.ok).toBe(true);
    expect(closePrices()).toEqual([...LADDER, 4.1, 4.3]);
    expect(positionsStore.get(p.id)).toMatchObject({ status: "closed", closePrice: 4.3 });
    const d = decisionsStore.all().find((x) => x.signalId === null && x.outcome === "closed");
    expect(d?.reason).toMatch(/Filled on rehearsal chase rung 2 \(price 6 of 9\) at the final price of \$4\.30/);
    const steps = closeSteps().join("\n");
    expect(steps).toMatch(/Price 6 of 9 \(rehearsal chase\): \$4\.30.*Filled on rehearsal chase rung 2 at \$4\.30/);
    expect(steps).toMatch(/Price 5 of 9 \(rehearsal chase\): \$4\.10.*not filled in time, canceled/);
  });

  it("a fill on a rung of the ladder itself is not called a chase", async () => {
    vi.stubEnv("CLOSE_CHASE_MAX", "1");
    const p = await openPut();
    bridge.closeFillAtOrAbove = 3.7;
    const res = await manual(p.id);
    expect(res.ok).toBe(true);
    expect(closePrices()).toEqual([3.3, 3.5, 3.7]);
    expect(decisionsStore.all().find((x) => x.outcome === "closed")?.reason).not.toMatch(/chase/i);
  });

  it("the close inside a flip is not chased, and an open is never chased", async () => {
    vi.stubEnv("CLOSE_CHASE_MAX", "3");
    bridge.fill = "never";
    await run("bullish", "b1"); // the open ladder: nothing fills, so it walks all its prices
    const opens = bridge.calls("/open_spread").map((r) => Number(r.body?.limitCredit));
    expect(opens).toHaveLength(4);
    expect(closeSteps()).toEqual([]);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).not.toMatch(/chase/i);

    // a position that is held, and a flip alert whose close does not fill
    resetAutomationStores();
    setNdxTestEnv();
    bridge = new FakeBridge();
    executor = new IbkrExecutor(cfg, bridge.fetch);
    ensureBotRecord(NDX_BOT_ID);
    await run("bullish", "b1");
    bridge.closeFillAtOrAbove = 99;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(closePrices()).toEqual(LADDER);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).not.toMatch(/chase/i);
  });

  it("the simulation (no real broker) has no chase to run", () => {
    expect((new MockExecutor() as { isPaperAccount?: unknown }).isPaperAccount).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// The flip, as a state machine: every starting state x every signal, then long random runs of alerts - with and without things going wrong -
// checking after EVERY alert the rules that must always hold.
// ---------------------------------------------------------------------------------------------------------------------------------
describe("the flip: every state and every signal", () => {
  const active = () => mine().filter((p) => p.status === "open" || p.status === "opening" || p.status === "closing");
  const legsBy = (kind: "PUT" | "CALL") => bridge.placed().filter((x) => x.includes(kind));

  const cases: Array<{ start: "none" | "put" | "call"; signal: "bullish" | "bearish"; orders: string[]; end: string[] }> = [
    { start: "none", signal: "bullish", orders: ["open PUT 20970/20960"], end: ["short_put_spread:open"] },
    { start: "none", signal: "bearish", orders: ["open CALL 21035/21045"], end: ["short_call_spread:open"] },
    { start: "put", signal: "bullish", orders: [], end: ["short_put_spread:open"] },
    { start: "call", signal: "bearish", orders: [], end: ["short_call_spread:open"] },
    { start: "put", signal: "bearish", orders: ["close PUT 20970/20960", "open CALL 21035/21045"], end: ["short_put_spread:closed", "short_call_spread:open"] },
    { start: "call", signal: "bullish", orders: ["close CALL 21035/21045", "open PUT 20970/20960"], end: ["short_call_spread:closed", "short_put_spread:open"] },
  ];

  for (const c of cases) {
    it(`holding ${c.start === "none" ? "nothing" : `the ${c.start} spread`}, a ${c.signal} alert sends exactly: ${c.orders.length ? c.orders.join(", then ") : "no order"}`, async () => {
      if (c.start !== "none") {
        await run(c.start === "put" ? "bullish" : "bearish", "s0", BASE_NOW);
        bridge.requests.length = 0;
      }
      await run(c.signal, "s1", BASE_NOW + 5 * MIN);
      expect(bridge.placed()).toEqual(c.orders);
      expect(mine().map((p) => `${p.type}:${p.status}`)).toEqual(c.end);
      expect(active()).toHaveLength(1);
      expect(await reconcile(executor)).toMatchObject({ ok: true, problems: [] });
      expect(legsBy("PUT").length + legsBy("CALL").length).toBe(c.orders.length);
    });
  }

  it("outside the trading window (9:35am - 3:55pm New York) an alert does nothing at all, a flip's close included", async () => {
    await run("bullish", "s0", BASE_NOW);
    bridge.requests.length = 0;
    const late = Date.UTC(2026, 9, 6, 20, 30); // 4:30pm New York
    await run("bearish", "s1", late);
    expect(bridge.placed()).toEqual([]);
    expect(mine().map((p) => `${p.type}:${p.status}`)).toEqual(["short_put_spread:open"]);
    expect(outcomes().at(-1)).toBe("outside_hours");
    const early = Date.UTC(2026, 9, 7, 13, 0); // 9:00am New York
    await run("bearish", "s2", early);
    expect(bridge.placed()).toEqual([]);
  });

  it("the kill switch stops everything, closes included; switching it off again lets the next alert flip normally", async () => {
    await run("bullish", "s0", BASE_NOW);
    botsStore.update(NDX_BOT_ID, { killSwitch: true });
    bridge.requests.length = 0;
    await run("bearish", "s1", BASE_NOW + 5 * MIN);
    expect(bridge.placed()).toEqual([]);
    botsStore.update(NDX_BOT_ID, { killSwitch: false });
    await run("bearish", "s2", BASE_NOW + 10 * MIN);
    expect(bridge.placed()).toEqual(["close PUT 20970/20960", "open CALL 21035/21045"]);
  });

  it("a duplicate alert (the same bar sent twice, or the same text inside two minutes) trades once", async () => {
    await run("bullish", "s0", BASE_NOW);
    await run("bullish", "s0", BASE_NOW + 10_000);
    await run("bearish", "s1", BASE_NOW + 5 * MIN);
    await run("bearish", "s1", BASE_NOW + 5 * MIN + 20_000);
    expect(bridge.placed()).toEqual(["open PUT 20970/20960", "close PUT 20970/20960", "open CALL 21035/21045"]);
    expect(outcomes()).toEqual(["opened", "duplicate_signal", "closed", "opened", "duplicate_signal"]); // each repeat is logged as a duplicate
  });
});

/** A small deterministic random generator, so a failing run can be repeated exactly. */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

describe("the flip, over long random runs of alerts", () => {
  const active = () => mine().filter((p) => p.status === "open" || p.status === "opening" || p.status === "closing");
  const sideOf = (p: { type: string }) => (p.type === "short_put_spread" ? "put" : "call");
  const lift = () => botsStore.update(NDX_BOT_ID, { safeguards: { dailyNewPositionLimit: 100_000 } });

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: 60 random alerts, every one filled: exactly one position held, always the side the last alert asked for, account and records agree`, async () => {
      lift();
      const next = rng(seed);
      let lastWanted: "put" | "call" | null = null;
      let changes = 0;
      for (let i = 0; i < 60; i++) {
        const dir = next() < 0.5 ? "bullish" : "bearish";
        const wanted = dir === "bullish" ? "put" : "call";
        if (lastWanted !== null && wanted !== lastWanted) changes++;
        const before = bridge.placed().length;
        await run(dir, `r${seed}-${i}`, BASE_NOW + i * 3 * MIN);
        lastWanted = wanted;
        const held = active();
        expect(held).toHaveLength(1);
        expect(sideOf(held[0])).toBe(wanted);
        expect(held[0].status).toBe("open");
        // the account holds exactly this spread: two legs, one right
        const legs = bridge.heldLegs();
        expect(legs).toHaveLength(2);
        expect(new Set(legs.map((l) => l.symbol.slice(11, 12))).size).toBe(1); // all puts or all calls
        // a repeat of the side already held sends nothing; a change sends one close and one open
        const sent = bridge.placed().length - before;
        expect([0, 1, 2]).toContain(sent);
      }
      const requests = bridge.requests.filter((r) => r.path === "/open_spread" || r.path === "/close_spread");
      expect(requests.filter((r) => r.path === "/close_spread")).toHaveLength(changes);
      const ids = requests.map((r) => r.body?.clientOrderId as string);
      expect(new Set(ids).size).toBe(ids.length); // no order id ever repeated
      expect(await reconcile(executor)).toMatchObject({ ok: true, problems: [] });
      expect(botsStore.get(NDX_BOT_ID)?.needsAttention ?? false).toBe(false);
      expect(botsStore.get(NDX_BOT_ID)?.enabled).toBe(true);
    });
  }

  for (const seed of [11, 12, 13, 14, 15, 16]) {
    it(`seed ${seed}: 60 random alerts with random failures (refused, unreachable, never filled): never two positions, never both sides at the broker, never an open on top of an unclosed one`, async () => {
      lift();
      const next = rng(seed);
      for (let i = 0; i < 60; i++) {
        const dir = next() < 0.5 ? "bullish" : "bearish";
        const roll = next();
        // sometimes break one thing for this alert only
        if (roll < 0.1) bridge.down.add("close_spread");
        else if (roll < 0.17) bridge.down.add("open_spread");
        else if (roll < 0.22) bridge.unreachable.add("close_spread");
        else if (roll < 0.27) bridge.refuse.set("close_spread", { status: 422, body: { detail: "refused" } });
        else if (roll < 0.32) bridge.closeFillAtOrAbove = 99;
        else if (roll < 0.36) bridge.fill = "never";
        else if (roll < 0.4) bridge.fill = "reject";
        await run(dir, `f${seed}-${i}`, BASE_NOW + i * 3 * MIN);
        bridge.down.clear();
        bridge.unreachable.clear();
        bridge.refuse.clear();
        bridge.closeFillAtOrAbove = null;
        bridge.fill = "fill";

        const held = active();
        expect(held.length).toBeLessThanOrEqual(1); // never two positions at once
        const legs = bridge.heldLegs();
        expect(legs.length).toBeLessThanOrEqual(2); // never more than one spread at the broker
        if (legs.length > 0) expect(new Set(legs.map((l) => l.symbol.slice(11, 12))).size).toBe(1); // never puts and calls together
        for (const p of held) if (p.status === "open") expect(legs.length).toBe(2); // an "open" position is really held
        // something unresolved is never silent
        if (held.some((p) => p.status === "closing" || p.status === "opening")) expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);
        // a flip never opens the new side while the old one might still be held: a stuck close means no other position exists
        if (held.some((p) => p.status === "closing")) expect(held).toHaveLength(1);
        if (botsStore.get(NDX_BOT_ID)?.enabled === false) botsStore.update(NDX_BOT_ID, { enabled: true });
      }
    });
  }
});
