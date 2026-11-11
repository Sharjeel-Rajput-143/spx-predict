import { beforeEach, describe, expect, it } from "vitest";
import { ensureBotRecord } from "./bots";
import { DerivExecutor, type DerivConfig } from "./derivExecutor";
import { ACCOUNT, APP_ID, FakeDeriv, TOKEN } from "./derivTestSupport";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import { positionPL } from "./pnl";
import { RoutedExecutor } from "./routedExecutor";
import { botsStore, decisionsStore, ordersStore, positionsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";

// The bot, end to end, on the Deriv executor against a fake Deriv. Nothing touches a network or a real webhook address.
// The decision engine is unchanged: only the executor behind it is different.

setNdxTestEnv();
const MIN = 60_000;
const fast = { closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 };
const config: DerivConfig = { token: TOKEN, appId: APP_ID, accountId: ACCOUNT, apiBase: "https://api.derivws.com", symbol: "OTC_NDX", product: "rise_fall", stake: 10, maxStake: 100, currency: "USD", duration: 1, durationUnit: "h", maxSlippage: 0.02, allowReal: false, timeoutMs: 1500, hoursStart: "09:35", hoursEnd: "15:55", lastBuyMarginMinutes: 5 };

let deriv: FakeDeriv;
let logs: string[];
let executor: DerivExecutor;
/** The executor's clock: where the test says now is (it follows the engine's own `now` on each run). */
let nowMs = BASE_NOW;
const mine = () => positionsStore.all().filter((p) => p.botId === NDX_BOT_ID);
const outcomes = () => decisionsStore.all().filter((d) => d.signalId !== null).map((d) => d.outcome);
const alert = (direction: "bullish" | "bearish", barTime: string, now: number, botId = NDX_BOT_ID, symbol = "NDX") =>
  receiveAndSaveSignal({ botId, signal: direction, price: 29_284.55, barTime, interval: "5", raw: { symbol }, now });
const run = (direction: "bullish" | "bearish", barTime: string, now = BASE_NOW) => {
  nowMs = now;
  return processSignal(alert(direction, barTime, now), { executor, now, ...fast });
};

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  deriv = new FakeDeriv();
  logs = [];
  nowMs = BASE_NOW;
  executor = new DerivExecutor(config, deriv.fetch, deriv.socketFactory, (l) => logs.push(l), () => nowMs);
  ensureBotRecord(NDX_BOT_ID);
});

describe("a bullish alert opens a CALL on US Tech 100", () => {
  it("one position, open, tied to the Deriv contract: its id is the order reference, in the log, and the order row is filled", async () => {
    await run("bullish", "b1");
    expect(outcomes()).toEqual(["opened"]);
    const [p] = mine();
    expect(p).toMatchObject({ type: "short_put_spread", status: "open", venue: "deriv", brokerOrderRef: "deriv-buy-987654321", filledQuantity: 1 });
    expect(p.credit).toBe(0.1); // $10 stake in hundredths of a dollar
    expect(ordersStore.all().map((o) => [o.kind, o.status, o.ref])).toEqual([["open", "filled", "deriv-buy-987654321"]]);
    expect(deriv.calls("proposal")[0]).toMatchObject({ contract_type: "CALL", underlying_symbol: "OTC_NDX", amount: 10 });
    expect(deriv.calls("buy")).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/bought contract 987654321/);
  });

  it("a bearish alert opens a PUT", async () => {
    await run("bearish", "b1");
    expect(deriv.calls("proposal")[0]).toMatchObject({ contract_type: "PUT" });
    expect(mine()[0]).toMatchObject({ type: "short_call_spread", status: "open" });
  });

  it("the same side again sends nothing", async () => {
    await run("bullish", "b1");
    deriv.sent.length = 0;
    await run("bullish", "b2", BASE_NOW + 5 * MIN);
    expect(deriv.calls("buy")).toHaveLength(0);
    expect(outcomes().at(-1)).toBe("already_in_position");
  });
});

describe("a flip: sell the old contract, then buy the other side", () => {
  it("closes the CALL by selling it, records the profit, then buys a PUT", async () => {
    await run("bullish", "b1");
    deriv.saleValue = 12; // sold for $12 against a $10 stake
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
    const [call, put] = [mine().find((p) => p.type === "short_put_spread")!, mine().find((p) => p.type === "short_call_spread")!];
    expect(call.status).toBe("closed");
    expect(call.closePrice).toBeCloseTo(0.08, 9);
    expect(positionPL(call)).toBeCloseTo(2, 6); // +$2: the engine's own formula gives the real profit
    expect(put).toMatchObject({ status: "open", brokerOrderRef: "deriv-buy-987654322" });
    expect(deriv.calls("sell")[0]).toMatchObject({ sell: 987654321, price: 0 });
    expect(deriv.calls("proposal").map((r) => r.contract_type)).toEqual(["CALL", "PUT"]);
    expect(logs.join("\n")).toMatch(/sold contract 987654321 for \$12/);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(false);
  });

  it("a losing sale is a loss in the engine's own numbers", async () => {
    await run("bullish", "b1");
    deriv.saleValue = 4;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(positionPL(mine().find((p) => p.type === "short_put_spread")!)).toBeCloseTo(-6, 6);
  });

  it("a sell Deriv refuses leaves the old position open, opens nothing new, and flags the bot", async () => {
    await run("bullish", "b1");
    deriv.contracts.get(987654321)!.valid = false;
    deriv.contracts.get(987654321)!.error = "Resale is not offered right now.";
    deriv.sent.length = 0;
    await run("bearish", "b2", BASE_NOW + 5 * MIN);
    expect(mine().map((p) => `${p.type}:${p.status}`)).toEqual(["short_put_spread:open"]);
    expect(deriv.calls("buy")).toHaveLength(0);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).toMatch(/can't be sold now: Resale is not offered right now/);
  });
});

describe("when Deriv cannot be reached or refuses, it is loud and nothing is left half-open", () => {
  it("a refused sign-in stops the open: no position is held, the bot is flagged, the reason says why", async () => {
    deriv.otpStatus = 401;
    await run("bullish", "b1");
    expect(mine().map((p) => p.status)).toEqual(["rejected"]);
    expect(outcomes()).toEqual(["open_rejected"]);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).toMatch(/Deriv refused the sign-in \(HTTP 401/);
    expect(deriv.sent).toEqual([]);
  });

  it("a refused proposal (a duration Deriv does not offer) buys nothing", async () => {
    deriv.handlers.proposal = () => ({ error: { code: "ContractBuyValidationError", message: "Trading is not offered for this duration." } });
    await run("bullish", "b1");
    expect(deriv.calls("buy")).toHaveLength(0);
    expect(mine().map((p) => p.status)).toEqual(["rejected"]);
    expect(decisionsStore.all().map((d) => d.reason).join(" ")).toMatch(/Trading is not offered for this duration/);
  });
});

describe("only NDX goes to Deriv; the other bot stays on the simulation", () => {
  it("through the router, an SPX alert never reaches Deriv, and an NDX alert does", async () => {
    setTestBotEnv();
    ensureBotRecord("spx_ema_bias");
    const routed = new RoutedExecutor(executor, new MockExecutor(), ["NDX"]);
    const spx = receiveAndSaveSignal({ botId: "spx_ema_bias", signal: "bullish", price: 7_100, barTime: "s1", interval: "5", raw: { symbol: "SPX" }, now: BASE_NOW });
    await processSignal(spx, { executor: routed, now: BASE_NOW, ...fast });
    expect(deriv.sent).toEqual([]);
    expect(deriv.restCalls).toHaveLength(0);
    expect(positionsStore.all().filter((p) => p.botId === "spx_ema_bias").map((p) => p.venue)).toEqual(["mock"]);

    await processSignal(alert("bullish", "n1", BASE_NOW + 3 * MIN), { executor: routed, now: BASE_NOW + 3 * MIN, ...fast });
    expect(deriv.calls("buy")).toHaveLength(1);
    expect(mine()[0].venue).toBe("deriv");
  });
});
