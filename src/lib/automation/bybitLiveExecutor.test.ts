import { beforeEach, describe, expect, it } from "vitest";
import { ensureBotRecord } from "./bots";
import { tripDailyLimit } from "./bybitDay";
import { BybitConfigError, BybitExecutor, assertHost, type BybitConfig } from "./bybitExecutor";
import { LiveBybitExecutor, judgeKey, leverageFromRows, livePreflight, parseLeverage, readLiveConfig, type LiveGuard } from "./bybitLive";
import { DEMO_HOST, LIVE_API_BASE, LIVE_HOST, LIVE_LIMITS, STAGE_LEVERAGE, clampDailyLoss } from "./bybitLiveLimits";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { OrderNotPlacedError } from "./orderErrors";
import { BASE_NOW, BTC_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import type { OpenSpreadRequest, Position } from "./types";

// THE LIVE EXECUTOR against the fake exchange: no network, no real key. Live trading stays OFF; these tests prove the walls around it.

setNdxTestEnv();
const base: BybitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, apiBase: LIVE_API_BASE, symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 0.3, takeProfitPercent: 1, dailyMaxLossUsd: 3, breakevenTriggerPercent: 0, breakevenLockPercent: 0, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000 };

let bybit: FakeBybit;
let logs: string[];
let nowMs: number;
let guardState: { on: boolean; stage: 1 | 2; loss: number; trades: number; offs: string[] };
const guard: LiveGuard = {
  switchOn: () => guardState.on,
  stage: () => guardState.stage,
  dailyLossUsd: () => guardState.loss,
  tradesToday: () => guardState.trades,
  onAutoOff: (why) => {
    guardState.offs.push(why);
    guardState.on = false;
  },
};
const make = (over: Partial<BybitConfig> = {}) => {
  const ex = new LiveBybitExecutor({ ...base, ...over }, guard, bybit.fetch, (l) => logs.push(l), () => nowMs);
  ex.sleep = async () => undefined;
  return ex;
};
const openReq = (over: Partial<OpenSpreadRequest> = {}): OpenSpreadRequest => ({ botId: BTC_BOT_ID, underlying: "BTC", positionType: "short_put_spread", shortStrike: 29_000, longStrike: 28_990, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06", clientOrderId: "sig-1:open", ...over }) as OpenSpreadRequest;
const held = (over: Partial<Position> = {}): Position => ({ id: "pos-1", botId: BTC_BOT_ID, type: "short_put_spread", status: "closing", venue: "bybit", brokerOrderRef: "bybitlive-open-1001", filledQuantity: 1, requestedQuantity: 1, credit: 0.76, ...over }) as Position;
const posts = () => bybit.calls.filter((c) => c.method === "POST");

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(BTC_BOT_ID);
  bybit = new FakeBybit();
  logs = [];
  nowMs = BASE_NOW;
  bybit.clock = () => nowMs;
  guardState = { on: true, stage: 1, loss: 2, trades: 0, offs: [] };
  delete process.env.BYBIT_KILL_SWITCH;
});

describe("the ceilings written in the code", () => {
  it("are the ones agreed: 0.001 BTC, a $3 ceiling (default $2), 5 trades a day, one position, stage 1 = 10x and stage 2 = 3x", () => {
    expect(LIVE_LIMITS).toEqual({ maxQty: 0.001, dailyLossCeilingUsd: 3, defaultDailyLossUsd: 2, maxTradesPerDay: 5, maxOpenPositions: 1 });
    expect(STAGE_LEVERAGE).toEqual({ 1: 10, 2: 3 });
  });
  it("the daily loss limit can be lowered but never raised past $3, and a nonsense value falls back to the default", () => {
    expect(clampDailyLoss(1)).toBe(1);
    expect(clampDailyLoss(2.5)).toBe(2.5);
    expect(clampDailyLoss(50)).toBe(3);
    expect(clampDailyLoss(Infinity)).toBe(2);
    for (const bad of [0, -1, NaN, "abc", null, undefined]) expect(clampDailyLoss(bad)).toBe(2);
    expect(clampDailyLoss("1.5")).toBe(1.5);
  });
});

describe("which host each executor can reach", () => {
  it("the demo executor reaches the demo host only: pointing it at the real host is refused before any request", () => {
    expect(() => new BybitExecutor({ ...base, apiBase: LIVE_API_BASE }, bybit.fetch)).toThrow(/demo only/);
    expect(() => new BybitExecutor({ ...base, apiBase: `https://${DEMO_HOST}` }, bybit.fetch)).not.toThrow();
    expect(bybit.calls).toHaveLength(0);
  });
  it("the live executor reaches the real host only", () => {
    expect(() => new LiveBybitExecutor({ ...base, apiBase: `https://${DEMO_HOST}` }, guard, bybit.fetch)).toThrow(BybitConfigError);
    expect(() => new LiveBybitExecutor(base, guard, bybit.fetch)).not.toThrow();
  });
  it("look-alike addresses are refused by both: extra path, query, user, wrong scheme, a longer host, a different port is fine only on the exact host", () => {
    for (const bad of [`http://${LIVE_HOST}`, `https://${LIVE_HOST}.evil.com`, `https://evil.com/${LIVE_HOST}`, `https://user@${LIVE_HOST}`, `https://${LIVE_HOST}/v5`, `https://${LIVE_HOST}?x=1`, "not a url", ""]) {
      expect(() => assertHost(bad, true), bad).toThrow(BybitConfigError);
    }
    for (const bad of [`http://${DEMO_HOST}`, `https://${DEMO_HOST}.evil.com`, `https://user@${DEMO_HOST}`, `https://${DEMO_HOST}/v5`, LIVE_API_BASE]) {
      expect(() => assertHost(bad, false), bad).toThrow(BybitConfigError);
    }
    expect(() => assertHost(`https://${LIVE_HOST}/`, true)).not.toThrow();
  });
  it("a live size above 0.001 BTC is refused at construction", () => {
    expect(() => make({ qty: 0.002 })).toThrow(/ceiling/);
    expect(() => make({ qty: 0 })).toThrow(/ceiling/);
  });
});

describe("reading the live settings", () => {
  const env = { BYBIT_LIVE_API_KEY: "live-key-AAAA-1111", BYBIT_LIVE_API_SECRET: "live-secret-BBBB-2222", STOP_LOSS_PERCENT: "0.3", TAKE_PROFIT_PERCENT: "1", POSITION_SIZE: "5", DAILY_MAX_LOSS_USD: "999", BYBIT_DEMO_API_KEY: "demo-key-CCCC-3333", BYBIT_DEMO_API_SECRET: "demo-secret-DDDD-4444" };
  it("uses the live key and the real host, with the size and loss ceilings from the code, whatever the demo settings say", () => {
    const c = readLiveConfig(env);
    expect(c).toMatchObject({ apiKey: "live-key-AAAA-1111", apiSecret: "live-secret-BBBB-2222", apiBase: LIVE_API_BASE, symbol: "BTCUSDT", qty: 0.001, dailyMaxLossUsd: 3, stopLossPercent: 0.3, takeProfitPercent: 1 });
  });
  it("ignores BYBIT_API_BASE and BYBIT_SYMBOL: the host and the instrument are fixed", () => {
    expect(readLiveConfig({ ...env, BYBIT_API_BASE: "https://evil.example.com", BYBIT_SYMBOL: "ETHUSDT" })).toMatchObject({ apiBase: LIVE_API_BASE, symbol: "BTCUSDT" });
  });
  it("names the missing settings, never a value, and never reads the demo key as the live one", () => {
    const { BYBIT_LIVE_API_KEY: _a, BYBIT_LIVE_API_SECRET: _b, ...noLive } = env;
    expect(() => readLiveConfig(noLive)).toThrow(/BYBIT_LIVE_API_KEY, BYBIT_LIVE_API_SECRET/);
    try {
      readLiveConfig(noLive);
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/demo-key|demo-secret/);
    }
  });
  it("refuses a live key that is the demo key", () => {
    expect(() => readLiveConfig({ ...env, BYBIT_LIVE_API_KEY: env.BYBIT_DEMO_API_KEY })).toThrow(/must not be the demo key/);
    expect(() => readLiveConfig({ ...env, BYBIT_LIVE_API_SECRET: env.BYBIT_DEMO_API_SECRET })).toThrow(/must not be the demo key/);
  });
  it("a size above the ceiling is refused, a smaller one is taken", () => {
    expect(() => readLiveConfig({ ...env, BYBIT_LIVE_POSITION_SIZE: "0.002" })).toThrow(/at most 0.001/);
    expect(() => readLiveConfig({ ...env, BYBIT_LIVE_POSITION_SIZE: "abc" })).toThrow(/at most 0.001/);
  });
});

describe("what the key may do", () => {
  const key = (over: Record<string, unknown> = {}) => ({ readOnly: 0, ips: ["203.0.113.5"], permissions: { ContractTrade: ["Order", "Position"], Spot: [], Wallet: [] }, ...over });
  it("a trade-only key with an IP restriction is fine, with no warning", () => {
    expect(judgeKey(key())).toEqual({ problems: [], warnings: [] });
  });
  it("any withdraw or transfer right is a hard problem, wherever it is listed", () => {
    for (const permissions of [
      { ContractTrade: ["Order", "Position"], Wallet: ["AccountTransfer"] },
      { ContractTrade: ["Order", "Position"], Wallet: ["Withdraw"] },
      { ContractTrade: ["Order", "Position"], Wallet: ["SubMemberTransfer"] },
      { ContractTrade: ["Order", "Position"], Affiliate: ["Withdrawal"] },
      { ContractTrade: ["Order", "Position"], Withdraw: ["Any"] },
    ]) {
      const r = judgeKey(key({ permissions }));
      expect(r.problems.join(" "), JSON.stringify(permissions)).toMatch(/move money/);
    }
  });
  it("a read-only key, or one without contract trading, is a problem", () => {
    expect(judgeKey(key({ readOnly: 1 })).problems.join(" ")).toMatch(/read only/);
    expect(judgeKey(key({ permissions: { ContractTrade: ["Order"] } })).problems.join(" ")).toMatch(/lacks contract trading/);
    expect(judgeKey(key({ permissions: {} })).problems.join(" ")).toMatch(/lacks contract trading/);
  });
  it("no IP restriction is a red WARNING only, never a problem", () => {
    for (const ips of [[], ["*"], ["0.0.0.0/0"]]) {
      const r = judgeKey(key({ ips }));
      expect(r.problems).toEqual([]);
      expect(r.warnings.join(" ")).toMatch(/no IP restriction/);
    }
  });
});

describe("the pre-trade check sets isolated margin and the stage's leverage itself, and reads them back", () => {
  const api = () => (method: "GET" | "POST", path: string, params?: Record<string, string | number | boolean>) => {
    const ex = new LiveBybitExecutor(base, guard, bybit.fetch, () => undefined, () => nowMs);
    // reach the protected call through the executor's own preflight wiring: the public way is preflight(); here the raw api is built the same way
    return (ex as unknown as { call: (m: string, p: string, q: unknown, o: unknown) => Promise<Record<string, unknown>> }).call(method, path, params, { auth: true });
  };
  it("a new account (cross margin) is switched to isolated and left at 10x on stage 1", async () => {
    expect(bybit.account.marginMode).toBe("REGULAR_MARGIN");
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r).toMatchObject({ ok: true, problems: [], marginMode: "ISOLATED_MARGIN", leverage: 10 });
    expect(bybit.account.marginMode).toBe("ISOLATED_MARGIN");
    expect(bybit.of("/v5/account/set-margin-mode", "POST")).toHaveLength(1);
    expect(bybit.of("/v5/position/set-leverage", "POST")).toHaveLength(0); // already 10x
  });
  it("stage 2 sets 3x and proves it by reading it back", async () => {
    const r = await livePreflight(api(), { stage: 2, symbol: "BTCUSDT" });
    expect(r).toMatchObject({ ok: true, leverage: 3 });
    expect(bybit.account.leverage).toBe(3);
    expect(bybit.of("/v5/position/set-leverage", "POST")[0].params).toMatchObject({ buyLeverage: "3", sellLeverage: "3", symbol: "BTCUSDT" });
  });
  it("already isolated at the right leverage: nothing is changed", async () => {
    bybit.account.marginMode = "ISOLATED_MARGIN";
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r.ok).toBe(true);
    expect(posts()).toHaveLength(0);
  });
  it("Bybit refusing to switch to isolated margin = cross is refused, and the reason is given", async () => {
    bybit.account.refuseMarginSwitch = true;
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/would not switch.*isolated.*never accepted/s);
    expect(r.problems.join(" ")).toMatch(/not isolated margin/);
  });
  it("portfolio margin is not accepted either", async () => {
    bybit.account.marginMode = "PORTFOLIO_MARGIN";
    bybit.account.refuseMarginSwitch = true;
    expect((await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" })).ok).toBe(false);
  });
  it("a leverage that cannot be set, or that does not read back as set, is refused", async () => {
    bybit.account.marginMode = "ISOLATED_MARGIN";
    bybit.account.leverage = 20;
    bybit.account.refuseLeverage = true;
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r.ok).toBe(false);
    // a refusal other than "not modified" is not swallowed: it makes the check unreadable, which also refuses the entry
    expect(r.unreadable ?? r.problems.join(" ")).toMatch(/110026|not modified|leverage/);
  });
  it("Bybit saying OK to a leverage change that then does not show in the position record = refused (only what is read back is trusted)", async () => {
    bybit.account.marginMode = "ISOLATED_MARGIN";
    bybit.account.leverage = 20;
    bybit.overrides.set("/v5/position/set-leverage", () => ({ ok: true, status: 200, text: async () => JSON.stringify({ retCode: 0, retMsg: "OK", result: {} }) }));
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r.ok).toBe(false);
    expect(r.leverage).toBe(20);
    expect(r.problems.join(" ")).toMatch(/leverage is 20x, not the 10x that stage 1 requires/);
  });
  it("a key that can move money is refused BEFORE anything on the account is touched", async () => {
    bybit.keyInfo.permissions.Wallet = ["AccountTransfer"];
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/move money/);
    expect(posts()).toHaveLength(0);
    expect(bybit.of("/v5/position/list")).toHaveLength(0);
  });
  it("no IP restriction: still ok, with the warning", async () => {
    bybit.keyInfo.ips = [];
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/no IP restriction/);
  });
  it("with a position held it only CHECKS: nothing is switched or changed under an open trade", async () => {
    bybit.hold(0.001);
    const r = await livePreflight(api(), { stage: 2, symbol: "BTCUSDT" });
    expect(r.ok).toBe(false);
    expect(posts()).toHaveLength(0);
  });
  // ---- THE FIX: Bybit's position record has a deprecated tradeMode field that is ALWAYS 0. The margin mode is judged from the account's marginMode only.
  it("an isolated account whose position record says tradeMode 0 PASSES the check (this is how Bybit answers)", async () => {
    bybit.account.marginMode = "ISOLATED_MARGIN";
    const seen = await api()("GET", "/v5/position/list", { category: "linear", symbol: "BTCUSDT" });
    expect((seen.list as { tradeMode: number }[])[0].tradeMode).toBe(0); // the fake now answers as Bybit does
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r).toMatchObject({ ok: true, problems: [], marginMode: "ISOLATED_MARGIN", leverage: 10 });
    expect(r.problems.join(" ")).not.toMatch(/position record/);
  });
  it("a new account (cross margin) is switched to isolated and then passes, with tradeMode 0 all the way", async () => {
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r).toMatchObject({ ok: true, marginMode: "ISOLATED_MARGIN" });
    expect(bybit.account.marginMode).toBe("ISOLATED_MARGIN");
  });
  it("cross margin is still refused: the position record cannot make it look isolated, and neither can an OK answer to the switch", async () => {
    // Bybit says the switch worked, but the account still reads back as cross: only what is read back counts.
    bybit.overrides.set("/v5/account/set-margin-mode", () => ({ ok: true, status: 200, text: async () => JSON.stringify({ retCode: 0, retMsg: "OK", result: { reasons: [] } }) }));
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r.ok).toBe(false);
    expect(r.marginMode).toBe("REGULAR_MARGIN");
    expect(r.problems.join(" ")).toMatch(/REGULAR_MARGIN, not isolated margin\. Cross margin is never accepted/);
    expect(bybit.of("/v5/position/set-leverage", "POST")).toHaveLength(0); // it stopped before touching the leverage
  });
  it("portfolio margin that stays portfolio is refused, and an account that reads back with no margin mode is refused", async () => {
    bybit.account.marginMode = "PORTFOLIO_MARGIN";
    bybit.account.refuseMarginSwitch = true;
    expect((await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" })).problems.join(" ")).toMatch(/PORTFOLIO_MARGIN, not isolated/);
    bybit.account.marginMode = "";
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r.ok).toBe(false);
  });

  // ---- THE LEVERAGE STEP: what the position record may look like on a flat account
  const flat = (style: "string" | "number" | "missing" | "empty" | "zero") => {
    bybit.account.marginMode = "ISOLATED_MARGIN";
    bybit.account.leverageStyle = style;
  };
  it("leverage returned as a string (\"10\") or as a number (10) is read as 10 and nothing needs changing", async () => {
    for (const style of ["string", "number"] as const) {
      flat(style);
      const before = posts().length;
      const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
      expect(r, style).toMatchObject({ ok: true, leverage: 10, warnings: [] });
      expect(posts().length, style).toBe(before);
    }
  });
  it("a wrong leverage read as a string or number is set and read back as set", async () => {
    for (const style of ["string", "number"] as const) {
      flat(style);
      bybit.account.leverage = 20;
      const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
      expect(r, style).toMatchObject({ ok: true, leverage: 10, warnings: [] });
      expect(bybit.account.leverage, style).toBe(10);
    }
  });
  it("leverage not returned on a flat account (missing, empty, \"0\", or no row at all): set, confirmed by Bybit's own answer, accepted with a plain warning", async () => {
    for (const style of ["missing", "empty", "zero"] as const) {
      flat(style);
      bybit.account.leverage = 20;
      const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
      expect(r, style).toMatchObject({ ok: true, leverage: 10, problems: [] });
      expect(r.warnings.join(" "), style).toMatch(/does not show the leverage while the account holds no position.*set to 10x.*Bybit confirmed it.*could not be read back/);
      expect(bybit.account.leverage, style).toBe(10);
    }
    flat("string");
    bybit.account.noRowWhenFlat = true;
    bybit.account.leverage = 20;
    const none = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(none).toMatchObject({ ok: true, leverage: 10 });
    expect(none.warnings.join(" ")).toMatch(/could not be read back/);
  });
  it("not returned, and already at the target: Bybit's 'not modified' answer is the confirmation", async () => {
    flat("missing");
    bybit.account.leverage = 10;
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r).toMatchObject({ ok: true, leverage: 10 });
    expect(bybit.of("/v5/position/set-leverage", "POST")).toHaveLength(1);
  });
  it("not returned, and Bybit refuses the change (any other answer): refused, never accepted on faith", async () => {
    flat("missing");
    bybit.account.leverage = 20;
    bybit.account.refuseLeverage = true;
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r.ok).toBe(false);
    expect(r.unreadable ?? "").toMatch(/110026|not modified/);
  });
  it("not returned, and the change cannot be asked at all (Bybit down on the change): refused", async () => {
    flat("missing");
    bybit.account.leverage = 20;
    bybit.failures.set("/v5/position/set-leverage", { kind: "timeout", times: 5 });
    const ex = new LiveBybitExecutor({ ...base, readRetries: 0 }, guard, bybit.fetch, () => undefined, () => nowMs);
    const r = await ex.preflight();
    expect(r.ok).toBe(false);
  });
  it("a leverage that IS readable and wrong is still refused, even when Bybit says OK to the change", async () => {
    for (const style of ["string", "number"] as const) {
      flat(style);
      bybit.account.leverage = 20;
      bybit.overrides.set("/v5/position/set-leverage", () => ({ ok: true, status: 200, text: async () => JSON.stringify({ retCode: 0, retMsg: "OK", result: {} }) }));
      const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
      expect(r.ok, style).toBe(false);
      expect(r.leverage, style).toBe(20);
      expect(r.problems.join(" "), style).toMatch(/leverage is 20x, not the 10x/);
      bybit.overrides.delete("/v5/position/set-leverage");
    }
  });
  it("with a position held and the leverage not readable, nothing is accepted on faith", async () => {
    flat("missing");
    bybit.hold(0.001);
    const r = await livePreflight(api(), { stage: 1, symbol: "BTCUSDT" });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/not readable/);
    expect(posts()).toHaveLength(0);
  });
  it("stage 2 (3x) works the same way when the leverage is not returned", async () => {
    flat("missing");
    const r = await livePreflight(api(), { stage: 2, symbol: "BTCUSDT" });
    expect(r).toMatchObject({ ok: true, leverage: 3 });
    expect(bybit.account.leverage).toBe(3);
  });
  it("the leverage reader: strings, numbers, blanks, zero, junk, and rows that disagree (a wrong one is never hidden behind a right one)", () => {
    expect([parseLeverage("10"), parseLeverage("10.00"), parseLeverage(10), parseLeverage(" 3 ")]).toEqual([10, 10, 10, 3]);
    for (const bad of ["", "  ", "0", 0, -1, "abc", null, undefined, NaN, {}, []]) expect(Number.isNaN(parseLeverage(bad)), String(bad)).toBe(true);
    expect(leverageFromRows([], 10)).toBeNaN();
    expect(leverageFromRows([{ leverage: "" }, {}], 10)).toBeNaN();
    expect(leverageFromRows([{ leverage: "10" }], 10)).toBe(10);
    expect(leverageFromRows([{ leverage: "10" }, { leverage: "20" }], 10)).toBe(20);
    expect(leverageFromRows([{ leverage: "20" }, { leverage: "10" }], 10)).toBe(20);
    expect(leverageFromRows([{ leverage: "" }, { leverage: "10" }], 10)).toBe(10);
  });

  it("Bybit not answering is 'unreadable', not a finding", async () => {
    bybit.down = true;
    const ex = new LiveBybitExecutor({ ...base, readRetries: 0 }, guard, bybit.fetch, () => undefined, () => nowMs);
    const r = await ex.preflight();
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([]);
    expect(r.unreadable).toBeTruthy();
  });
});

describe("the live executor", () => {
  it("with the switch OFF it refuses a new entry and sends NOT ONE request, not even a read", async () => {
    guardState.on = false;
    await expect(make().placeOpenOrder(openReq())).rejects.toThrow(/live switch is OFF/);
    expect(bybit.calls).toHaveLength(0);
  });

  it("with the switch OFF a position it holds can still be closed", async () => {
    bybit.hold(0.001);
    guardState.on = false;
    const { ref } = await make().placeCloseOrder(held(), { clientOrderId: "c1" });
    expect(ref).toMatch(/^bybitlive-close-/);
    expect(bybit.created.at(-1)?.params).toMatchObject({ side: "Sell", reduceOnly: true, qty: "0.001" });
  });

  it("an entry: key checked, isolated margin and 10x set and read back, THEN one order of 0.001 BTC with its stop loss and take profit attached", async () => {
    const { ref } = await make().placeOpenOrder(openReq());
    expect(ref).toMatch(/^bybitlive-open-/);
    const paths = bybit.calls.map((c) => c.path);
    expect(paths.indexOf("/v5/user/query-api")).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf("/v5/user/query-api")).toBeLessThan(paths.indexOf("/v5/order/create"));
    expect(paths.indexOf("/v5/account/set-margin-mode")).toBeLessThan(paths.indexOf("/v5/order/create"));
    expect(bybit.created).toHaveLength(1);
    expect(bybit.created[0].params).toMatchObject({ qty: "0.001", side: "Buy", tpslMode: "Full", slOrderType: "Market" });
    expect(Number(bybit.created[0].params.stopLoss)).toBeGreaterThan(0);
    expect(bybit.account.marginMode).toBe("ISOLATED_MARGIN");
    expect(guardState.offs).toEqual([]);
  });

  it("an entry on an account that is already isolated, whose position record says tradeMode 0, is ACCEPTED (the pre-entry check uses the same logic)", async () => {
    bybit.account.marginMode = "ISOLATED_MARGIN";
    const { ref } = await make().placeOpenOrder(openReq());
    expect(ref).toMatch(/^bybitlive-open-/);
    expect(bybit.created).toHaveLength(1);
    expect(guardState.offs).toEqual([]);
  });
  it("an entry when the position record does not show the leverage is accepted after Bybit confirms the leverage, and the order goes out", async () => {
    bybit.account.marginMode = "ISOLATED_MARGIN";
    bybit.account.leverageStyle = "missing";
    await make().placeOpenOrder(openReq());
    expect(bybit.created).toHaveLength(1);
    expect(guardState.offs).toEqual([]);
  });
  it("an entry on an account that stays on cross margin is still refused, with the switch turned OFF and no order sent", async () => {
    bybit.account.refuseMarginSwitch = true;
    await expect(make().placeOpenOrder(openReq())).rejects.toBeInstanceOf(OrderNotPlacedError);
    expect(bybit.created).toHaveLength(0);
    expect(guardState.offs.join(" ")).toMatch(/pre-trade check failed/);
  });

  // ---- THE OFF RACE: OFF is clicked (or a trip turns it OFF) between the last switch check and the order going out
  /** Turns the switch OFF the moment the entry order reaches Bybit (the click lands just after the last check). Optionally Bybit then refuses every further order (so the close cannot go out). */
  const offAtOrder = (opts: { closeFails?: boolean } = {}) => {
    const real = bybit.fetch;
    let flipped = false;
    bybit.fetch = async (url, init) => {
      const res = await real(url, init);
      if (!flipped && init.method === "POST" && url.endsWith("/v5/order/create") && !String(init.body).includes('"reduceOnly":true')) {
        flipped = true;
        guardState.on = false;
        if (opts.closeFails) bybit.failures.set("/v5/order/create", { kind: "http", status: 500, times: 5 }); // the close order is refused by Bybit
      }
      return res;
    };
  };
  it("OFF clicked while the entry is going out: the entry is closed again at once, reduce only, the account is flat, no trade is kept, and the log says so in plain words", async () => {
    offAtOrder();
    await expect(make().placeOpenOrder(openReq())).rejects.toThrow(/turned OFF while this entry was going out, so it was closed again at once \(reduce only\)/);
    expect(bybit.created).toHaveLength(2);
    expect(bybit.created[0].params.reduceOnly).not.toBe(true);
    expect(bybit.created[1].params).toMatchObject({ reduceOnly: true, orderType: "Market", side: "Sell", qty: "0.001" });
    expect(bybit.position.size).toBe(0);
    expect(logs.join("\n")).toMatch(/The live switch was turned OFF while an entry was going out\. Closing that entry again at once \(reduce only\)\./);
    expect(logs.join("\n")).toMatch(/That entry was closed again: the live account is flat\./);
  });
  it("the same for a short", async () => {
    offAtOrder();
    await expect(make().placeOpenOrder(openReq({ positionType: "short_call_spread" }))).rejects.toThrow(/closed it again|closed again at once/);
    expect(bybit.created[1].params).toMatchObject({ reduceOnly: true, side: "Buy" });
    expect(bybit.position.size).toBe(0);
  });
  it("the refusal is an OrderNotPlacedError, so the engine keeps no trade for it", async () => {
    offAtOrder();
    await expect(make().placeOpenOrder(openReq())).rejects.toBeInstanceOf(OrderNotPlacedError);
  });
  it("if the close cannot be sent, nothing is hidden: the entry is returned as made (the engine records a real trade), it keeps its stop loss and take profit, and the log says it could NOT be closed", async () => {
    offAtOrder({ closeFails: true });
    const out = await make({ readRetries: 0 }).placeOpenOrder(openReq());
    expect(out.ref).toMatch(/^bybitlive-open-/);
    expect(bybit.position.size).toBeGreaterThan(0);
    expect(bybit.position.stopLoss).toBeGreaterThan(0);
    expect(bybit.position.takeProfit).toBeGreaterThan(0);
    expect(logs.join("\n")).toMatch(/That entry could NOT be closed again/);
    expect(logs.join("\n")).toMatch(/stays open with its stop loss and take profit/);
  });
  it("with the switch still ON the entry stands, untouched (no extra order)", async () => {
    const { ref } = await make().placeOpenOrder(openReq());
    expect(ref).toMatch(/^bybitlive-open-/);
    expect(bybit.created).toHaveLength(1);
    expect(bybit.position.size).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toMatch(/turned OFF while an entry was going out/);
  });
  it("a switch that was already OFF before the entry is still refused up front, with no order at all (unchanged)", async () => {
    guardState.on = false;
    await expect(make().placeOpenOrder(openReq())).rejects.toBeInstanceOf(OrderNotPlacedError);
    expect(bybit.created).toHaveLength(0);
  });

  it("a key with withdraw or transfer rights: no order, and the live switch is turned OFF", async () => {
    bybit.keyInfo.permissions.Wallet = ["AccountTransfer"];
    await expect(make().placeOpenOrder(openReq())).rejects.toThrow(/live switch was turned OFF.*move money/s);
    expect(bybit.created).toHaveLength(0);
    expect(guardState.on).toBe(false);
    expect(guardState.offs[0]).toMatch(/pre-trade check failed/);
  });

  it("cross margin that cannot be switched: no order, switch OFF", async () => {
    bybit.account.refuseMarginSwitch = true;
    await expect(make().placeOpenOrder(openReq())).rejects.toThrow(OrderNotPlacedError);
    expect(bybit.created).toHaveLength(0);
    expect(guardState.on).toBe(false);
  });

  it("Bybit unreadable: this entry is refused and nothing is sent, but the switch is left alone", async () => {
    bybit.failures.set("/v5/user/query-api", { kind: "timeout", times: 99 });
    await expect(make({ readRetries: 0 }).placeOpenOrder(openReq())).rejects.toThrow(/could not be asked/);
    expect(bybit.created).toHaveLength(0);
    expect(guardState.on).toBe(true);
    expect(guardState.offs).toEqual([]);
  });

  it("the 5 trades a day ceiling: the 6th is refused with no request", async () => {
    guardState.trades = LIVE_LIMITS.maxTradesPerDay;
    await expect(make().placeOpenOrder(openReq())).rejects.toThrow(/5 live trades have already been opened today/);
    expect(bybit.calls).toHaveLength(0);
    guardState.trades = LIVE_LIMITS.maxTradesPerDay - 1;
    await make().placeOpenOrder(openReq());
    expect(bybit.created).toHaveLength(1);
  });

  it("the daily loss limit: once tripped, entries are refused and the switch goes OFF; the limit is the lower of the setting and the ceiling", async () => {
    const ex = make();
    guardState.loss = 50;
    expect(ex.dailyMaxLossUsd).toBe(3);
    guardState.loss = 2;
    expect(ex.dailyMaxLossUsd).toBe(2);
    tripDailyLimit(BTC_BOT_ID, nowMs, "test");
    await expect(ex.placeOpenOrder(openReq())).rejects.toThrow(/daily loss limit of \$2\.00/);
    expect(guardState.on).toBe(false);
    expect(guardState.offs[0]).toMatch(/daily loss limit of \$2\.00 was reached/);
    expect(bybit.calls).toHaveLength(0);
  });

  it("an account that already holds a position: no second entry (one position at a time)", async () => {
    bybit.hold(0.001);
    await expect(make().placeOpenOrder(openReq({ clientOrderId: "sig-2:open" }))).rejects.toThrow(/already holds/);
    expect(bybit.created).toHaveLength(0);
  });

  it("a STOP LOSS ALARM turns the live switch OFF, and the app's own alarm still runs; the all-clear does not turn anything on", () => {
    const ex = make();
    const seen: string[] = [];
    ex.setAlarmHandler((a) => seen.push(a.kind));
    ex.onAlarm?.({ kind: "stop_problem", text: "no stop" });
    expect(guardState.on).toBe(false);
    expect(guardState.offs[0]).toMatch(/STOP LOSS ALARM: no stop/);
    guardState.on = false;
    ex.onAlarm?.({ kind: "resolved", text: "fine" });
    expect(guardState.on).toBe(false);
    expect(guardState.offs).toHaveLength(1);
    expect(seen).toEqual(["stop_problem", "resolved"]);
  });

  it("the inherited stop rules still hold on live: a stop that cannot be set means reduce-only closes and an account that ends flat", async () => {
    bybit.dropStops = true;
    bybit.tradingStopFails = true;
    const err = await make().placeOpenOrder(openReq()).catch((e) => e);
    expect(err).toBeInstanceOf(OrderNotPlacedError);
    expect(bybit.created.filter((c) => c.params.reduceOnly === true).length).toBeGreaterThanOrEqual(1);
    expect(bybit.position.size).toBe(0);
  });

  it("a missing stop that CAN be repaired is repaired once and the trade stands", async () => {
    bybit.dropStops = true;
    await make().placeOpenOrder(openReq());
    expect(bybit.of("/v5/position/trading-stop", "POST")).toHaveLength(1);
    expect(bybit.position.stopLoss).toBeGreaterThan(0);
  });
});
