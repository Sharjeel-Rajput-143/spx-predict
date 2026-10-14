import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as hookRoute } from "@/app/api/webhook/hook/[token]/route";
import { ensureBotRecord } from "./bots";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { runEntryRetry } from "./entryRetry";
import { IbkrExecutor, type BridgeFetch, type IbkrConfig } from "./ibkrExecutor";
import { reconcile } from "./reconcile";
import { recoverInFlightPositions } from "./recovery";
import { botsStore, decisionsStore, ordersStore, positionsStore, signalsStore } from "./store";
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
}

class FakeBridge {
  account = "DU1234567";
  connected = true;
  price = 21_003.7;
  /** How old the index quote is, in ms. */
  quoteAgeMs = 1_000;
  /** What a new order does: fill at once, be rejected, or sit working forever. */
  fill: "fill" | "reject" | "never" = "fill";
  /** Paths (without the leading slash) that answer 503. */
  down = new Set<string>();
  /** Fill price used for closes (a debit). */
  closeDebit = 1.2;
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

    if (path === "/health") return reply(200, { connected: this.connected, account: this.account, paper: this.account.startsWith("DU") });
    if (path === "/quote/ndx") return reply(200, { price: this.price, asOf: Date.now() - this.quoteAgeMs });
    if (path === "/quote/spread") return reply(200, {});
    if (path === "/positions") return reply(200, { positions: this.heldLegs() });
    if (path === "/open_spread" || path === "/close_spread") {
      const clientOrderId = typeof body?.clientOrderId === "string" ? body.clientOrderId : null;
      const repeat = clientOrderId ? [...this.orders.values()].find((o) => o.clientOrderId === clientOrderId) : undefined;
      if (repeat) return reply(200, { ref: repeat.ref });
      const order: BridgeOrder = { ref: `ib-${++this.n}`, clientOrderId, kind: path === "/open_spread" ? "open" : "close", body: body ?? {}, status: "working", filledQuantity: 0 };
      if (this.fill === "fill") {
        order.status = "filled";
        order.filledQuantity = Number(body?.quantity);
        order.averagePrice = order.kind === "open" ? Number(body?.limitCredit) : Number(body?.limitDebit ?? this.closeDebit);
      } else if (this.fill === "reject") order.status = "rejected";
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
      return reply(200, { status: order.status, filledQuantity: order.filledQuantity, ...(order.averagePrice !== undefined && order.filledQuantity > 0 ? { averagePrice: order.averagePrice } : {}), ...(order.status === "rejected" ? { rejectReason: "Insufficient margin" } : {}) });
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
const fast = { closeConfirmTimeoutMs: 100, orderFillTimeoutMs: 100, pollIntervalMs: 5 };
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
    expect(bridge.calls("/open_spread")[0].body).toMatchObject({ underlying: "NDX", root: "NDXP", type: "short_put_spread", quantity: 1, limitCredit: 3.5, tif: "DAY" });
    expect(bridge.requests.every((r) => r.secret === SECRET)).toBe(true);
    const [p] = held();
    expect(p).toMatchObject({ type: "short_put_spread", status: "open", shortStrike: 20_970, longStrike: 20_960, filledQuantity: 1, credit: 3.5, venue: "ibkr", brokerOrderRef: "ib-1" });
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

describe("an alert on the IBKR adapter: flip", () => {
  it("closes the put spread first, waits for that fill, then opens the call spread", async () => {
    await run("bullish", "b1");
    await run("bearish", "b2", BASE_NOW + 5 * MIN);

    expect(bridge.placed()).toEqual(["open PUT 20970/20960", "close PUT 20970/20960", "open CALL 21035/21045"]);
    const close = bridge.calls("/close_spread")[0].body!;
    expect(close).toMatchObject({ positionId: mine()[0].id, quantity: 1, orderType: "market", tif: "DAY" });
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
    expect(ids[1]).toBe(`${s2.id}:close:${mine()[0].id}:1`);
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
    bridge.down.add("close_spread");
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
    const [order] = [...bridge.orders.values()];
    expect(order.status).toBe("canceled");
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
    expect(positionsStore.get(mine()[0].id)).toMatchObject({ status: "open", filledQuantity: 1, credit: 3.5, brokerOrderRef: filledRef });
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
