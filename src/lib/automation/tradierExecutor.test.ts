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

// SAMPLE shapes (not recorded) of POST /orders and GET /orders/{id}.
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
    expect(readTradierConfig({ ...env, TRADIER_ALLOW_PRODUCTION: "true" })).toMatchObject({ baseUrl: TRADIER_PRODUCTION_URL, sandbox: false });
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
    const { calls, impl } = fakeFetch([{ body: SAMPLE_PLACED }, { body: sampleOrder({ status: "filled", quantity: 1, exec_quantity: 1, avg_fill_price: 3.4 }) }]);
    await processSignal(send("bullish"), { executor: new TradierExecutor(baseConfig, impl), now: BASE_NOW, ...fast });

    expect(calls[0].form["option_symbol[0]"]).toBe("NDXP261006P20970000"); // root from the bot's config, strikes from the engine
    const position = positionsStore.query((p) => p.botId === NDX_BOT_ID)[0];
    expect(position).toMatchObject({ status: "open", credit: 3.4, venue: "tradier", optionRoot: "NDXP", brokerOrderRef: "4815162" });
    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["opened"]);
  });

  it("dry run decides and records but never calls the executor", async () => {
    const { calls, impl } = fakeFetch([]);
    await processSignal(send("bullish"), { executor: new TradierExecutor(baseConfig, impl), now: BASE_NOW, dryRun: true, ...fast });
    expect(calls).toHaveLength(0);
    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["dry_run"]);
    expect(positionsStore.all()).toHaveLength(0);
  });

  it("a bot switched off never reaches the executor", async () => {
    botsStore.insert({ id: NDX_BOT_ID, enabled: false, needsAttention: false, needsAttentionReason: null, createdAt: 0 });
    const { calls, impl } = fakeFetch([]);
    await processSignal(send("bullish"), { executor: new TradierExecutor(baseConfig, impl), now: BASE_NOW, ...fast });
    expect(calls).toHaveLength(0);
    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["automations_off"]);
  });

  it("a rejected order is a rejected open, with Tradier's reason", async () => {
    const { impl } = fakeFetch([{ body: SAMPLE_PLACED }, { body: sampleOrder({ status: "rejected", reason_description: "Insufficient buying power" }) }]);
    await processSignal(send("bullish"), { executor: new TradierExecutor(baseConfig, impl), now: BASE_NOW, ...fast });
    expect(decisionsStore.all()[0]).toMatchObject({ outcome: "open_rejected" });
    expect(decisionsStore.all()[0].reason).toMatch(/Insufficient buying power/);
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
    vi.stubEnv("EXECUTOR", "ibkr");
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
