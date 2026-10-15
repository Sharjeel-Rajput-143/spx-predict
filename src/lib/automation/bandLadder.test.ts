import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manualClose, processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import type { LegQuotes } from "./smartPricing";
import { botsStore, decisionsStore, errorsStore, ordersStore, positionsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import type { BrokerPosition, CloseOrderOptions, Position, SignalDirection } from "./types";

// The broker's price band through the whole engine. IBKR refuses a price too far through its market at once (a BUY far above, a SELL far
// below) and says what it thinks the market is and the first price it won't take. The ladder prices again from those numbers, twice at most,
// and a close that ends with nothing filled goes back to "open" only when the account itself shows the whole spread still held.

setTestBotEnv();
setNdxTestEnv();

const SHORT = "NDXP261006P20970000";
const LONG = "NDXP261006P20960000";

/** A broker that is only sent limit orders, and can say what its account holds. */
class Broker extends MockExecutor {
  readonly limitOnly = true;
  held: BrokerPosition[] | "unreachable" | null = null; // null: this broker can't list positions at all
  override async placeCloseOrder(position: Position, options?: CloseOrderOptions) {
    if (options?.limitDebit === undefined) throw new Error("no limit price");
    return super.placeCloseOrder(position, options);
  }
  listBrokerPositions = async (): Promise<BrokerPosition[]> => {
    if (this.held === "unreachable" || this.held === null) throw new Error("bridge unreachable");
    return this.held;
  };
}

const spread = (n = 1): BrokerPosition[] => [{ symbol: SHORT, quantity: -n }, { symbol: LONG, quantity: n }];
// The spread is worth 3.30 at the mid; closing walks 3.30, 3.50, 3.70, 3.90 and opening 3.30, 3.10, 2.90, 2.70.
const quotes: LegQuotes = { short: { bid: 12.0, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 }, delayed: false };

let broker: Broker;
const timing = { closeConfirmTimeoutMs: 80, orderFillTimeoutMs: 80, pollIntervalMs: 4, ladderStepMs: 25 };
const emit = (direction: SignalDirection, now = BASE_NOW) =>
  processSignal(receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 21_003.7, barTime: `b-${direction}-${now}`, interval: "5", raw: { symbol: "NDX" }, now }), { executor: broker, now, ...timing });
const holdPut = (over: Partial<Position> = {}) =>
  positionsStore.insert(buildPosition({ id: "pos-1", botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 1, filledQuantity: 1, credit: 3.3, venue: "ibkr", ...over }));
const placed = (kind: "open" | "close") => broker.placedOrders.filter((o) => o.kind === kind).map((o) => o.price);
const band = (edge?: number, marketPrice?: number) => ({ kind: "band" as const, ...(edge !== undefined ? { edge } : {}), ...(marketPrice !== undefined ? { marketPrice } : {}) });
const outcomes = () => decisionsStore.all().map((d) => d.outcome);

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  broker = new Broker();
  broker.setQuotes(quotes);
});
afterEach(() => vi.unstubAllEnvs());

describe("a close the broker refuses on its price band", () => {
  it("is priced again from the broker's own numbers and goes through: the first refused price is never repeated, the new ones stay under the exclusive edge", async () => {
    holdPut();
    broker.queueScenario(NDX_BOT_ID, band(1.6, 1.1)); // the first close order is refused: market 1.10, edge 1.60
    await emit("bearish");

    const prices = placed("close");
    expect(prices[0]).toBe(3.3);
    expect(prices[1]).toBe(1.1); // re-priced: starts at the broker's market
    expect(prices).toHaveLength(2); // and that one filled
    expect(prices.slice(1).every((p) => p! < 1.6 && p! <= 2.1)).toBe(true);
    expect(positionsStore.all().filter((p) => p.botId === NDX_BOT_ID).map((p) => [p.type, p.status])).toEqual([["short_put_spread", "closed"], ["short_call_spread", "open"]]);
    const run = decisionsStore.all().find((d) => d.outcome === "closed");
    expect(run).toBeDefined();
  });

  it("records what the broker said on the refused order, so the Orders table can show it", async () => {
    holdPut();
    broker.queueScenario(NDX_BOT_ID, band(1.6, 1.1));
    await emit("bearish");
    const closes = ordersStore.all().filter((o) => o.kind === "close").sort((a, b) => a.createdAt - b.createdAt);
    expect(closes[0]).toMatchObject({ limitPrice: 3.3, status: "canceled", priceBand: { edge: 1.6, marketPrice: 1.1 } });
    expect(closes[0].rejectReason).toMatch(/price band/);
    expect(closes[1]).toMatchObject({ limitPrice: 1.1, status: "filled" });
    expect(closes[1].priceBand).toBeUndefined();
  });

  it("the run's steps say what happened, in words", async () => {
    holdPut();
    broker.queueScenario(NDX_BOT_ID, band(1.6, 1.1));
    const p = positionsStore.get("pos-1")!;
    await manualClose(p.id, { executor: broker, ...timing });
    const { runsStore } = await import("./store");
    const steps = runsStore.all().flatMap((r) => r.nodes).flatMap((n) => (n.kind === "action" ? (n.steps ?? []) : []));
    expect(steps[0]).toBe("Price 1 of 4: $3.30 - refused by the broker's price band (the market is 1.10, it will not take 1.60 or beyond); the market is 1.10, it will not take 1.60 or more: re-priced to 1.10, 1.25, 1.40, 1.55");
    expect(steps[1]).toMatch(/^Price 1 of 4: \$1\.10, waited up to .* filled 1 of 1$/);
  });

  it("a second refusal is re-priced once more; a third ends it (two re-prices at most), saying so", async () => {
    holdPut();
    broker.queueScenario(NDX_BOT_ID, band(1.6, 1.1));
    broker.queueScenario(NDX_BOT_ID, band(1.3, 1.0));
    await emit("bearish");
    const prices = placed("close");
    expect(prices[0]).toBe(3.3);
    expect(prices[1]).toBe(1.1);
    expect(prices[2]).toBe(1); // from the second refusal's market, not the first's
    expect(prices).toHaveLength(3);

    resetAutomationStores();
    setNdxTestEnv();
    broker = new Broker();
    broker.setQuotes(quotes);
    holdPut();
    for (const [e, m] of [[1.6, 1.1], [1.3, 1.0], [1.2, 0.9]] as const) broker.queueScenario(NDX_BOT_ID, band(e, m));
    await emit("bearish");
    expect(placed("close")).toHaveLength(3); // the original and two re-prices; the third refusal is not argued with
    expect(outcomes()).toContain("close_rejected");
    const reason = decisionsStore.all().find((d) => d.outcome === "close_rejected")!.reason;
    expect(reason).toMatch(/refused the price as too far through its market/);
    expect(reason).toMatch(/the market is 0\.90, it will not take 1\.20 or beyond/);
  });

  it("a refusal with no numbers in it is not re-priced: it ends, and says why", async () => {
    holdPut();
    broker.queueScenario(NDX_BOT_ID, { kind: "band" }); // a band refusal whose message had neither number
    await emit("bearish");
    expect(placed("close")).toEqual([3.3]);
    expect(outcomes()).toContain("close_rejected");
  });

  it("the cap above market is a setting", async () => {
    vi.stubEnv("CLOSE_MAX_ABOVE_MARKET", "0.2");
    holdPut();
    broker.queueScenario(NDX_BOT_ID, band(5, 1.1));
    broker.queueScenario(NDX_BOT_ID, { kind: "never" }); // the re-priced orders rest, so the whole new ladder is seen
    await emit("bearish");
    const prices = placed("close").slice(1);
    expect(Math.max(...(prices as number[]))).toBeLessThanOrEqual(1.3);
    expect(prices[0]).toBe(1.1);
  });
});

describe("a close that ends with nothing filled goes back to open only when the account shows the whole spread held", () => {
  const refusedThrice = () => {
    for (const [e, m] of [[1.6, 1.1], [1.3, 1.0], [1.2, 0.9]] as const) broker.queueScenario(NDX_BOT_ID, band(e, m));
  };
  const statusAfter = async () => {
    holdPut();
    refusedThrice();
    await emit("bearish");
    return positionsStore.get("pos-1")!;
  };
  const reason = () => decisionsStore.all().find((d) => d.outcome === "close_rejected")!.reason;

  it("the account still holds the whole spread -> back to open (the bot stays flagged, the error is logged), and the reason says so", async () => {
    broker.held = spread();
    expect((await statusAfter()).status).toBe("open");
    expect(positionsStore.get("pos-1")?.closeSignalId).toBeNull();
    expect(reason()).toMatch(/The account still holds the whole spread, so the position is back to open/);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);
    expect(errorsStore.all().length).toBeGreaterThan(0);
    expect(decisionsStore.all().map((d) => d.outcome)).not.toContain("opened"); // and nothing opened on the other side
  });

  it("the account holds nothing, one leg, or less than the whole position -> stays closing, for Resolve", async () => {
    for (const held of [[], [{ symbol: SHORT, quantity: -1 }], [{ symbol: LONG, quantity: 1 }]] as BrokerPosition[][]) {
      resetAutomationStores();
      setNdxTestEnv();
      broker = new Broker();
      broker.setQuotes(quotes);
      broker.held = held;
      expect((await statusAfter()).status, JSON.stringify(held)).toBe("closing");
      expect(reason()).toMatch(/stays in closing/);
      expect(reason()).toMatch(/Resolve/);
    }
  });

  it("two contracts held but only one is in the account -> stays closing", async () => {
    broker.held = spread(1);
    resetAutomationStores();
    setNdxTestEnv();
    holdPut({ requestedQuantity: 2, filledQuantity: 2 });
    refusedThrice();
    await emit("bearish");
    expect(positionsStore.get("pos-1")?.status).toBe("closing");
  });

  it("the account can't be asked -> stays closing, and says so", async () => {
    broker.held = "unreachable";
    expect((await statusAfter()).status).toBe("closing");
    expect(reason()).toMatch(/could not be asked/);
  });

  it("a simulated position or a broker with no account to ask is left exactly as before: closing", async () => {
    broker.held = spread();
    holdPut({ venue: "mock" });
    refusedThrice();
    await emit("bearish");
    expect(positionsStore.get("pos-1")?.status).toBe("closing");
  });

  it("an ordinary timeout (never filled at any price) follows the same rule", async () => {
    broker.held = spread();
    holdPut();
    for (let i = 0; i < 4; i++) broker.queueScenario(NDX_BOT_ID, { kind: "never" });
    await emit("bearish");
    expect(outcomes()).toContain("close_timeout");
    expect(positionsStore.get("pos-1")?.status).toBe("open");
    expect(decisionsStore.all().find((d) => d.outcome === "close_timeout")!.reason).toMatch(/back to open/);
  });

  it("a partial fill is never put back: it stays closing for a person", async () => {
    broker.held = spread();
    holdPut({ requestedQuantity: 2, filledQuantity: 2 });
    broker.queueScenario(NDX_BOT_ID, { kind: "partial", firstFillRatio: 0.5, remainderDelayMs: null });
    await emit("bearish");
    expect(outcomes()).toContain("close_partial_fill");
    expect(positionsStore.get("pos-1")?.status).toBe("closing");
  });

  it("back at open, the next alert closes it normally", async () => {
    broker.held = spread();
    await statusAfter();
    expect(positionsStore.get("pos-1")?.status).toBe("open");
    await emit("bearish", BASE_NOW + 10 * 60_000);
    expect(positionsStore.all().filter((p) => p.botId === NDX_BOT_ID).map((p) => p.status).sort()).toEqual(["closed", "open"]);
  });
});

describe("an open the broker refuses on its price band", () => {
  it("is priced again from the broker's numbers, never past the bot's own final price", async () => {
    broker.queueScenario(NDX_BOT_ID, band(2.0, 2.2));
    await emit("bullish");
    expect(placed("open")).toEqual([3.3, 2.7]); // the ladder's own final price (2.70) even though the edge would allow 2.05
    expect(positionsStore.all()[0]).toMatchObject({ status: "open", credit: 2.7 });
  });

  it("never under the minimum credit", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_MIN_CREDIT", "2.9");
    broker.queueScenario(NDX_BOT_ID, band(1.0, 1.2));
    await emit("bullish");
    for (const p of placed("open")) expect(p!).toBeGreaterThanOrEqual(2.9);
  });

  it("refused three times: nothing is opened, the position is rejected, and the log says why", async () => {
    for (const [e, m] of [[3.2, 3.0], [3.1, 2.9], [3.0, 2.8]] as const) broker.queueScenario(NDX_BOT_ID, band(e, m));
    await emit("bullish");
    expect(positionsStore.all().map((p) => p.status)).toEqual(["rejected"]);
    expect(outcomes()).toEqual(["open_rejected"]);
    expect(decisionsStore.all()[0].reason).toMatch(/refused the price as too far through its market/);
  });

  it("a refusal the broker made with its own words is a rejection, not a timeout", async () => {
    broker.queueScenario(NDX_BOT_ID, { kind: "band", reason: "Order canceled - reason: contract is not available" });
    await emit("bullish");
    expect(outcomes()).toEqual(["open_rejected"]);
  });
});

describe("a quote too wide to price from", () => {
  // natural credit = 12 - 9.3 = 2.7; best = short.ask - 8.7; so gap = short.ask - 8.7 - 2.7 = short.ask - 11.4
  const quote = (gap: number, delayed?: boolean): LegQuotes => ({ short: { bid: 12, ask: 11.4 + gap }, long: { bid: 8.7, ask: 9.3 }, ...(delayed !== undefined ? { delayed } : {}) });

  it("real-time data: a gap over $3 is refused, for the open (rejected) and for the close (refused, position unchanged)", async () => {
    broker.setQuotes(quote(3.6, false));
    await emit("bullish");
    expect(broker.placedOrders).toHaveLength(0);
    expect(outcomes()).toEqual(["open_rejected"]);
    expect(decisionsStore.all()[0].reason).toMatch(/too wide to price from: its bid\/ask gap is \$3\.60 against a limit of \$3\.00/);

    holdPut();
    await emit("bearish", BASE_NOW + 5 * 60_000);
    expect(broker.placedOrders).toHaveLength(0);
    expect(outcomes()).toContain("close_no_quote");
    expect(positionsStore.get("pos-1")?.status).toBe("open");
  });

  it("exactly $3 is allowed, and a gap that is not known to be delayed is treated as real-time (the limit applies)", async () => {
    broker.setQuotes(quote(3, false));
    await emit("bullish");
    expect(placed("open").length).toBeGreaterThan(0);
    resetAutomationStores();
    setNdxTestEnv();
    broker = new Broker();
    broker.setQuotes(quote(3.6)); // delayed not said at all
    await emit("bullish");
    expect(broker.placedOrders).toHaveLength(0);
  });

  it("while the bridge says the data is delayed the limit is off, so rehearsal trades still go (the floor then protects the price)", async () => {
    broker.setQuotes(quote(8.6, true));
    await emit("bullish");
    expect(placed("open").length).toBeGreaterThan(0);
    expect(Math.min(...(placed("open") as number[]))).toBeGreaterThanOrEqual(0.9);
  });

  it("the limit is a setting: 0 turns it off, a smaller one is stricter", async () => {
    vi.stubEnv("QUOTE_MAX_WIDTH", "0");
    broker.setQuotes(quote(8.6, false));
    await emit("bullish");
    expect(placed("open").length).toBeGreaterThan(0);

    resetAutomationStores();
    setNdxTestEnv();
    broker = new Broker();
    vi.stubEnv("QUOTE_MAX_WIDTH", "1");
    broker.setQuotes(quote(1.5, false));
    await emit("bullish");
    expect(broker.placedOrders).toHaveLength(0);
  });

  it("a quote with a normal gap is untouched (the ordinary ladder, as before)", async () => {
    broker.setQuotes(quotes);
    await emit("bullish");
    expect(placed("open")).toEqual([3.3]);
  });
});
