import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockExecutor } from "./executor";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { executorKind, isBrokerKind, priceSource } from "./executorKind";
import { IbkrConfigError, IbkrExecutor, mapBridgeOrder, readIbkrConfig, type BridgeFetch, type IbkrConfig } from "./ibkrExecutor";
import { executorStatus, getExecutor, isPaperStatus, sharedExecutor } from "./sharedExecutor";
import { positionsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import { fetchPrice } from "@/lib/marketData/tickStore";
import type { CloseOrderOptions, OpenSpreadRequest } from "./types";

// Every test uses a fake `fetch`. Nothing here can reach a bridge, IB Gateway or any network. The response bodies are SAMPLE shapes
// written from docs/ibkr-bridge-contract.md - not recordings from a running bridge.

setTestBotEnv();
setNdxTestEnv();

const SECRET = "test-bridge-secret-not-real";
const URL_ = "https://bridge.example.test";
const cfg: IbkrConfig = { baseUrl: URL_, secret: SECRET, allowLive: false, maxContracts: null, maxRiskPerOrder: null, maxQuoteAgeMs: 60_000 };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** Replies are used in order; a reply of `fn` is computed from the call. */
function fakeBridge(replies: ({ status?: number; body: unknown })[]) {
  const calls: Call[] = [];
  const queue = [...replies];
  const impl: BridgeFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const reply = queue.shift();
    if (!reply) throw new Error("fake bridge: no reply queued");
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)) };
  };
  return { impl, calls };
}

const PAPER = { connected: true, account: "DU1234567", paper: true };
const open = (over: Partial<OpenSpreadRequest> = {}): OpenSpreadRequest => ({
  botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", positionType: "short_put_spread", shortStrike: 20_970, longStrike: 20_960, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06", clientOrderId: "sig-1:open:1", ...over,
});
const heldPut = () => buildPosition({ id: "pos-1", botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 1, filledQuantity: 1 });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe("config: a bridge address and secret, paper only unless live is allowed on purpose", () => {
  const env = { BRIDGE_URL: URL_, BRIDGE_SECRET: SECRET };

  it("refuses to start without an address or a secret, naming what's missing", () => {
    expect(() => readIbkrConfig({})).toThrow(/BRIDGE_URL, BRIDGE_SECRET/);
    expect(() => readIbkrConfig({ BRIDGE_URL: URL_ })).toThrow(/BRIDGE_SECRET/);
    expect(() => readIbkrConfig({ BRIDGE_SECRET: SECRET })).toThrow(/BRIDGE_URL/);
    expect(() => readIbkrConfig({ BRIDGE_URL: " ", BRIDGE_SECRET: SECRET })).toThrow(IbkrConfigError);
  });

  it("reads a good config, paper by default, with a 60 second quote age", () => {
    expect(readIbkrConfig(env)).toEqual({ baseUrl: URL_, secret: SECRET, allowLive: false, maxContracts: null, maxRiskPerOrder: null, maxQuoteAgeMs: 60_000 });
    expect(readIbkrConfig({ ...env, BRIDGE_URL: `${URL_}///`, BRIDGE_MAX_QUOTE_AGE_MS: "900000" })).toMatchObject({ baseUrl: URL_, maxQuoteAgeMs: 900_000 });
  });

  it("requires https, except plain http to the machine itself", () => {
    expect(() => readIbkrConfig({ ...env, BRIDGE_URL: "http://bridge.example.test" })).toThrow(/https/);
    expect(() => readIbkrConfig({ ...env, BRIDGE_URL: "ftp://bridge.example.test" })).toThrow(/https/);
    expect(() => readIbkrConfig({ ...env, BRIDGE_URL: "nonsense" })).toThrow(/not a valid URL/);
    expect(readIbkrConfig({ ...env, BRIDGE_URL: "http://localhost:8787" }).baseUrl).toBe("http://localhost:8787");
    expect(readIbkrConfig({ ...env, BRIDGE_URL: "http://127.0.0.1:8787" }).baseUrl).toBe("http://127.0.0.1:8787");
    expect(() => readIbkrConfig({ ...env, BRIDGE_URL: "http://localhost.evil.test" })).toThrow(/https/);
  });

  it("refuses a password in the address and a short secret", () => {
    expect(() => readIbkrConfig({ ...env, BRIDGE_URL: "https://user:pw@bridge.example.test" })).toThrow(/must not contain/);
    expect(() => readIbkrConfig({ ...env, BRIDGE_SECRET: "short" })).toThrow(/too short/);
  });

  it("live mode needs both caps, with no defaults; the flag alone must be exactly \"true\"", () => {
    expect(readIbkrConfig({ ...env, IBKR_ALLOW_LIVE: "yes" }).allowLive).toBe(false);
    expect(() => readIbkrConfig({ ...env, IBKR_ALLOW_LIVE: "true" })).toThrow(/IBKR_MAX_CONTRACTS_PER_ORDER and IBKR_MAX_RISK_PER_ORDER/);
    expect(() => readIbkrConfig({ ...env, IBKR_ALLOW_LIVE: "true", IBKR_MAX_CONTRACTS_PER_ORDER: "2" })).toThrow(/IBKR_MAX_CONTRACTS_PER_ORDER and/);
    expect(readIbkrConfig({ ...env, IBKR_ALLOW_LIVE: "true", IBKR_MAX_CONTRACTS_PER_ORDER: "2", IBKR_MAX_RISK_PER_ORDER: "1500" })).toMatchObject({ allowLive: true, maxContracts: 2, maxRiskPerOrder: 1500 });
    expect(() => readIbkrConfig({ ...env, IBKR_MAX_RISK_PER_ORDER: "-5" })).toThrow(/above 0/);
  });
});

describe("order states", () => {
  it("passes the five states through and keeps a fill price only when something filled", () => {
    expect(mapBridgeOrder({ status: "working", filledQuantity: 0 })).toEqual({ status: "working", filledQuantity: 0 });
    expect(mapBridgeOrder({ status: "partially_filled", filledQuantity: 1, averagePrice: 3.45 })).toEqual({ status: "partially_filled", filledQuantity: 1, averagePrice: 3.45 });
    expect(mapBridgeOrder({ status: "filled", filledQuantity: 2, averagePrice: "3.4" })).toEqual({ status: "filled", filledQuantity: 2, averagePrice: 3.4 });
    expect(mapBridgeOrder({ status: "canceled", filledQuantity: 0, averagePrice: 3 })).toEqual({ status: "canceled", filledQuantity: 0 });
    expect(mapBridgeOrder({ status: "rejected", filledQuantity: 0, rejectReason: "No margin" })).toEqual({ status: "rejected", filledQuantity: 0, rejectReason: "No margin" });
    expect(mapBridgeOrder({ status: "rejected", filledQuantity: 0 }).rejectReason).toBeTruthy();
  });

  it("an unknown status or an unusable quantity is an error, never read as working", () => {
    expect(() => mapBridgeOrder({ status: "PreSubmitted", filledQuantity: 0 })).toThrow(/doesn't know/);
    expect(() => mapBridgeOrder({ filledQuantity: 0 })).toThrow(/doesn't know/);
    expect(() => mapBridgeOrder({ status: "filled", filledQuantity: "lots" })).toThrow(/filled quantity/);
    expect(() => mapBridgeOrder({ status: "filled", filledQuantity: -1 })).toThrow(/filled quantity/);
  });
});

describe("opening a spread", () => {
  it("making the executor sends nothing", () => {
    const { calls, impl } = fakeBridge([]);
    new IbkrExecutor(cfg, impl);
    expect(calls).toHaveLength(0);
  });

  it("checks the account first, then sends ONE combo order carrying both strikes, a day order, and the order id, with the secret in a header", async () => {
    const { calls, impl } = fakeBridge([{ body: PAPER }, { body: { ref: "ib-77" } }]);
    const { ref } = await new IbkrExecutor(cfg, impl).placeOpenOrder(open());
    expect(ref).toBe("ib-77");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${URL_}/health`, `POST ${URL_}/open_spread`]);
    expect(calls.every((c) => c.headers["X-Bridge-Secret"] === SECRET)).toBe(true);
    expect(calls[1].body).toEqual({
      underlying: "NDX", root: "NDXP", expiry: "2026-10-06", type: "short_put_spread", right: "put", shortStrike: 20_970, longStrike: 20_960,
      clientOrderId: "sig-1:open:1", quantity: 1, limitCredit: 3.5, tif: "DAY",
    });
    // The secret is never part of the body or the address.
    expect(JSON.stringify(calls[1].body)).not.toContain(SECRET);
    expect(calls.some((c) => c.url.includes(SECRET))).toBe(false);
  });

  it("a call spread says call", async () => {
    const { calls, impl } = fakeBridge([{ body: PAPER }, { body: { ref: "ib-78" } }]);
    await new IbkrExecutor(cfg, impl).placeOpenOrder(open({ positionType: "short_call_spread", shortStrike: 21_035, longStrike: 21_045 }));
    expect(calls[1].body).toMatchObject({ right: "call", type: "short_call_spread", shortStrike: 21_035, longStrike: 21_045 });
  });

  it("asks about the account once for a short while, not before every order", async () => {
    let t = 1_000_000;
    const { calls, impl } = fakeBridge([{ body: PAPER }, { body: { ref: "a" } }, { body: { ref: "b" } }, { body: PAPER }, { body: { ref: "c" } }]);
    const ex = new IbkrExecutor(cfg, impl, () => t);
    await ex.placeOpenOrder(open());
    t += 10_000;
    await ex.placeOpenOrder(open({ clientOrderId: "sig-1:open:2" }));
    expect(calls.filter((c) => c.url.endsWith("/health"))).toHaveLength(1);
    t += 30_000;
    await ex.placeOpenOrder(open({ clientOrderId: "sig-1:open:3" }));
    expect(calls.filter((c) => c.url.endsWith("/health"))).toHaveLength(2);
  });

  it("refuses, sending no order, when the account isn't a paper account", async () => {
    const { calls, impl } = fakeBridge([{ body: { connected: true, account: "U7654321", paper: false } }]);
    await expect(new IbkrExecutor(cfg, impl).placeOpenOrder(open())).rejects.toThrow(/not a paper account/);
    expect(calls.map((c) => c.url)).toEqual([`${URL_}/health`]);
  });

  it("a bridge that says paper=true about a live-looking account is still refused: the account id decides", async () => {
    const { calls, impl } = fakeBridge([{ body: { connected: true, account: "U1", paper: true } }]);
    await expect(new IbkrExecutor(cfg, impl).placeOpenOrder(open())).rejects.toThrow(/not a paper account/);
    expect(calls).toHaveLength(1);
  });

  it("refuses when Gateway isn't connected or no account is named, and asks again next time", async () => {
    const { calls, impl } = fakeBridge([{ body: { connected: false, account: "DU1" } }, { body: { connected: true } }, { body: PAPER }, { body: { ref: "ok" } }]);
    const ex = new IbkrExecutor(cfg, impl);
    await expect(ex.placeOpenOrder(open())).rejects.toThrow(/not connected/);
    await expect(ex.placeOpenOrder(open())).rejects.toThrow(/did not say which account/);
    expect((await ex.placeOpenOrder(open())).ref).toBe("ok");
    expect(calls.filter((c) => c.url.endsWith("/open_spread"))).toHaveLength(1);
  });

  it("a real account is allowed only when live was switched on, and then the caps apply", async () => {
    const live: IbkrConfig = { ...cfg, allowLive: true, maxContracts: 2, maxRiskPerOrder: 1500 };
    const { calls, impl } = fakeBridge([{ body: { connected: true, account: "U7654321" } }, { body: { ref: "live-1" } }]);
    const ex = new IbkrExecutor(live, impl);
    await expect(ex.placeOpenOrder(open({ quantity: 3 }))).rejects.toThrow(/over the limit of 2/);
    await expect(ex.placeOpenOrder(open({ quantity: 2, limitCredit: 1 }))).rejects.toThrow(/risks \$1\d{3}/); // 2 x (10-1) x 100 = 1800
    expect(calls).toHaveLength(0);
    expect((await ex.placeOpenOrder(open({ quantity: 1 }))).ref).toBe("live-1");
  });

  it("won't guess an option root or underlying, and refuses a limit that isn't a credit below the width, and a fractional quantity", async () => {
    const { calls, impl } = fakeBridge([]);
    const ex = new IbkrExecutor(cfg, impl);
    await expect(ex.placeOpenOrder(open({ optionRoot: undefined }))).rejects.toThrow(/will not guess/);
    await expect(ex.placeOpenOrder(open({ underlying: undefined }))).rejects.toThrow(/No underlying/);
    await expect(ex.placeOpenOrder(open({ limitCredit: 0 }))).rejects.toThrow(/not a credit/);
    await expect(ex.placeOpenOrder(open({ limitCredit: 10 }))).rejects.toThrow(/not a credit/);
    await expect(ex.placeOpenOrder(open({ quantity: 1.5 }))).rejects.toThrow(/whole number/);
    await expect(ex.placeOpenOrder(open({ expiry: "10/06/2026" }))).rejects.toThrow(/Bad expiry/);
    expect(calls).toHaveLength(0);
  });

  it("an order that fails or times out is sent once and never retried by this client", async () => {
    const { calls, impl } = fakeBridge([{ body: PAPER }, { status: 504, body: "gateway timeout" }, { body: { ref: "would-be-a-double" } }]);
    const ex = new IbkrExecutor(cfg, impl);
    await expect(ex.placeOpenOrder(open())).rejects.toThrow(/HTTP 504/);
    expect(calls.filter((c) => c.url.endsWith("/open_spread"))).toHaveLength(1);
  });

  it("an error never repeats the secret, and a reply without an order reference is an error", async () => {
    const leak = fakeBridge([{ body: PAPER }, { status: 401, body: "bad secret" }]);
    const err = await new IbkrExecutor(cfg, leak.impl).placeOpenOrder(open()).catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/HTTP 401/);
    expect(String((err as Error).message)).not.toContain(SECRET);
    const none = fakeBridge([{ body: PAPER }, { body: { ok: true } }, { body: { ref: "  " } }]);
    const ex = new IbkrExecutor(cfg, none.impl);
    await expect(ex.placeOpenOrder(open())).rejects.toThrow(/no order reference/);
    await expect(ex.placeOpenOrder(open())).rejects.toThrow(/no order reference/);
  });

  it("an answer that isn't a JSON object is an error", async () => {
    for (const body of ["<html>proxy error</html>", "[1,2]", "null"]) {
      const { impl } = fakeBridge([{ body: PAPER }, { body }]);
      await expect(new IbkrExecutor(cfg, impl).placeOpenOrder(open())).rejects.toThrow(/isn't a JSON object/);
    }
  });
});

describe("closing a spread", () => {
  it("a limit debit is a limit order carrying the position, the order id and the quantity; none is a market order", async () => {
    const { calls, impl } = fakeBridge([{ body: PAPER }, { body: { ref: "c1" } }, { body: { ref: "c2" } }]);
    const ex = new IbkrExecutor(cfg, impl);
    const opts: CloseOrderOptions = { limitDebit: 3.5, clientOrderId: "sig-2:close:pos-1:1" };
    await ex.placeCloseOrder(heldPut(), opts);
    await ex.placeCloseOrder(heldPut(), { quantity: 1 });
    const [a, b] = calls.filter((c) => c.url.endsWith("/close_spread"));
    expect(a.body).toEqual({
      underlying: "NDX", root: "NDXP", expiry: heldPut().expiry, type: "short_put_spread", right: "put", shortStrike: 20_970, longStrike: 20_960,
      positionId: "pos-1", clientOrderId: "sig-2:close:pos-1:1", quantity: 1, orderType: "limit", limitDebit: 3.5, tif: "DAY",
    });
    expect(b.body).toMatchObject({ orderType: "market", quantity: 1 });
    expect(b.body).not.toHaveProperty("limitDebit");
    expect(b.body).not.toHaveProperty("clientOrderId");
  });

  it("a partial close sends only that many contracts; nonsense quantities and prices are refused", async () => {
    const { calls, impl } = fakeBridge([{ body: PAPER }, { body: { ref: "c1" } }]);
    const ex = new IbkrExecutor(cfg, impl);
    const two = { ...heldPut(), requestedQuantity: 2, filledQuantity: 2 };
    await ex.placeCloseOrder(two, { quantity: 1 });
    expect(calls.at(-1)?.body).toMatchObject({ quantity: 1 });
    await expect(ex.placeCloseOrder(two, { quantity: 0 })).rejects.toThrow(/whole number/);
    await expect(ex.placeCloseOrder(two, { limitDebit: 0 })).rejects.toThrow(/above 0/);
  });

  it("is not blocked by the opening caps (closing is never capped), but still needs a paper account", async () => {
    const capped: IbkrConfig = { ...cfg, maxContracts: 1, maxRiskPerOrder: 10 };
    const ok = fakeBridge([{ body: PAPER }, { body: { ref: "c" } }]);
    await expect(new IbkrExecutor(capped, ok.impl).placeCloseOrder({ ...heldPut(), requestedQuantity: 5, filledQuantity: 5 })).resolves.toEqual({ ref: "c" });
    const live = fakeBridge([{ body: { connected: true, account: "U1" } }]);
    await expect(new IbkrExecutor(cfg, live.impl).placeCloseOrder(heldPut())).rejects.toThrow(/not a paper account/);
    expect(live.calls).toHaveLength(1);
  });
});

describe("watching and cancelling an order", () => {
  it("reads an order by reference, url-encoded, and cancels it with DELETE", async () => {
    const { calls, impl } = fakeBridge([{ body: { status: "partially_filled", filledQuantity: 1, averagePrice: 3.4 } }, { body: { ok: true } }]);
    const ex = new IbkrExecutor(cfg, impl);
    expect(await ex.getOrder("a/b c")).toEqual({ status: "partially_filled", filledQuantity: 1, averagePrice: 3.4 });
    await ex.cancelOrder("a/b c");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${URL_}/order/a%2Fb%20c`, `DELETE ${URL_}/order/a%2Fb%20c`]);
  });
});

describe("quotes", () => {
  const spread = { underlying: "NDX", optionRoot: "NDXP", expiry: "2026-10-06", type: "short_put_spread" as const, shortStrike: 20_970, longStrike: 20_960 };

  it("reads the bid and ask of each leg, and gives null for anything unusable", async () => {
    const { calls, impl } = fakeBridge([
      { body: { short: { bid: 12, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } } },
      { body: { short: { bid: 12, ask: 12.6 } } },
      { body: { short: { bid: 13, ask: 12 }, long: { bid: 8.7, ask: 9.3 } } },
      { body: { short: { bid: "x", ask: 1 }, long: { bid: 1, ask: 2 } } },
    ]);
    const ex = new IbkrExecutor(cfg, impl);
    expect(await ex.getSpreadQuote(spread)).toEqual({ short: { bid: 12, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${URL_}/quote/spread?underlying=NDX&root=NDXP&expiry=2026-10-06&type=short_put_spread&shortStrike=20970&longStrike=20960`);
    expect(await ex.getSpreadQuote(spread)).toBeNull(); // one leg missing
    expect(await ex.getSpreadQuote(spread)).toBeNull(); // bid above ask
    expect(await ex.getSpreadQuote(spread)).toBeNull(); // not a number
  });

  it("the index quote carries its own time: a stale or incomplete one is no price at all", async () => {
    const now = 1_800_000_000_000;
    const { calls, impl } = fakeBridge([
      { body: { price: 21_003.7, asOf: now - 5_000 } },
      { body: { price: 21_003.7, asOf: now - 61_000 } },
      { body: { price: 21_003.7 } },
      { body: { price: 0, asOf: now } },
      { body: { price: 21_003.7, asOf: now - 120_000, delayed: true } },
    ]);
    const ex = new IbkrExecutor(cfg, impl, () => now);
    expect(await ex.getUnderlyingQuote("NDX")).toEqual({ symbol: "NDX", price: 21_003.7, asOf: now - 5_000 });
    expect(calls[0].url).toBe(`${URL_}/quote/ndx`);
    expect(await ex.getUnderlyingQuote("NDX")).toBeNull();
    expect(await ex.getUnderlyingQuote("NDX")).toBeNull();
    expect(await ex.getUnderlyingQuote("NDX")).toBeNull();
    // Paper data without a subscription is often delayed: the age limit can be raised on purpose, and the quote says it is delayed.
    const lenient = new IbkrExecutor({ ...cfg, maxQuoteAgeMs: 900_000 }, fakeBridge([{ body: { price: 21_003.7, asOf: now - 120_000, delayed: true } }]).impl, () => now);
    expect(await lenient.getUnderlyingQuote("NDX")).toMatchObject({ price: 21_003.7, delayed: true });
  });

  it("only plain symbols are put in the address", async () => {
    const { calls, impl } = fakeBridge([]);
    const ex = new IbkrExecutor(cfg, impl);
    await expect(ex.getUnderlyingQuote("../health")).rejects.toThrow(/not a symbol/);
    await expect(ex.getUnderlyingQuote("")).rejects.toThrow(/not a symbol/);
    expect(calls).toHaveLength(0);
  });
});

describe("positions", () => {
  it("lists what the account holds, and a malformed answer is an error, not an empty account", async () => {
    const { calls, impl } = fakeBridge([
      { body: { positions: [{ symbol: "NDXP261006P20970000", quantity: -1 }, { symbol: "NDXP261006P20960000", quantity: 1 }] } },
      { body: { positions: [] } },
      { body: {} },
      { body: { positions: [{ symbol: "NDXP261006P20970000" }] } },
      { body: { positions: [{ quantity: 1 }] } },
    ]);
    const ex = new IbkrExecutor(cfg, impl);
    expect(await ex.listBrokerPositions()).toEqual([{ symbol: "NDXP261006P20970000", quantity: -1 }, { symbol: "NDXP261006P20960000", quantity: 1 }]);
    expect(calls[0].url).toBe(`${URL_}/positions`);
    expect(await ex.listBrokerPositions()).toEqual([]);
    await expect(ex.listBrokerPositions()).rejects.toThrow(/no list of positions/);
    await expect(ex.listBrokerPositions()).rejects.toThrow(/can't read/);
    await expect(ex.listBrokerPositions()).rejects.toThrow(/can't read/);
  });

  it("lists our own rows for the bot", async () => {
    const mine = heldPut();
    positionsStore.insert(mine);
    positionsStore.insert({ ...heldPut(), id: "other", botId: "someone-else" });
    expect((await new IbkrExecutor(cfg, fakeBridge([]).impl).listPositions(NDX_BOT_ID)).map((p) => p.id)).toEqual(["pos-1"]);
  });
});

describe("choosing the broker and the price source", () => {
  it("internal (the simulation) is the default, and BROKER is the new spelling of EXECUTOR", () => {
    expect(executorKind({})).toBe("mock");
    expect(executorKind({ BROKER: "internal" })).toBe("mock");
    expect(executorKind({ BROKER: " IBKR " })).toBe("ibkr");
    expect(executorKind({ EXECUTOR: "ibkr" })).toBe("ibkr");
    expect(executorKind({ BROKER: "ibkr", EXECUTOR: "ibkr" })).toBe("ibkr");
    expect(executorKind({ BROKER: "internal", EXECUTOR: "mock" })).toBe("mock");
    expect(isBrokerKind({ BROKER: "ibkr" })).toBe(true);
    expect(isBrokerKind({})).toBe(false);
  });

  it("two settings that disagree, and unknown values, are errors rather than a guess", () => {
    expect(() => executorKind({ BROKER: "ibkr", EXECUTOR: "mock" })).toThrow(/disagree/);
    expect(() => executorKind({ BROKER: "paper" })).toThrow(/BROKER must be/);
    expect(isBrokerKind({ BROKER: "paper" })).toBe(false);
    expect(priceSource({})).toBe("feed");
    expect(priceSource({ PRICE_SOURCE: "Broker" })).toBe("broker");
    expect(() => priceSource({ PRICE_SOURCE: "both" })).toThrow(/PRICE_SOURCE must be/);
  });

  it("BROKER=ibkr without its settings is an error status and builds nothing; with them it builds the bridge client and makes no request", () => {
    vi.stubEnv("BROKER", "ibkr");
    expect(executorStatus()).toMatchObject({ kind: "ibkr", venue: "ibkr" });
    expect(executorStatus().error).toMatch(/BRIDGE_URL, BRIDGE_SECRET/);
    expect(() => getExecutor()).toThrow(IbkrConfigError);
    expect(sharedExecutor.getUnderlyingQuote).toBeUndefined();

    vi.stubEnv("BRIDGE_URL", URL_);
    vi.stubEnv("BRIDGE_SECRET", SECRET);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(executorStatus()).toMatchObject({ kind: "ibkr", venue: "ibkr", error: null, baseUrl: URL_, sandbox: true, priceSource: "feed" });
    expect(getExecutor()).toBeInstanceOf(IbkrExecutor);
    expect(sharedExecutor.venue).toBe("ibkr");
    expect(typeof sharedExecutor.getUnderlyingQuote).toBe("function");
    expect(typeof sharedExecutor.getSpreadQuote).toBe("function");
    expect(typeof sharedExecutor.listBrokerPositions).toBe("function");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("the default is still the internal simulation, which offers no broker abilities", () => {
    expect(getExecutor()).toBeInstanceOf(MockExecutor);
    expect(executorStatus()).toMatchObject({ kind: "mock", venue: "mock", error: null });
    expect(sharedExecutor.getUnderlyingQuote).toBeUndefined();
    expect(sharedExecutor.getOptionChain).toBeUndefined();
  });

  it("PRICE_SOURCE=broker needs a broker that can quote: with the internal simulation it is an error status", () => {
    vi.stubEnv("PRICE_SOURCE", "broker");
    expect(executorStatus().error).toMatch(/PRICE_SOURCE=broker needs/);
    vi.stubEnv("BROKER", "ibkr");
    vi.stubEnv("BRIDGE_URL", URL_);
    vi.stubEnv("BRIDGE_SECRET", SECRET);
    expect(executorStatus()).toMatchObject({ error: null, priceSource: "broker" });
  });

  it("paper means the simulation, or a broker whose real-money switch is off - nothing else", () => {
    expect(isPaperStatus({ venue: "mock", sandbox: undefined })).toBe(true);
    expect(isPaperStatus({ venue: "ibkr", sandbox: true })).toBe(true);
    expect(isPaperStatus({ venue: "ibkr", sandbox: false })).toBe(false);
    expect(isPaperStatus({ venue: "ibkr", sandbox: undefined })).toBe(false);
    expect(isPaperStatus({ venue: "tradier", sandbox: true })).toBe(true);
    expect(isPaperStatus({ venue: "tradier", sandbox: false })).toBe(false);
    expect(isPaperStatus({ venue: null, sandbox: undefined })).toBe(false);
  });
});

describe("the price the bot trades on", () => {
  it("is the public feed unless PRICE_SOURCE=broker; then the broker's quote, with no fallback to the feed", async () => {
    vi.stubEnv("BROKER", "ibkr");
    vi.stubEnv("BRIDGE_URL", URL_);
    vi.stubEnv("BRIDGE_SECRET", SECRET);
    vi.stubEnv("PRICE_SOURCE", "broker");
    const asOf = Date.now();
    const answers = [{ body: { price: 21_003.7, asOf } }, { body: { price: 21_010, asOf: asOf - 600_000 } }, { status: 503, body: "gateway down" }];
    const impl: BridgeFetch = async () => {
      const r = answers.shift()!;
      const status = r.status ?? 200;
      return { ok: status < 300, status, text: async () => JSON.stringify(r.body) };
    };
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string, init: Parameters<BridgeFetch>[1]) => impl(u, init)) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await fetchPrice("NDX")).toEqual({ price: 21_003.7, source: "broker" });
      expect(await fetchPrice("NDX")).toBeNull(); // ten minutes old
      expect(await fetchPrice("NDX")).toBeNull(); // bridge down: no price, not Google's
    } finally {
      globalThis.fetch = real;
      warn.mockRestore();
    }
  });

  it("a bad PRICE_SOURCE gives no price rather than another source", async () => {
    vi.stubEnv("PRICE_SOURCE", "sideways");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await fetchPrice("NDX")).toBeNull();
    err.mockRestore();
  });
});

describe("the engine gives every order an id the bridge can recognise", () => {
  /** The internal simulation, noting what the engine asked it to place. */
  class Spy extends MockExecutor {
    opens: OpenSpreadRequest[] = [];
    closes: { id: string; options?: CloseOrderOptions }[] = [];
    override async placeOpenOrder(req: OpenSpreadRequest) {
      this.opens.push(req);
      return super.placeOpenOrder(req);
    }
    override async placeCloseOrder(position: Parameters<MockExecutor["placeCloseOrder"]>[0], options?: CloseOrderOptions) {
      this.closes.push({ id: position.id, options });
      return super.placeCloseOrder(position, options);
    }
  }
  const fast = { closeConfirmTimeoutMs: 100, orderFillTimeoutMs: 100, pollIntervalMs: 5 };
  const signal = (direction: "bullish" | "bearish", barTime: string, now: number) =>
    receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 21_003.7, barTime, interval: "5", raw: { symbol: "NDX" }, now });

  it("an open and then a flip: the open carries the alert's id, the close carries the alert's id and the position's, and none repeat", async () => {
    const spy = new Spy();
    const first = signal("bullish", "t1", BASE_NOW);
    await processSignal(first, { executor: spy, now: BASE_NOW, ...fast });
    const second = signal("bearish", "t2", BASE_NOW + 5 * 60_000);
    await processSignal(second, { executor: spy, now: BASE_NOW + 5 * 60_000, ...fast });

    const ids = [...spy.opens.map((o) => o.clientOrderId), ...spy.closes.map((c) => c.options?.clientOrderId)];
    expect(spy.opens.map((o) => o.clientOrderId)).toEqual([`${first.id}:open:1`, `${second.id}:open:1`]);
    expect(spy.closes).toHaveLength(1);
    expect(spy.closes[0].options?.clientOrderId).toBe(`${second.id}:close:${spy.closes[0].id}:1`);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
