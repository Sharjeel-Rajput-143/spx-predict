import { beforeEach, describe, expect, it, vi } from "vitest";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { botsStore, decisionsStore, positionsStore } from "./store";
import { executorKind, executorStatus, getExecutor, sharedExecutor } from "./sharedExecutor";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import { TRADIER_PRODUCTION_URL, TRADIER_SANDBOX_URL, TradierConfigError, TradierExecutor, mapTradierOrder, occSymbol, readTradierConfig, type FetchLike } from "./tradierExecutor";
import { MockExecutor } from "./executor";
import { ingestWebhook } from "./webhookIngest";

// Every test here uses a fake fetch. Nothing in this file can reach Tradier or
// any other network, and the response bodies are SAMPLE shapes written from
// Tradier's docs - not recordings from a live account.

setTestBotEnv();
setNdxTestEnv();

const TOKEN = "TEST-TOKEN-not-real";
const baseConfig = { token: TOKEN, accountId: "ACC-TEST", baseUrl: TRADIER_SANDBOX_URL, sandbox: true };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: Record<string, string>;
}

function fakeFetch(replies: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const queue = [...replies];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, form: Object.fromEntries(new URLSearchParams(init.body ?? "")) });
    const reply = queue.shift();
    if (!reply) throw new Error("fake fetch: no reply queued");
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)) };
  };
  return { impl, calls };
}

// SAMPLE shapes (not recorded) of GET /markets/quotes, POST /orders and GET /orders/{id}.
const sampleQuotes = (short: string, long: string) => ({ quotes: { quote: [{ symbol: short, bid: 12.0, ask: 12.6 }, { symbol: long, bid: 8.7, ask: 9.3 }] } });
const SAMPLE_PLACED = { order: { id: 4815162, status: "ok", partner_id: "sample" } };
const sampleOrder = (over: Record<string, unknown>) => ({ order: { id: 4815162, quantity: 1, exec_quantity: 0, status: "open", ...over } });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  vi.unstubAllEnvs();
});

describe("config: sandbox by default, production only on purpose", () => {
  it("refuses to start without a token or an account id, naming what's missing", () => {
    expect(() => readTradierConfig({})).toThrow(/TRADIER_TOKEN, TRADIER_ACCOUNT_ID/);
    expect(() => readTradierConfig({ TRADIER_TOKEN: "x" })).toThrow(/TRADIER_ACCOUNT_ID/);
    expect(() => readTradierConfig({ TRADIER_ACCOUNT_ID: "x" })).toThrow(/TRADIER_TOKEN/);
    expect(() => readTradierConfig({ TRADIER_TOKEN: "  ", TRADIER_ACCOUNT_ID: "x" })).toThrow(TradierConfigError);
  });

  it("defaults to the sandbox URL", () => {
    expect(readTradierConfig({ TRADIER_TOKEN: "t", TRADIER_ACCOUNT_ID: "a" })).toMatchObject({ baseUrl: TRADIER_SANDBOX_URL, sandbox: true });
  });

  it("refuses the production URL unless TRADIER_ALLOW_PRODUCTION=true is set separately", () => {
    const env = { TRADIER_TOKEN: "t", TRADIER_ACCOUNT_ID: "a", TRADIER_BASE_URL: TRADIER_PRODUCTION_URL };
    expect(() => readTradierConfig(env)).toThrow(/Refusing to use Tradier's PRODUCTION URL/);
    expect(() => readTradierConfig({ ...env, TRADIER_ALLOW_PRODUCTION: "yes" })).toThrow(/PRODUCTION/);
    const caps = { TRADIER_MAX_CONTRACTS_PER_ORDER: "3", TRADIER_MAX_RISK_PER_ORDER: "1500" };
    expect(readTradierConfig({ ...env, ...caps, TRADIER_ALLOW_PRODUCTION: "true" })).toMatchObject({ baseUrl: TRADIER_PRODUCTION_URL, sandbox: false, maxContracts: 3, maxRiskPerOrder: 1500 });
  });

  it("the allow flag alone does not switch to production - the URL must be set too", () => {
    expect(readTradierConfig({ TRADIER_TOKEN: "t", TRADIER_ACCOUNT_ID: "a", TRADIER_ALLOW_PRODUCTION: "true" }).sandbox).toBe(true);
  });

  it("refuses any other host and any non-https URL", () => {
    const env = { TRADIER_TOKEN: "t", TRADIER_ACCOUNT_ID: "a" };
    expect(() => readTradierConfig({ ...env, TRADIER_BASE_URL: "https://example.com/v1" })).toThrow(/not a Tradier host/);
    expect(() => readTradierConfig({ ...env, TRADIER_BASE_URL: "http://sandbox.tradier.com/v1" })).toThrow(/https/);
    expect(() => readTradierConfig({ ...env, TRADIER_BASE_URL: "https://sandbox.tradier.com.evil.test/v1" })).toThrow(/not a Tradier host/);
    expect(() => readTradierConfig({ ...env, TRADIER_BASE_URL: "nonsense" })).toThrow(/not a valid URL/);
  });
});

describe("option symbols", () => {
  it("builds ROOT + YYMMDD + C/P + strike x 1000 in 8 digits", () => {
    expect(occSymbol("NDXP", "2026-10-06", "put", 20_975)).toBe("NDXP261006P20975000");
    expect(occSymbol("SPXW", "2026-10-06", "call", 7720)).toBe("SPXW261006C07720000");
  });

  it("refuses what it can't write exactly", () => {
    expect(() => occSymbol("NDXP", "2026-10-06", "put", 20_975.0005)).toThrow(/can't be written/);
    expect(() => occSymbol("NDXP", "10/06/2026", "put", 20_975)).toThrow(/Bad expiry/);
  });
});

describe("orders on a fake HTTP layer", () => {
  it("making the executor sends nothing", () => {
    const { calls, impl } = fakeFetch([]);
    new TradierExecutor(baseConfig, impl);
    expect(calls).toHaveLength(0);
  });

  it("an opening NDX put spread is one multileg credit order: sell the short, buy the long", async () => {
    const { calls, impl } = fakeFetch([{ body: SAMPLE_PLACED }]);
    const ex = new TradierExecutor(baseConfig, impl);
    const { ref } = await ex.placeOpenOrder({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", positionType: "short_put_spread", shortStrike: 20_975, longStrike: 20_965, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06" });

    expect(ref).toBe("4815162");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${TRADIER_SANDBOX_URL}/accounts/ACC-TEST/orders` });
    expect(calls[0].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" });
    expect(calls[0].form).toEqual({
      class: "multileg",
      symbol: "NDX",
      type: "credit",
      duration: "day",
      price: "3.5",
      "option_symbol[0]": "NDXP261006P20975000",
      "side[0]": "sell_to_open",
      "quantity[0]": "1",
      "option_symbol[1]": "NDXP261006P20965000",
      "side[1]": "buy_to_open",
      "quantity[1]": "1",
    });
  });

  it("a call spread uses call symbols, short below the long", async () => {
    const { calls, impl } = fakeFetch([{ body: SAMPLE_PLACED }]);
    await new TradierExecutor(baseConfig, impl).placeOpenOrder({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", positionType: "short_call_spread", shortStrike: 21_035, longStrike: 21_045, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06" });
    expect(calls[0].form["option_symbol[0]"]).toBe("NDXP261006C21035000");
    expect(calls[0].form["option_symbol[1]"]).toBe("NDXP261006C21045000");
  });

  it("closing buys back the short and sells the long, at market (the engine sends no close price)", async () => {
    const { calls, impl } = fakeFetch([{ body: SAMPLE_PLACED }]);
    const position = buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", shortStrike: 20_975, longStrike: 20_965, requestedQuantity: 1, filledQuantity: 1 });
    await new TradierExecutor(baseConfig, impl).placeCloseOrder(position);
    expect(calls[0].form).toMatchObject({ class: "multileg", type: "market", "side[0]": "buy_to_close", "side[1]": "sell_to_close", "quantity[0]": "1" });
    expect(calls[0].form.price).toBeUndefined();
  });

  it("will not guess an option root: no root, no request", async () => {
    const { calls, impl } = fakeFetch([]);
    const ex = new TradierExecutor(baseConfig, impl);
    await expect(ex.placeOpenOrder({ botId: NDX_BOT_ID, underlying: "NDX", positionType: "short_put_spread", shortStrike: 20_975, longStrike: 20_965, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06" })).rejects.toThrow(/will not guess/);
    await expect(ex.placeCloseOrder(buildPosition({ botId: NDX_BOT_ID, type: "short_put_spread", status: "open" }))).rejects.toThrow(/will not guess/);
    expect(calls).toHaveLength(0);
  });

  it("reads an order's state, and cancels with DELETE", async () => {
    const { calls, impl } = fakeFetch([{ body: sampleOrder({ status: "filled", exec_quantity: 1, avg_fill_price: 3.4 }) }, { body: { order: { id: 4815162, status: "ok" } } }]);
    const ex = new TradierExecutor(baseConfig, impl);
    expect(await ex.getOrder("4815162")).toEqual({ status: "filled", filledQuantity: 1, averagePrice: 3.4 });
    await ex.cancelOrder("4815162");
    expect(calls.map((c) => `${c.method} ${c.url.replace(TRADIER_SANDBOX_URL, "")}`)).toEqual(["GET /accounts/ACC-TEST/orders/4815162", "DELETE /accounts/ACC-TEST/orders/4815162"]);
  });

  it("an HTTP error carries Tradier's message and status, never the token", async () => {
    const { impl } = fakeFetch([{ status: 401, body: "Invalid Access Token" }]);
    const err = await new TradierExecutor(baseConfig, impl).placeOpenOrder({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", positionType: "short_put_spread", shortStrike: 20_975, longStrike: 20_965, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 401.*Invalid Access Token/);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("an answer with no order id is an error, not a silent success", async () => {
    const { impl } = fakeFetch([{ body: { order: {} } }]);
    await expect(new TradierExecutor(baseConfig, impl).placeOpenOrder({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", positionType: "short_put_spread", shortStrike: 20_975, longStrike: 20_965, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06" })).rejects.toThrow(/no order id/);
  });
});

describe("order states map onto the engine's", () => {
  it.each([
    [{ status: "pending" }, { status: "working", filledQuantity: 0 }],
    [{ status: "open" }, { status: "working", filledQuantity: 0 }],
    [{ status: "pending_cancel" }, { status: "working", filledQuantity: 0 }],
    [{ status: "partially_filled", quantity: 3, exec_quantity: 1, avg_fill_price: 3.5 }, { status: "partially_filled", filledQuantity: 1, averagePrice: 3.5 }],
    [{ status: "open", quantity: 3, exec_quantity: 2, avg_fill_price: 3.5 }, { status: "partially_filled", filledQuantity: 2, averagePrice: 3.5 }],
    [{ status: "filled", quantity: 1, exec_quantity: 1, avg_fill_price: 3.45 }, { status: "filled", filledQuantity: 1, averagePrice: 3.45 }],
    [{ status: "canceled" }, { status: "canceled", filledQuantity: 0 }],
    [{ status: "expired" }, { status: "canceled", filledQuantity: 0 }],
    [{ status: "rejected", reason_description: "Insufficient buying power" }, { status: "rejected", filledQuantity: 0, rejectReason: "Insufficient buying power" }],
  ])("%j -> %j", (order, expected) => {
    expect(mapTradierOrder({ quantity: 1, exec_quantity: 0, ...order })).toEqual(expected);
  });

  it("an unknown status is an error - nothing is assumed", () => {
    expect(() => mapTradierOrder({ status: "teleported" })).toThrow(/doesn't know/);
  });

  it("no fill price is reported when nothing filled", () => {
    expect(mapTradierOrder({ status: "open", avg_fill_price: 9, exec_quantity: 0 })).toEqual({ status: "working", filledQuantity: 0 });
  });
});

describe("through the engine, with the kill switch and dry run", () => {
  const fast = { closeConfirmTimeoutMs: 100, orderFillTimeoutMs: 100, pollIntervalMs: 5 };
  const send = (direction: "bullish" | "bearish", barTime = "bar-1") =>
    receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 21_003.7, barTime, interval: "5", raw: { symbol: "NDX" }, now: BASE_NOW });

  it("a signal places a multileg order through the executor and the fill becomes the position's credit", async () => {
    const { calls, impl } = fakeFetch([{ body: sampleQuotes("NDXP261006P20970000", "NDXP261006P20960000") }, { body: SAMPLE_PLACED }, { body: sampleOrder({ status: "filled", quantity: 1, exec_quantity: 1, avg_fill_price: 3.4 }) }]);
    await processSignal(send("bullish"), { executor: new TradierExecutor(baseConfig, impl), now: BASE_NOW, ...fast });

    expect(calls[0].url).toContain("/markets/quotes?symbols=NDXP261006P20970000%2CNDXP261006P20960000"); // the legs priced off Tradier's own bid/ask
    expect(calls[1].form["option_symbol[0]"]).toBe("NDXP261006P20970000"); // root from the bot's config, strikes from the engine
    expect(calls[1].form.price).toBe("3.3"); // SmartPricing starts at the mid of the quote
    const position = positionsStore.query((p) => p.botId === NDX_BOT_ID)[0];
    expect(position).toMatchObject({ status: "open", credit: 3.4, venue: "tradier", optionRoot: "NDXP", brokerOrderRef: "4815162" });
    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["opened"]);
  });

  it("dry run decides and records, reads the quote to show its ladder, and never places an order", async () => {
    const { calls, impl } = fakeFetch([{ body: sampleQuotes("NDXP261006P20970000", "NDXP261006P20960000") }]);
    await processSignal(send("bullish"), { executor: new TradierExecutor(baseConfig, impl), now: BASE_NOW, dryRun: true, ...fast });
    expect(calls.map((c) => c.method)).toEqual(["GET"]); // a read-only quote, no POST
    expect(decisionsStore.all()[0].detail).toMatchObject({ pricing: { prices: [3.3, 3.1, 2.9, 2.7] } });
    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["dry_run"]);
    expect(positionsStore.all()).toHaveLength(0);
  });

  it("a bot switched off never reaches the executor - not even for a quote", async () => {
    botsStore.insert({ id: NDX_BOT_ID, enabled: false, needsAttention: false, needsAttentionReason: null, createdAt: 0 });
    const { calls, impl } = fakeFetch([]);
    await processSignal(send("bullish"), { executor: new TradierExecutor(baseConfig, impl), now: BASE_NOW, ...fast });
    expect(calls).toHaveLength(0);
    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["automations_off"]);
  });

  it("a rejected order is a rejected open, with Tradier's reason", async () => {
    const { impl } = fakeFetch([{ body: sampleQuotes("NDXP261006P20970000", "NDXP261006P20960000") }, { body: SAMPLE_PLACED }, { body: sampleOrder({ status: "rejected", reason_description: "Insufficient buying power" }) }]);
    await processSignal(send("bullish"), { executor: new TradierExecutor(baseConfig, impl), now: BASE_NOW, ...fast });
    expect(decisionsStore.all()[0]).toMatchObject({ outcome: "open_rejected" });
    expect(decisionsStore.all()[0].reason).toMatch(/Insufficient buying power/);
  });
});

describe("quotes, debit closes, positions", () => {
  const spread = { underlying: "NDX", optionRoot: "NDXP", expiry: "2026-10-06", type: "short_put_spread" as const, shortStrike: 20_970, longStrike: 20_960 };

  it("asks for both legs at once from the market-data endpoint, and returns each leg's bid and ask", async () => {
    const { calls, impl } = fakeFetch([{ body: sampleQuotes("NDXP261006P20970000", "NDXP261006P20960000") }]);
    const q = await new TradierExecutor(baseConfig, impl).getSpreadQuote(spread);
    expect(q).toEqual({ short: { bid: 12, ask: 12.6 }, long: { bid: 8.7, ask: 9.3 } });
    expect(calls[0]).toMatchObject({ method: "GET", url: `${TRADIER_SANDBOX_URL}/markets/quotes?symbols=NDXP261006P20970000%2CNDXP261006P20960000` });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns null - never a guess - when a leg is missing or has no bid or ask", async () => {
    const one = fakeFetch([{ body: { quotes: { quote: { symbol: "NDXP261006P20970000", bid: 12, ask: 12.6 } } } }]); // a single quote comes back as an object
    expect(await new TradierExecutor(baseConfig, one.impl).getSpreadQuote(spread)).toBeNull();
    const noAsk = fakeFetch([{ body: { quotes: { quote: [{ symbol: "NDXP261006P20970000", bid: 12, ask: null }, { symbol: "NDXP261006P20960000", bid: 8.7, ask: 9.3 }] } } }]);
    expect(await new TradierExecutor(baseConfig, noAsk.impl).getSpreadQuote(spread)).toBeNull();
    const unmatched = fakeFetch([{ body: { quotes: { unmatched_symbols: { symbol: ["X"] } } } }]);
    expect(await new TradierExecutor(baseConfig, unmatched.impl).getSpreadQuote(spread)).toBeNull();
  });

  it("won't guess an option root for a quote either", async () => {
    const { calls, impl } = fakeFetch([]);
    await expect(new TradierExecutor(baseConfig, impl).getSpreadQuote({ ...spread, optionRoot: undefined })).rejects.toThrow(/will not guess/);
    expect(calls).toHaveLength(0);
  });

  it("a close with a ladder price is a debit order at that price; with none it stays a market order", async () => {
    const { calls, impl } = fakeFetch([{ body: SAMPLE_PLACED }, { body: SAMPLE_PLACED }]);
    const position = buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 1, filledQuantity: 1 });
    const ex = new TradierExecutor(baseConfig, impl);
    await ex.placeCloseOrder(position, { limitDebit: 3.5 });
    await ex.placeCloseOrder(position);
    expect(calls[0].form).toMatchObject({ type: "debit", price: "3.5", "side[0]": "buy_to_close", "side[1]": "sell_to_close" });
    expect(calls[1].form).toMatchObject({ type: "market" });
    expect(calls[1].form.price).toBeUndefined();
  });

  it("lists what Tradier holds - nothing as the string \"null\", one position as an object, several as a list", async () => {
    const { impl } = fakeFetch([{ body: { positions: "null" } }, { body: { positions: { position: { symbol: "NDXP261006P20970000", quantity: -1 } } } }, { body: { positions: { position: [{ symbol: "A", quantity: -1 }, { symbol: "B", quantity: 1 }] } } }]);
    const ex = new TradierExecutor(baseConfig, impl);
    expect(await ex.listBrokerPositions()).toEqual([]);
    expect(await ex.listBrokerPositions()).toEqual([{ symbol: "NDXP261006P20970000", quantity: -1 }]);
    expect(await ex.listBrokerPositions()).toEqual([{ symbol: "A", quantity: -1 }, { symbol: "B", quantity: 1 }]);
  });
});

describe("balances", () => {
  it("reads total equity, option buying power and cash from the balances answer, and leaves the rest null", async () => {
    const { calls, impl } = fakeFetch([{ body: { balances: { total_equity: 100000, total_cash: 100000, margin: { option_buying_power: 98000 } } } }, { body: { balances: {} } }]);
    const ex = new TradierExecutor(baseConfig, impl);
    expect(await ex.getBalances()).toEqual({ accountId: "ACC-TEST", totalEquity: 100000, optionBuyingPower: 98000, cash: 100000 });
    expect(await ex.getBalances()).toEqual({ accountId: "ACC-TEST", totalEquity: null, optionBuyingPower: null, cash: null });
    expect(calls[0]).toMatchObject({ method: "GET", url: `${TRADIER_SANDBOX_URL}/accounts/ACC-TEST/balances` });
  });
});

describe("hard limits on real money", () => {
  const live = { ...baseConfig, baseUrl: TRADIER_PRODUCTION_URL, sandbox: false, maxContracts: 2, maxRiskPerOrder: 1500 };
  const req = (over: Partial<Parameters<TradierExecutor["placeOpenOrder"]>[0]> = {}) => ({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", positionType: "short_put_spread" as const, shortStrike: 20_970, longStrike: 20_960, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06", ...over });

  it("production won't start without both caps - they have no defaults", () => {
    const env = { TRADIER_TOKEN: "t", TRADIER_ACCOUNT_ID: "a", TRADIER_BASE_URL: TRADIER_PRODUCTION_URL, TRADIER_ALLOW_PRODUCTION: "true" };
    expect(() => readTradierConfig(env)).toThrow(/TRADIER_MAX_CONTRACTS_PER_ORDER and TRADIER_MAX_RISK_PER_ORDER/);
    expect(() => readTradierConfig({ ...env, TRADIER_MAX_CONTRACTS_PER_ORDER: "2" })).toThrow(/TRADIER_MAX_RISK_PER_ORDER/);
    expect(() => readTradierConfig({ ...env, TRADIER_MAX_CONTRACTS_PER_ORDER: "0", TRADIER_MAX_RISK_PER_ORDER: "1500" })).toThrow(/above 0/);
    expect(() => readTradierConfig({ TRADIER_TOKEN: "t", TRADIER_ACCOUNT_ID: "a" })).not.toThrow(); // the sandbox needs none
  });

  it("an opening order over the contract cap, or the risk cap, is refused before any request", async () => {
    const { calls, impl } = fakeFetch([]);
    const ex = new TradierExecutor(live, impl);
    await expect(ex.placeOpenOrder(req({ quantity: 3 }))).rejects.toThrow(/3 contracts is over the limit of 2/);
    await expect(ex.placeOpenOrder(req({ quantity: 2, shortStrike: 20_970, longStrike: 20_880, limitCredit: 3 }))).rejects.toThrow(/risks \$17400, over the limit of \$1500/);
    expect(calls).toHaveLength(0);
  });

  it("an order within the caps goes through, and closing is never capped", async () => {
    const { calls, impl } = fakeFetch([{ body: SAMPLE_PLACED }, { body: SAMPLE_PLACED }]);
    const ex = new TradierExecutor(live, impl);
    await ex.placeOpenOrder(req({ quantity: 1 })); // risks 10 x 100 - 350 = $650
    await ex.placeCloseOrder(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 9, filledQuantity: 9 }));
    expect(calls).toHaveLength(2);
  });

  it("a limit credit that isn't below the width (or isn't a credit) is refused, sandbox or not", async () => {
    const { calls, impl } = fakeFetch([]);
    const ex = new TradierExecutor(baseConfig, impl);
    await expect(ex.placeOpenOrder(req({ limitCredit: 10 }))).rejects.toThrow(/not a credit between 0 and the width \(10\)/);
    await expect(ex.placeOpenOrder(req({ limitCredit: 0 }))).rejects.toThrow(/not a credit/);
    expect(calls).toHaveLength(0);
  });
});

describe("choosing the executor", () => {
  it("is the mock unless EXECUTOR says otherwise", () => {
    vi.stubEnv("EXECUTOR", "");
    expect(executorKind()).toBe("mock");
    expect(executorStatus()).toMatchObject({ kind: "mock", venue: "mock", error: null });
    expect(getExecutor()).toBeInstanceOf(MockExecutor);
  });

  it("rejects an unknown value instead of falling back", () => {
    vi.stubEnv("EXECUTOR", "bogus");
    expect(() => executorKind()).toThrow(/"mock" or "tradier"/);
    expect(executorStatus().error).toMatch(/"mock" or "tradier"/);
  });

  it("EXECUTOR=tradier without credentials is an error status, and signals are refused with 503", () => {
    vi.stubEnv("EXECUTOR", "tradier");
    vi.stubEnv("TRADIER_TOKEN", "");
    vi.stubEnv("TRADIER_ACCOUNT_ID", "");
    expect(executorStatus().error).toMatch(/TRADIER_TOKEN, TRADIER_ACCOUNT_ID/);
    expect(() => getExecutor()).toThrow(TradierConfigError);

    vi.stubEnv("WEBHOOK_SECRET", "s3cret-test");
    const result = ingestWebhook({ secret: "s3cret-test", bot: NDX_BOT_ID, signal: "bullish", symbol: "NDX", price: 21_000, bar_time: "t", interval: "5" }, { executor: sharedExecutor });
    expect(result.status).toBe(503);
    expect(String(result.body.error)).toMatch(/TRADIER_TOKEN/);
    expect(positionsStore.all()).toHaveLength(0);
  });

  it("the shared executor offers quotes, broker positions and balances exactly when the executor behind it does", () => {
    vi.stubEnv("EXECUTOR", "mock");
    expect(sharedExecutor.getSpreadQuote).toBeUndefined();
    expect(sharedExecutor.listBrokerPositions).toBeUndefined();
    expect(sharedExecutor.getBalances).toBeUndefined();
    vi.stubEnv("EXECUTOR", "tradier");
    vi.stubEnv("TRADIER_TOKEN", "TEST-TOKEN-not-real");
    vi.stubEnv("TRADIER_ACCOUNT_ID", "ACC-TEST");
    expect(typeof sharedExecutor.getSpreadQuote).toBe("function");
    expect(typeof sharedExecutor.listBrokerPositions).toBe("function");
    expect(typeof sharedExecutor.getBalances).toBe("function");
    // Misconfigured: nothing is offered (and nothing throws).
    vi.stubEnv("TRADIER_TOKEN", "");
    expect(sharedExecutor.getSpreadQuote).toBeUndefined();
  });

  it("EXECUTOR=tradier with credentials builds the sandbox executor - and still makes no request", () => {
    vi.stubEnv("EXECUTOR", "tradier");
    vi.stubEnv("TRADIER_TOKEN", "TEST-TOKEN-not-real");
    vi.stubEnv("TRADIER_ACCOUNT_ID", "ACC-TEST");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(executorStatus()).toMatchObject({ kind: "tradier", venue: "tradier", error: null, baseUrl: TRADIER_SANDBOX_URL, sandbox: true });
    expect(getExecutor()).toBeInstanceOf(TradierExecutor);
    expect(sharedExecutor.venue).toBe("tradier");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
