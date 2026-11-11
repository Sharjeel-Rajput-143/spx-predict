import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DerivApiError,
  DerivAuthError,
  DerivConfigError,
  DerivExecutor,
  contractIdOf,
  contractTypeFor,
  isDemoUrl,
  readDerivConfig,
  toEngineUnits,
  type DerivConfig,
} from "./derivExecutor";
import { ACCOUNT, APP_ID, DEMO_URL, FakeDeriv, REAL_URL, TOKEN } from "./derivTestSupport";
import { OrderNotPlacedError } from "./orderErrors";
import { positionsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import type { OpenSpreadRequest } from "./types";

// The fake Deriv (REST sign-in and WebSocket, in memory) lives in derivTestSupport.ts. Nothing here touches a network, and no real token exists.
const baseConfig = (over: Partial<DerivConfig> = {}): DerivConfig => ({
  token: TOKEN,
  appId: APP_ID,
  accountId: ACCOUNT,
  apiBase: "https://api.derivws.com",
  symbol: "OTC_NDX",
  product: "rise_fall",
  stake: 10,
  maxStake: 100,
  currency: "USD",
  duration: 1,
  durationUnit: "h",
  maxSlippage: 0.02,
  allowReal: false,
  timeoutMs: 1500,
  hoursStart: "09:35",
  hoursEnd: "15:55",
  lastBuyMarginMinutes: 5,
  ...over,
});

const open = (over: Partial<OpenSpreadRequest> = {}): OpenSpreadRequest => ({
  botId: NDX_BOT_ID,
  underlying: "NDX",
  optionRoot: "NDXP",
  positionType: "short_put_spread",
  shortStrike: 29_250,
  longStrike: 29_200,
  quantity: 1,
  limitCredit: 3.5,
  expiry: "2026-10-27",
  clientOrderId: "sig-1:open:1",
  ...over,
});

let deriv: FakeDeriv;
let logs: string[];
// The clock stands at 10:40am New York time on a Tuesday (inside the trading window) unless a test moves it.
let now = BASE_NOW;
const make = (config = baseConfig()) => new DerivExecutor(config, deriv.fetch, deriv.socketFactory, (l) => logs.push(l), () => now);

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  deriv = new FakeDeriv();
  logs = [];
  now = BASE_NOW;
});

describe("the settings", () => {
  const env = { DERIV_API_TOKEN: TOKEN, DERIV_APP_ID: APP_ID, DERIV_ACCOUNT_ID: ACCOUNT };

  it("reads the three required names and the defaults: demo-safe, US Tech 100, Rise/Fall", () => {
    expect(readDerivConfig(env)).toMatchObject({ accountId: ACCOUNT, apiBase: "https://api.derivws.com", symbol: "OTC_NDX", product: "rise_fall", stake: 10, maxStake: 100, currency: "USD", duration: 1, durationUnit: "h", allowReal: false });
  });

  it("names every missing required setting at once, and never a value", () => {
    expect(() => readDerivConfig({})).toThrow(/DERIV_API_TOKEN, DERIV_APP_ID, DERIV_ACCOUNT_ID are not set/);
    expect(() => readDerivConfig({ DERIV_API_TOKEN: TOKEN })).toThrow(/DERIV_APP_ID, DERIV_ACCOUNT_ID are not set/);
    try {
      readDerivConfig({ ...env, DERIV_STAKE: "abc" });
    } catch (err) {
      expect(String(err)).not.toContain(TOKEN);
      expect(err).toBeInstanceOf(DerivConfigError);
    }
  });

  it("refuses nonsense: a bad product, unit, stake, address, and a multiplier product without a multiplier", () => {
    expect(() => readDerivConfig({ ...env, DERIV_PRODUCT: "turbo" })).toThrow(/DERIV_PRODUCT/);
    expect(() => readDerivConfig({ ...env, DERIV_DURATION_UNIT: "w" })).toThrow(/DERIV_DURATION_UNIT/);
    expect(() => readDerivConfig({ ...env, DERIV_STAKE: "0.1" })).toThrow(/DERIV_STAKE/);
    expect(() => readDerivConfig({ ...env, DERIV_API_BASE: "http://x" })).toThrow(/https/);
    expect(() => readDerivConfig({ ...env, DERIV_PRODUCT: "multiplier" })).toThrow(/DERIV_MULTIPLIER/);
    expect(readDerivConfig({ ...env, DERIV_PRODUCT: "multiplier", DERIV_MULTIPLIER: "100" })).toMatchObject({ product: "multiplier", multiplier: 100 });
  });
});

describe("helpers", () => {
  it("a bullish signal is an UP contract, a bearish one a DOWN contract, for both products", () => {
    expect(contractTypeFor("rise_fall", "short_put_spread")).toBe("CALL");
    expect(contractTypeFor("rise_fall", "short_call_spread")).toBe("PUT");
    expect(contractTypeFor("multiplier", "short_put_spread")).toBe("MULTUP");
    expect(contractTypeFor("multiplier", "short_call_spread")).toBe("MULTDOWN");
  });
  it("order references carry the contract id", () => {
    expect(contractIdOf("deriv-buy-123")).toBe(123);
    expect(contractIdOf("deriv-sell-123")).toBe(123);
    for (const bad of ["123", "deriv-buy-", "deriv-buy-x", "ib-1", null, undefined, "deriv-buy--4"]) expect(contractIdOf(bad as string)).toBeNull();
  });
  it("the demo address is the one with /demo in its path", () => {
    expect(isDemoUrl(DEMO_URL)).toBe(true);
    expect(isDemoUrl(REAL_URL)).toBe(false);
    expect(isDemoUrl("not a url")).toBe(false);
  });
  it("engine units are hundredths of a dollar", () => expect(toEngineUnits(10)).toBe(0.1));
});

describe("1. sign in and connect (acceptance 1, 6)", () => {
  it("exchanges the token for a one-time address (Bearer token and Deriv-App-ID), connects to it and pings", async () => {
    const r = await make().checkConnection();
    expect(r).toEqual({ demo: true, accountId: ACCOUNT });
    expect(deriv.restCalls).toHaveLength(1);
    expect(deriv.restCalls[0]).toMatchObject({ method: "POST", url: `https://api.derivws.com/trading/v1/options/accounts/${ACCOUNT}/otp` });
    expect(deriv.restCalls[0].headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(deriv.restCalls[0].headers["Deriv-App-ID"]).toBe(APP_ID);
    expect(deriv.opened[0]).toBe("wss://api.derivws.com/trading/v1/options/ws/demo?otp=otp-1");
    expect(deriv.calls("ping")).toHaveLength(1);
    expect(deriv.closedCount).toBe(1);
    expect(logs.join("\n")).toMatch(/connected to account VRTC1234567 \(demo\)/);
  });

  it("every operation gets its own one-time address: the same one is never used twice", async () => {
    const ex = make();
    await ex.checkConnection();
    await ex.checkConnection();
    expect(new Set(deriv.opened).size).toBe(2);
  });

  it("a refused sign-in (wrong token) FAILS LOUDLY with Deriv's own words, and the token is not in them", async () => {
    const ex = make(baseConfig({ token: "wrong-token-VALUE-9999" }));
    const err = await ex.checkConnection().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DerivAuthError);
    expect((err as DerivAuthError).message).toMatch(/Deriv refused the sign-in \(HTTP 401, InvalidToken\): The token is not valid/);
    expect((err as DerivAuthError).status).toBe(401);
    expect(String((err as Error).message)).not.toContain("wrong-token-VALUE-9999");
    expect(deriv.opened).toEqual([]); // nothing was connected to
  });

  it("a missing app id comes back as Deriv's 401, said plainly", async () => {
    const err = await make(baseConfig({ appId: "" })).checkConnection().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/HTTP 401.*Deriv-App-ID header is required/);
  });

  it("a server error on the sign-in, an answer with no address, a network failure: each is an error, none is swallowed", async () => {
    deriv.otpStatus = 500;
    await expect(make().checkConnection()).rejects.toThrow(/HTTP 500, ServerError/);
    deriv.otpStatus = 200;
    deriv.otpBody = { data: {} };
    await expect(make().checkConnection()).rejects.toThrow(/without a WebSocket address/);
    deriv.otpBody = null;
    const down = new DerivExecutor(baseConfig(), async () => {
      throw new TypeError(`fetch failed for ${TOKEN}`);
    }, deriv.socketFactory, () => {});
    const err = await down.checkConnection().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/could not be sent/);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("a WebSocket that will not open (an expired or used password) is an error", async () => {
    deriv.usedOtps.add("otp-1");
    await expect(make().checkConnection()).rejects.toThrow(/could not be opened/);
  });

  it("a WebSocket that opens but never answers times out with an error", async () => {
    deriv.silent.add("ping");
    await expect(make(baseConfig({ timeoutMs: 1000 })).checkConnection()).rejects.toThrow(/did not answer "ping"/);
  });

  it("a REAL account is refused before anything is connected, unless DERIV_ALLOW_REAL=true", async () => {
    deriv.otpUrl = REAL_URL;
    const err = await make().checkConnection().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/not a demo account/);
    expect(deriv.opened).toEqual([]);
    expect((await make(baseConfig({ allowReal: true })).checkConnection()).demo).toBe(false);
  });

  it("isPaperAccount follows the address, and is false when the sign-in fails", async () => {
    expect(await make().isPaperAccount()).toBe(true);
    deriv.otpStatus = 401;
    expect(await make().isPaperAccount()).toBe(false);
  });
});

describe("2. a live price for US Tech 100 (acceptance 2)", () => {
  it("reads the latest tick from the public feed, with no token, as a real-time quote", async () => {
    const q = await make().getUnderlyingQuote("NDX");
    expect(q).toEqual({ symbol: "NDX", price: 29284.55, asOf: 1793044542 * 1000, delayed: false });
    expect(deriv.restCalls).toHaveLength(0); // no sign-in needed
    expect(deriv.opened[0]).toBe("wss://api.derivws.com/trading/v1/options/ws/public");
    expect(deriv.sent[0]).toMatchObject({ ticks_history: "OTC_NDX", end: "latest", count: 1, style: "ticks" });
  });

  it("is null for an underlying it does not trade, and for an empty answer", async () => {
    expect(await make().getUnderlyingQuote("SPX")).toBeNull();
    deriv.handlers.ticks_history = () => ({ history: { prices: [], times: [] } });
    expect(await make().getUnderlyingQuote("NDX")).toBeNull();
  });

  it("fetches a proposal for the contract an opening would buy, without buying", async () => {
    const p = await make().getProposal("short_put_spread");
    expect(p).toMatchObject({ id: "prop-1", askPrice: 10, spot: 29290.1, payout: 18.15, contractType: "CALL" });
    expect(deriv.calls("proposal")[0]).toMatchObject({ proposal: 1, contract_type: "CALL", amount: 10, basis: "stake", currency: "USD", underlying_symbol: "OTC_NDX", duration: 1, duration_unit: "h" });
    expect(deriv.calls("buy")).toHaveLength(0);
  });
});

describe("3. open a position (acceptance 3, 5)", () => {
  it("a bullish signal buys CALL on US Tech 100: proposal, then a buy of that proposal with a ceiling just above the ask; the contract id is logged and is the order reference", async () => {
    const { ref } = await make().placeOpenOrder(open());
    expect(ref).toBe("deriv-buy-987654321");
    expect(deriv.calls("proposal")[0]).toMatchObject({ contract_type: "CALL", underlying_symbol: "OTC_NDX", amount: 10 });
    expect(deriv.calls("buy")[0]).toMatchObject({ buy: "prop-1", price: 10.2 }); // ask 10 + 2%
    expect(logs.join("\n")).toMatch(/bought contract 987654321: CALL OTC_NDX stake \$10, transaction 5550001, account VRTC1234567/);
    expect(deriv.restCalls).toHaveLength(1); // one sign-in for the whole operation
    expect(deriv.closedCount).toBe(1);
  });

  it("a bearish signal buys PUT", async () => {
    await make().placeOpenOrder(open({ positionType: "short_call_spread", clientOrderId: "s2:open:1" }));
    expect(deriv.calls("proposal")[0]).toMatchObject({ contract_type: "PUT" });
  });

  it("the stake is the setting times the contracts, and an order over DERIV_MAX_STAKE is refused with nothing sent", async () => {
    await make().placeOpenOrder(open({ quantity: 3 }));
    expect(deriv.calls("proposal")[0]).toMatchObject({ amount: 30 });
    deriv.sent.length = 0;
    const err = await make(baseConfig({ maxStake: 25 })).placeOpenOrder(open({ quantity: 3, clientOrderId: "x" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect((err as Error).message).toMatch(/over the limit of \$25 per order \(DERIV_MAX_STAKE\)/);
    expect(deriv.sent).toEqual([]);
    expect(deriv.restCalls).toHaveLength(1); // no sign-in either
  });

  it("refuses an underlying it does not trade, and a bad quantity", async () => {
    await expect(make().placeOpenOrder(open({ underlying: "SPX" }))).rejects.toThrow(/NDX only/);
    await expect(make().placeOpenOrder(open({ quantity: 0 }))).rejects.toThrow(/whole number/);
    await expect(make().placeOpenOrder(open({ quantity: 1.5 }))).rejects.toThrow(OrderNotPlacedError);
  });

  it("the same order id with the same order never buys twice; with a different order it is refused", async () => {
    const ex = make();
    const a = await ex.placeOpenOrder(open());
    const b = await ex.placeOpenOrder(open());
    expect(b).toEqual(a);
    expect(deriv.calls("buy")).toHaveLength(1);
    await expect(ex.placeOpenOrder(open({ positionType: "short_call_spread" }))).rejects.toThrow(/already used with a different order/);
    expect(deriv.calls("buy")).toHaveLength(1);
  });

  it("a refused proposal (for example a duration that is not offered) means nothing was bought, and says Deriv's words", async () => {
    deriv.handlers.proposal = () => ({ error: { code: "ContractBuyValidationError", message: "Trading is not offered for this duration." } });
    const err = await make().placeOpenOrder(open()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect((err as Error).message).toMatch(/Deriv refused the request: ContractBuyValidationError: Trading is not offered for this duration\./);
    expect(deriv.calls("buy")).toHaveLength(0);
  });

  it("a refused buy means nothing was bought", async () => {
    deriv.handlers.buy = () => ({ error: { code: "InsufficientBalance", message: "Your account balance is insufficient." } });
    const err = await make().placeOpenOrder(open()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect((err as Error).message).toMatch(/InsufficientBalance/);
  });

  it("a buy that gets no answer is NOT called refused: the contract may exist, and the message says to check the portfolio", async () => {
    deriv.silent.add("buy");
    const err = await make(baseConfig({ timeoutMs: 1000 })).placeOpenOrder(open()).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(OrderNotPlacedError);
    expect((err as Error).message).toMatch(/did not answer "buy".*may have gone through: check the Deriv portfolio/);
  });

  it("a sign-in failure stops the order before anything is proposed or bought", async () => {
    deriv.otpStatus = 401;
    const err = await make().placeOpenOrder(open()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(deriv.sent).toEqual([]);
  });

  it("a proposal with no usable price is an error, not a guess", async () => {
    deriv.handlers.proposal = () => ({ proposal: { id: "p", ask_price: 0 } });
    await expect(make().placeOpenOrder(open())).rejects.toThrow(/without a usable id and price/);
  });
});

describe("Multipliers: supported where Deriv offers them, and a loud refusal where it does not", () => {
  const multi = () => make(baseConfig({ product: "multiplier", multiplier: 100 }));

  it("on US Tech 100, which Deriv does not offer Multipliers on, it refuses in plain words before buying anything", async () => {
    const err = await multi().placeOpenOrder(open()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect((err as Error).message).toMatch(/Deriv does not offer MULTUP \(Multipliers\) on OTC_NDX\. Set DERIV_PRODUCT=rise_fall/);
    expect(deriv.calls("proposal")).toHaveLength(0);
    expect(deriv.calls("buy")).toHaveLength(0);
  });

  it("on a symbol that does offer them it buys MULTUP with the multiplier and no duration", async () => {
    const ex = make(baseConfig({ product: "multiplier", multiplier: 100, symbol: "R_100" }));
    await ex.placeOpenOrder(open());
    expect(deriv.calls("proposal")[0]).toMatchObject({ contract_type: "MULTUP", multiplier: 100, underlying_symbol: "R_100" });
    expect(deriv.calls("proposal")[0]).not.toHaveProperty("duration");
  });
});

describe("reading an order back", () => {
  it("a buy is filled once the contract exists, with the stake as the engine's credit (hundredths of a dollar)", async () => {
    const { ref } = await make().placeOpenOrder(open());
    expect(await make().getOrder(ref)).toEqual({ status: "filled", filledQuantity: 1, averagePrice: 0.1 });
  });

  it("with several contracts the quantity and the per-contract credit come back", async () => {
    const { ref } = await make().placeOpenOrder(open({ quantity: 3 }));
    expect(await make().getOrder(ref)).toEqual({ status: "filled", filledQuantity: 3, averagePrice: 0.1 });
  });

  it("a sell is working until the contract is sold, then filled", async () => {
    const { ref } = await make().placeOpenOrder(open());
    expect(await make().getOrder("deriv-sell-987654321")).toEqual({ status: "working", filledQuantity: 0 });
    deriv.contracts.get(987654321)!.sold = true;
    deriv.contracts.get(987654321)!.sale = 12;
    expect((await make().getOrder("deriv-sell-987654321")).status).toBe("filled");
    expect(ref).toBe("deriv-buy-987654321");
  });

  it("the close price is chosen so the engine's (credit - close price) x 100 is the profit in dollars: a win, a loss, a break-even", async () => {
    for (const [sale, profit] of [[12, 2], [4, -6], [10, 0], [18.15, 8.15]] as const) {
      const { ref } = await make().placeOpenOrder(open({ clientOrderId: `id-${sale}` }));
      const id = Number(ref.replace("deriv-buy-", ""));
      deriv.contracts.get(id)!.sold = true;
      deriv.contracts.get(id)!.sale = sale;
      const buy = await make().getOrder(ref);
      const sell = await make().getOrder(`deriv-sell-${id}`);
      expect(((buy.averagePrice ?? 0) - (sell.averagePrice ?? 0)) * 100).toBeCloseTo(profit, 6);
    }
  });

  it("a reference that is not Deriv's, and a contract Deriv does not know, are errors", async () => {
    await expect(make().getOrder("ib-12")).rejects.toThrow(/not a Deriv order reference/);
    await expect(make().getOrder("deriv-buy-5")).rejects.toThrow(/ContractNotFound/);
  });

  it("there is nothing to cancel, and it says so rather than pretending", async () => {
    await make().cancelOrder("deriv-buy-1");
    expect(logs.join("\n")).toMatch(/nothing to cancel for deriv-buy-1/);
  });
});

describe("4. close a position (acceptance 4, 5)", () => {
  const held = async (ref: string) =>
    buildPosition({ id: "pos-1", botId: NDX_BOT_ID, underlying: "NDX", type: "short_put_spread", status: "open", requestedQuantity: 1, filledQuantity: 1, brokerOrderRef: ref, credit: 0.1 });

  it("sells the contract at market (price 0), logs the contract id and the sale, and the sell is then read back as filled", async () => {
    const { ref } = await make().placeOpenOrder(open());
    deriv.saleValue = 12;
    const out = await make().placeCloseOrder(await held(ref));
    expect(out.ref).toBe("deriv-sell-987654321");
    expect(deriv.calls("sell")[0]).toEqual(expect.objectContaining({ sell: 987654321, price: 0 }));
    expect(logs.join("\n")).toMatch(/sold contract 987654321 for \$12, transaction 5550002, account VRTC1234567/);
    expect(await make().getOrder(out.ref)).toEqual({ status: "filled", filledQuantity: 1, averagePrice: 0.08 });
  });

  it("finds the contract from a close order's own reference too (the engine keeps the latest reference on the position)", async () => {
    const { ref } = await make().placeOpenOrder(open());
    const out = await make().placeCloseOrder(await held(ref.replace("buy", "sell")));
    expect(out.ref).toBe("deriv-sell-987654321");
  });

  it("a contract that is already sold is not sold again: its sale is read instead", async () => {
    const { ref } = await make().placeOpenOrder(open());
    deriv.contracts.get(987654321)!.sold = true;
    deriv.contracts.get(987654321)!.sale = 9;
    const out = await make().placeCloseOrder(await held(ref));
    expect(out.ref).toBe("deriv-sell-987654321");
    expect(deriv.calls("sell")).toHaveLength(0);
  });

  it("a contract Deriv says cannot be sold now is refused with its reason, and nothing is sent", async () => {
    const { ref } = await make().placeOpenOrder(open());
    deriv.contracts.get(987654321)!.valid = false;
    deriv.contracts.get(987654321)!.error = "Resale of this contract is not offered.";
    const err = await make().placeCloseOrder(await held(ref)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect((err as Error).message).toMatch(/can't be sold now: Resale of this contract is not offered/);
    expect(deriv.calls("sell")).toHaveLength(0);
  });

  it("a sell Deriv refuses means nothing was sold", async () => {
    const { ref } = await make().placeOpenOrder(open());
    deriv.handlers.sell = () => ({ error: { code: "SellRefused", message: "This contract cannot be sold." } });
    const err = await make().placeCloseOrder(await held(ref)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect((err as Error).message).toMatch(/SellRefused/);
  });

  it("a sell with no answer is NOT called refused: it may have gone through", async () => {
    const { ref } = await make().placeOpenOrder(open());
    deriv.silent.add("sell");
    const err = await make(baseConfig({ timeoutMs: 1000 })).placeCloseOrder(await held(ref)).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(OrderNotPlacedError);
    expect((err as Error).message).toMatch(/did not answer "sell"/);
  });

  it("refuses a position with no Deriv contract id, and a part-close", async () => {
    await expect(make().placeCloseOrder(await held("ib-77"))).rejects.toThrow(/no Deriv contract id/);
    const { ref } = await make().placeOpenOrder(open({ quantity: 2 }));
    await expect(make().placeCloseOrder({ ...(await held(ref)), requestedQuantity: 2, filledQuantity: 2 }, { quantity: 1 })).rejects.toThrow(/can't be closed in part/);
    expect(deriv.calls("sell")).toHaveLength(0);
  });

  it("a failed sign-in on the close is loud and sells nothing", async () => {
    const { ref } = await make().placeOpenOrder(open());
    deriv.otpStatus = 401;
    await expect(make().placeCloseOrder(await held(ref))).rejects.toThrow(/HTTP 401/);
    expect(deriv.calls("sell")).toHaveLength(0);
  });
});

describe("secrets", () => {
  it("a short app id does not shred ordinary text in an error (HTTP 401 stays HTTP 401)", async () => {
    deriv.otpStatus = 401;
    const err = await make(baseConfig({ appId: "0" })).checkConnection().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/HTTP 401/);
  });

  it("the token and the app id are in no log line and no error message through a whole open, read and close", async () => {
    const ex = make();
    const { ref } = await ex.placeOpenOrder(open());
    await ex.getOrder(ref);
    await ex.placeCloseOrder(buildPosition({ id: "p", botId: NDX_BOT_ID, underlying: "NDX", type: "short_put_spread", status: "open", brokerOrderRef: ref }));
    deriv.handlers.proposal = () => ({ error: { code: "X", message: `echo ${TOKEN} ${APP_ID}` } });
    const err = await make().placeOpenOrder(open({ clientOrderId: "z" })).catch((e: unknown) => e);
    for (const text of [...logs, (err as Error).message]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(APP_ID);
    }
  });

  it("the token is sent only in the sign-in request's Authorization header, never over the WebSocket", async () => {
    await make().placeOpenOrder(open());
    expect(JSON.stringify(deriv.sent)).not.toContain(TOKEN);
    expect(deriv.opened.join(" ")).not.toContain(TOKEN);
  });
});

describe("our own rows", () => {
  it("lists the bot's positions from the records", async () => {
    positionsStore.insert(buildPosition({ id: "p1", botId: NDX_BOT_ID, type: "short_put_spread", status: "open" }));
    positionsStore.insert(buildPosition({ id: "p2", botId: "other", type: "short_put_spread", status: "open" }));
    expect((await make().listPositions(NDX_BOT_ID)).map((p) => p.id)).toEqual(["p1"]);
  });
});

vi.setConfig({ testTimeout: 10_000 });
