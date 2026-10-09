import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as hookRoute } from "@/app/api/webhook/hook/[token]/route";
import { createWebhook, findWebhookByToken } from "./webhooks";
import { decisionsStore as allDecisions, ordersStore, positionsStore, signalsStore } from "./store";

// Attaching a webhook to a trigger is logged too; these tests are about what a TradingView call does.
const decisionsStore = { all: () => allDecisions.all().filter((d) => d.signalId !== null) };
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";

// The bot's own live quote, as the app's price feed would give it: a webhook call carries no price. No network.
vi.mock("@/lib/marketData/tickStore", () => ({
  waitForTick: async () => ({ t: Date.now(), price: 21_003.7 }),
  getLastTick: () => ({ t: Date.now(), price: 21_003.7 }),
  isLiveSymbol: () => false,
}));


// The whole NDX path, from a TradingView call to an order on Tradier's SANDBOX, with Tradier replaced by a fake
// HTTP layer. It proves the pieces fit together; it does not prove anything about Tradier's real answers.

setTestBotEnv();
setNdxTestEnv();

interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  form: Record<string, string>;
}

let requests: Req[];
let nextOrderId: number;
const orders = new Map<string, Record<string, unknown>>();

/** A pretend Tradier sandbox: quotes for whatever legs are asked for, orders that fill at once. */
function fakeTradier() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      const u = new URL(url);
      const form = Object.fromEntries(new URLSearchParams(init.body ?? ""));
      requests.push({ method: init.method, url, headers: init.headers, form });
      const reply = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

      if (u.pathname.endsWith("/markets/quotes")) {
        const [short, long] = (u.searchParams.get("symbols") ?? "").split(",");
        return reply({ quotes: { quote: [{ symbol: short, bid: 12.0, ask: 12.6 }, { symbol: long, bid: 8.7, ask: 9.3 }] } });
      }
      if (init.method === "POST" && u.pathname.endsWith("/orders")) {
        const id = String(nextOrderId++);
        orders.set(id, { id: Number(id), status: "filled", quantity: Number(form["quantity[0]"]), exec_quantity: Number(form["quantity[0]"]), avg_fill_price: form.price ? Number(form.price) : 3.1 });
        return reply({ order: { id: Number(id), status: "ok" } });
      }
      const m = /\/orders\/(\d+)$/.exec(u.pathname);
      if (m && init.method === "GET") return reply({ order: orders.get(m[1]) });
      return { ok: false, status: 404, text: async () => `unexpected ${init.method} ${u.pathname}` };
    }),
  );
}

const call = (token: string, body: string) => hookRoute(new NextRequest(`http://localhost/hook/${token}`, { method: "POST", body: `${body} ${findWebhookByToken(token)?.direction ?? ""}` }), { params: Promise.resolve({ token }) });
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error("timed out waiting");
}

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  requests = [];
  nextOrderId = 9001;
  orders.clear();
  vi.stubEnv("EXECUTOR", "tradier");
  vi.stubEnv("TRADIER_TOKEN", "SANDBOX-TOKEN-not-real");
  vi.stubEnv("TRADIER_ACCOUNT_ID", "ACC-PAPER");
  vi.stubEnv("TRADIER_BASE_URL", "");
  vi.stubEnv("BOT_NDX_EMA_BIAS_PUT_SHORT_OFFSET", "");
  vi.stubEnv("BOT_NDX_EMA_BIAS_CALL_SHORT_OFFSET", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_NOW); // inside trading hours
  fakeTradier();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("NDX: a TradingView call becomes a paper order on Tradier's sandbox", () => {
  it("bullish: quotes the two legs, sends one multileg credit order, and the fill becomes the open position", async () => {
    const bull = createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
    const res = await call(bull.token, '{"price":21003.7,"bar_time":"2026-10-06T14:40:00Z","interval":"5"}');
    expect(res.status).toBe(200);
    await until(() => decisionsStore.all().length > 0);

    // Everything went to the sandbox, with the sandbox token, and nowhere else.
    expect(requests.every((r) => r.url.startsWith("https://sandbox.tradier.com/v1/"))).toBe(true);
    expect(requests.every((r) => r.headers.Authorization === "Bearer SANDBOX-TOKEN-not-real")).toBe(true);
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /v1/markets/quotes",
      "POST /v1/accounts/ACC-PAPER/orders",
      "GET /v1/accounts/ACC-PAPER/orders/9001",
    ]);
    expect(new URL(requests[0].url).searchParams.get("symbols")).toBe("NDXP261006P21000000,NDXP261006P20990000");

    // One multileg credit order: sell the 21,000 put, buy the 20,990 put, at the mid of the quote (3.30).
    expect(requests[1].form).toEqual({
      class: "multileg",
      symbol: "NDX",
      type: "credit",
      duration: "day",
      price: "3.3",
      "option_symbol[0]": "NDXP261006P21000000",
      "side[0]": "sell_to_open",
      "quantity[0]": "1",
      "option_symbol[1]": "NDXP261006P20990000",
      "side[1]": "buy_to_open",
      "quantity[1]": "1",
    });

    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["opened"]);
    expect(positionsStore.all()[0]).toMatchObject({ botId: NDX_BOT_ID, underlying: "NDX", type: "short_put_spread", shortStrike: 21_000, longStrike: 20_990, status: "open", credit: 3.3, venue: "tradier", optionRoot: "NDXP", brokerOrderRef: "9001" });
    expect(ordersStore.all().map((o) => [o.kind, o.status, o.limitPrice])).toEqual([["open", "filled", 3.3]]);
    expect(signalsStore.all()[0]).toMatchObject({ botId: NDX_BOT_ID, signal: "bullish", status: "accepted" });
  });

  it("a bearish call after a bullish one is a flip: close the put spread, wait for the fill, then open the call spread", async () => {
    const bull = createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
    const bear = createWebhook({ name: "BearishNDX", botId: NDX_BOT_ID, direction: "bearish" });
    await call(bull.token, '{"price":21003.7,"bar_time":"b1"}');
    await until(() => positionsStore.all().some((p) => p.status === "open"));
    requests.length = 0;

    vi.setSystemTime(BASE_NOW + 5 * 60_000);
    await call(bear.token, '{"price":21003.7,"bar_time":"b2"}');
    await until(() => decisionsStore.all().length >= 3);

    const posts = requests.filter((r) => r.method === "POST").map((r) => r.form);
    expect(posts).toHaveLength(2);
    // First the close: buy back the 21,000 put, sell the 20,990 put, as a debit order at the mid.
    expect(posts[0]).toMatchObject({ class: "multileg", type: "debit", price: "3.3", "option_symbol[0]": "NDXP261006P21000000", "side[0]": "buy_to_close", "option_symbol[1]": "NDXP261006P20990000", "side[1]": "sell_to_close" });
    // Then the open: the call spread, short 21,005 / long 21,015.
    expect(posts[1]).toMatchObject({ type: "credit", "option_symbol[0]": "NDXP261006C21005000", "side[0]": "sell_to_open", "option_symbol[1]": "NDXP261006C21015000", "side[1]": "buy_to_open" });

    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["opened", "closed", "opened"]);
    const byType = Object.fromEntries(positionsStore.all().map((p) => [p.type, p]));
    expect(byType.short_put_spread).toMatchObject({ status: "closed", closePrice: 3.3 });
    expect(byType.short_call_spread).toMatchObject({ status: "open", shortStrike: 21_005, longStrike: 21_015 });
  });

  it("never touches Tradier's production address, even when asked to via the webhook body", async () => {
    const bull = createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
    await call(bull.token, '{"price":21003.7,"base_url":"https://api.tradier.com/v1","TRADIER_BASE_URL":"https://api.tradier.com/v1"}');
    await until(() => decisionsStore.all().length > 0);
    expect(requests.some((r) => r.url.includes("api.tradier.com"))).toBe(false);
  });

  it("the broker rejecting the order is a rejected open, with Tradier's reason, and the bot is flagged for nobody to guess at", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { method: string; body?: string }) => {
        const u = new URL(url);
        const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
        if (u.pathname.endsWith("/markets/quotes")) {
          const [s, l] = (u.searchParams.get("symbols") ?? "").split(",");
          return ok({ quotes: { quote: [{ symbol: s, bid: 12, ask: 12.6 }, { symbol: l, bid: 8.7, ask: 9.3 }] } });
        }
        if (init.method === "POST") return ok({ order: { id: 1, status: "ok" } });
        return ok({ order: { id: 1, status: "rejected", quantity: 1, exec_quantity: 0, reason_description: "Insufficient buying power" } });
      }),
    );
    const bull = createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
    await call(bull.token, '{"price":21003.7}');
    await until(() => decisionsStore.all().length > 0);
    expect(decisionsStore.all()[0]).toMatchObject({ outcome: "open_rejected" });
    expect(decisionsStore.all()[0].reason).toMatch(/Insufficient buying power/);
    expect(positionsStore.all()[0].status).toBe("rejected");
  });
});
