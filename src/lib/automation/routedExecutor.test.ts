import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import { bridgeSymbols } from "./executorKind";
import { reconcile } from "./reconcile";
import { RoutedExecutor, SIMULATION_REF_PREFIX } from "./routedExecutor";
import { positionsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, TEST_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import type { BrokerExecutor, BrokerPosition, CloseOrderOptions, OpenSpreadRequest, OrderState, Position, SignalDirection } from "./types";
import type { LegQuotes } from "./smartPricing";

// The bridge to IBKR takes NDX only. A bot on another underlying (SPX) must keep running - on the internal simulation, labelled as such -
// and must never be sent to the bridge, while NDX behaves exactly as before.

setTestBotEnv();
setNdxTestEnv();

/** Stands in for the IBKR bridge: limit-only, records every call, fills at once. */
class FakeBridge implements BrokerExecutor {
  readonly venue = "ibkr" as const;
  readonly limitOnly = true;
  calls: string[] = [];
  held: BrokerPosition[] = [];
  quotes: LegQuotes = { short: { bid: 12, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } };
  private n = 0;
  async placeOpenOrder(r: OpenSpreadRequest) {
    this.calls.push(`open ${r.underlying} ${r.limitCredit}`);
    return { ref: `ib-${++this.n}` };
  }
  async placeCloseOrder(p: Position, o?: CloseOrderOptions) {
    this.calls.push(`close ${p.underlying} ${o?.limitDebit}`);
    return { ref: `ib-${++this.n}` };
  }
  async getOrder(ref: string): Promise<OrderState> {
    this.calls.push(`get ${ref}`);
    return { status: "filled", filledQuantity: 1, averagePrice: 3.3 };
  }
  async cancelOrder(ref: string) {
    this.calls.push(`cancel ${ref}`);
  }
  async listPositions() {
    return [];
  }
  async listBrokerPositions() {
    this.calls.push("positions");
    return this.held;
  }
  async getSpreadQuote(req: { underlying: string }) {
    this.calls.push(`quote ${req.underlying}`);
    return this.quotes;
  }
  async getUnderlyingQuote(symbol: string) {
    this.calls.push(`price ${symbol}`);
    return { symbol, price: 1, asOf: Date.now() };
  }
}

let bridge: FakeBridge;
let sim: MockExecutor;
let routed: RoutedExecutor;
const timing = { closeConfirmTimeoutMs: 80, orderFillTimeoutMs: 80, pollIntervalMs: 4, ladderStepMs: 20 };

const alert = (bot: string, direction: SignalDirection, price: number, now = BASE_NOW) =>
  processSignal(receiveAndSaveSignal({ botId: bot, signal: direction, price, barTime: `${bot}-${direction}-${now}`, interval: "5", raw: { symbol: bot === NDX_BOT_ID ? "NDX" : "SPX" }, now }), { executor: routed, now, ...timing });
const positions = (bot: string) => positionsStore.all().filter((p) => p.botId === bot);

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  setTestBotEnv();
  bridge = new FakeBridge();
  sim = new MockExecutor();
  routed = new RoutedExecutor(bridge, sim, ["NDX"]);
});
afterEach(() => vi.unstubAllEnvs());

describe("which executor takes which order", () => {
  it("NDX goes to the bridge, SPX to the simulation, an unknown underlying counts as NDX (never rerouted on a guess)", async () => {
    await routed.placeOpenOrder({ botId: "b", underlying: "NDX", positionType: "short_put_spread", shortStrike: 2, longStrike: 1, quantity: 1, limitCredit: 3, expiry: "x" });
    const spx = await routed.placeOpenOrder({ botId: "b", underlying: "SPX", positionType: "short_put_spread", shortStrike: 2, longStrike: 1, quantity: 1, limitCredit: 3, expiry: "x" });
    await routed.placeOpenOrder({ botId: "b", positionType: "short_put_spread", shortStrike: 2, longStrike: 1, quantity: 1, limitCredit: 3, expiry: "x" });
    expect(bridge.calls).toEqual(["open NDX 3", "open undefined 3"]);
    expect(spx.ref.startsWith(SIMULATION_REF_PREFIX)).toBe(true);
    expect(sim.placedOrders).toHaveLength(1);
  });

  it("is case-insensitive about symbols", () => {
    const r = new RoutedExecutor(bridge, sim, ["NDX"]);
    expect([r.takes("ndx"), r.takes("NDX"), r.takes("Spx"), r.takes(undefined)]).toEqual([true, true, false, true]);
  });

  it("a close follows the position's own venue: a simulated position never reaches the bridge, even if its underlying were NDX", async () => {
    const p = buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", type: "short_put_spread", status: "open", venue: "mock" });
    const { ref } = await routed.placeCloseOrder(p, { limitDebit: 2 });
    expect(ref.startsWith(SIMULATION_REF_PREFIX)).toBe(true);
    expect(bridge.calls).toEqual([]);
  });

  it("asking about or cancelling an order goes where the order is, by its reference", async () => {
    const { ref } = await routed.placeOpenOrder({ botId: "b", underlying: "SPX", positionType: "short_put_spread", shortStrike: 2, longStrike: 1, quantity: 1, limitCredit: 3, expiry: "x" });
    expect((await routed.getOrder(ref)).status).toBe("filled");
    await routed.cancelOrder(ref);
    await routed.getOrder("ib-7");
    expect(bridge.calls).toEqual(["get ib-7"]);
  });

  it("says what it is: the real broker's venue, limit-only for the symbols it takes only, venueFor per underlying", () => {
    expect(routed.venue).toBe("ibkr");
    expect(routed.limitOnly).toBe(true);
    expect([routed.limitOnlyFor("NDX"), routed.limitOnlyFor("SPX")]).toEqual([true, false]);
    expect([routed.venueFor("NDX"), routed.venueFor("SPX")]).toEqual(["ibkr", "mock"]);
  });

  it("quotes: the spread and index quotes are the bridge's for NDX and simply absent (null) for SPX, with no call to the bridge", async () => {
    const legs = { underlying: "NDX", expiry: "x", type: "short_put_spread" as const, shortStrike: 2, longStrike: 1 };
    expect(await routed.getSpreadQuote!(legs)).not.toBeNull();
    expect(await routed.getSpreadQuote!({ ...legs, underlying: "SPX" })).toBeNull();
    expect(await routed.getUnderlyingQuote!("SPX")).toBeNull();
    expect(bridge.calls).toEqual(["quote NDX"]);
  });

  it("the broker-only abilities exist only if the broker has them", async () => {
    const plain = new RoutedExecutor({ ...new MockExecutor() } as unknown as BrokerExecutor, sim, ["NDX"]);
    expect(plain.listBrokerPositions).toBeUndefined();
    expect(routed.listBrokerPositions).toBeDefined();
    await routed.listBrokerPositions!();
    expect(bridge.calls).toContain("positions");
  });
});

describe("through the engine: NDX on the bridge, SPX on the simulation", () => {
  it("an SPX alert opens a SIMULATED position and the bridge is never called; an NDX alert goes to the bridge at limit prices", async () => {
    await alert(TEST_BOT_ID, "bullish", 7805.45);
    await alert(NDX_BOT_ID, "bullish", 21_003.7);
    const [spx] = positions(TEST_BOT_ID);
    const [ndx] = positions(NDX_BOT_ID);
    expect(spx).toMatchObject({ underlying: "SPX", status: "open", venue: "mock" });
    expect(spx.brokerOrderRef?.startsWith("mock-")).toBe(true);
    expect(ndx).toMatchObject({ underlying: "NDX", status: "open", venue: "ibkr" });
    expect(bridge.calls.filter((c) => c.includes("SPX"))).toEqual([]);
    expect(bridge.calls.some((c) => c.startsWith("open NDX 3.3"))).toBe(true);
  });

  it("an SPX flip closes the simulated position on the simulation (no bridge call, no limit price needed) and opens the other side", async () => {
    await alert(TEST_BOT_ID, "bullish", 7805.45);
    await alert(TEST_BOT_ID, "bearish", 7805.45, BASE_NOW + 5 * 60_000);
    expect(positions(TEST_BOT_ID).map((p) => [p.type, p.status, p.venue])).toEqual([["short_put_spread", "closed", "mock"], ["short_call_spread", "open", "mock"]]);
    expect(bridge.calls).toEqual([]);
  });

  it("an NDX flip still goes entirely through the bridge and still needs a quote (SPX being simulated changes nothing for NDX)", async () => {
    await alert(NDX_BOT_ID, "bullish", 21_003.7);
    bridge.calls = [];
    bridge.quotes = { short: { bid: 13, ask: 12 }, long: { bid: 8.7, ask: 9.3 } }; // crossed: unusable
    await alert(NDX_BOT_ID, "bearish", 21_003.7, BASE_NOW + 5 * 60_000);
    expect(positions(NDX_BOT_ID).map((p) => [p.type, p.status])).toEqual([["short_put_spread", "open"]]); // close refused, nothing opened
    expect(bridge.calls.filter((c) => c.startsWith("close") || c.startsWith("open"))).toEqual([]);
  });
});

describe("the broker check ignores simulated positions", () => {
  it("an open simulated SPX position is not 'missing at the broker', and the real NDX one still is checked", async () => {
    positionsStore.insert(buildPosition({ botId: TEST_BOT_ID, underlying: "SPX", optionRoot: "SPXW", type: "short_put_spread", status: "open", venue: "mock", shortStrike: 7800, longStrike: 7795, requestedQuantity: 1, filledQuantity: 1 }));
    expect(await reconcile(bridge)).toMatchObject({ ok: true, expectedLegs: 0, problems: [] });
    positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", venue: "ibkr", shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 1, filledQuantity: 1 }));
    const r = await reconcile(bridge);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.kind)).toEqual(["missing_at_broker", "missing_at_broker"]);
  });

  it("a series that only simulated positions were ever on is not one the broker is expected to hold", async () => {
    positionsStore.insert(buildPosition({ botId: TEST_BOT_ID, underlying: "SPX", optionRoot: "SPXW", type: "short_put_spread", status: "closed", venue: "mock", closedAt: 1 }));
    bridge.held = [{ symbol: "SPXW261006P07800000", quantity: -1 }];
    expect((await reconcile(bridge)).ok).toBe(true);
  });
});

describe("BRIDGE_SYMBOLS", () => {
  it("defaults to NDX, reads a list in any case with spaces, and refuses nonsense", () => {
    expect(bridgeSymbols({})).toEqual(["NDX"]);
    expect(bridgeSymbols({ BRIDGE_SYMBOLS: " ndx , spx " })).toEqual(["NDX", "SPX"]);
    expect(bridgeSymbols({ BRIDGE_SYMBOLS: "" })).toEqual(["NDX"]);
    expect(() => bridgeSymbols({ BRIDGE_SYMBOLS: "NDX;SPX" })).toThrow(/BRIDGE_SYMBOLS/);
  });
});

describe("the price the bot trades on", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("PRICE_SOURCE=broker asks the bridge for NDX, but SPX comes from the public feed and the bridge is never asked", async () => {
    vi.resetModules();
    vi.stubEnv("PRICE_SOURCE", "broker");
    vi.stubEnv("BROKER", "ibkr");
    vi.stubEnv("BRIDGE_URL", "https://bridge.example.test");
    vi.stubEnv("BRIDGE_SECRET", "test-bridge-secret-not-real");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("bridge.example.test")) return new Response(JSON.stringify({ price: 30_000, asOf: Date.now() }), { status: 200 });
      if (url.includes("google.com/finance")) return new Response("<html></html>", { status: 200 });
      return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 7805.45 } }] } }), { status: 200 });
    });
    const { fetchPrice } = await import("@/lib/marketData/tickStore");
    expect(await fetchPrice("NDX")).toEqual({ price: 30_000, source: "broker" });
    const spx = await fetchPrice("SPX");
    expect(spx).toMatchObject({ price: 7805.45, source: "yahoo" });
    expect(urls.filter((u) => u.includes("bridge.example.test") && u.includes("spx"))).toEqual([]);
  });
});
