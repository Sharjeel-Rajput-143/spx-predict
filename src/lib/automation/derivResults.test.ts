import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord } from "./bots";
import { UNKNOWN_RESULT, isDerivPosition, resetDerivResultAttempts, settleDerivResults } from "./derivResults";
import { DerivExecutor, type DerivConfig } from "./derivExecutor";
import { ACCOUNT, APP_ID, FakeDeriv, TOKEN } from "./derivTestSupport";
import { sweepBot } from "./eodSweep";
import { MockExecutor } from "./executor";
import { expireAllActivePositions, expireStalePositions } from "./expiry";
import { hindsight } from "./hindsight";
import { positionPL, positionPLKind } from "./pnl";
import { settleExpiredFromClose } from "./settleExpired";
import { botsStore, positionsStore } from "./store";
import { NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import type { Position } from "./types";

// A Deriv position's result is Deriv's own: never worked out from strikes or a credit, never an estimate - or it is "unknown, check Deriv". Nothing touches a network.

setNdxTestEnv();
const utc = (y: number, m: number, d: number, h: number, min: number) => Date.UTC(y, m - 1, d, h, min);
const config: DerivConfig = { token: TOKEN, appId: APP_ID, accountId: ACCOUNT, apiBase: "https://api.derivws.com", symbol: "OTC_NDX", product: "rise_fall", stake: 10, maxStake: 100, currency: "USD", duration: 1, durationUnit: "h", maxSlippage: 0.02, allowReal: false, timeoutMs: 1500, hoursStart: "09:35", hoursEnd: "15:55", lastBuyMarginMinutes: 5 };

let deriv: FakeDeriv;
let nowMs: number;
const make = () => new DerivExecutor(config, deriv.fetch, deriv.socketFactory, () => {}, () => nowMs);
const DAY1 = utc(2026, 10, 6, 14, 0); // Tuesday 10am New York
const DAY2 = utc(2026, 10, 7, 14, 0);

/** A Deriv position made the way the engine makes one: credit = stake / 100, strikes that mean nothing to Deriv. */
const derivPosition = (over: Partial<Position> = {}): Position =>
  buildPosition({ id: "pos-d1", botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", venue: "deriv", type: "short_put_spread", status: "open", shortStrike: 29_250, longStrike: 29_200, requestedQuantity: 1, filledQuantity: 1, credit: 0.1, brokerOrderRef: "deriv-buy-987654321", expiry: "2026-10-06", openedAt: DAY1, ...over });
const otherPosition = (over: Partial<Position> = {}): Position =>
  buildPosition({ id: "pos-o1", botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", venue: "ibkr", type: "short_put_spread", status: "open", shortStrike: 29_250, longStrike: 29_200, requestedQuantity: 1, filledQuantity: 1, credit: 3.5, brokerOrderRef: "b1", expiry: "2026-10-06", openedAt: DAY1, ...over });
const contract = (settled?: { status: "won" | "lost"; profit: number }) => deriv.contracts.set(987654321, { buy: 10, sold: !!settled, sale: settled ? 10 + settled.profit : 0, valid: !settled, ...(settled ? { settled } : {}) });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  resetDerivResultAttempts();
  deriv = new FakeDeriv();
  nowMs = DAY2;
  ensureBotRecord(NDX_BOT_ID);
});
afterEach(() => vi.unstubAllEnvs());

describe("a Deriv position never gets an estimate", () => {
  it("a position left from an earlier day is expired with its result UNKNOWN, no result stored (an ordinary one is expired as before)", () => {
    positionsStore.insert(derivPosition());
    positionsStore.insert(otherPosition());
    expect(expireStalePositions(NDX_BOT_ID, DAY2)).toBe(2);
    const d = positionsStore.get("pos-d1")!;
    expect(d).toMatchObject({ status: "expired", resultUnknown: UNKNOWN_RESULT });
    expect(d.settlement).toBeUndefined();
    expect(positionPL(d)).toBeNull();
    expect(positionsStore.get("pos-o1")).toMatchObject({ status: "expired" });
    expect(positionsStore.get("pos-o1")?.resultUnknown).toBeUndefined();
  });

  it("the sweep that expires everything marks a Deriv position's result unknown too", () => {
    positionsStore.insert(derivPosition());
    expireAllActivePositions(DAY2, NDX_BOT_ID);
    expect(positionsStore.get("pos-d1")).toMatchObject({ status: "expired", resultUnknown: UNKNOWN_RESULT });
  });

  it("the end-of-day sweep in 'estimate' mode never estimates a Deriv position, even with a fresh price (an ordinary position is still estimated)", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_EOD_SWEEP_MODE", "estimate");
    positionsStore.insert(derivPosition());
    const r = await sweepBot(NDX_BOT_ID, DAY1 + 3 * 3_600_000, { executor: new MockExecutor(), underlyingPrice: () => 29_300 });
    expect(r.mode).toBe("estimate");
    const d = positionsStore.get("pos-d1")!;
    expect(d).toMatchObject({ status: "expired", resultUnknown: UNKNOWN_RESULT });
    expect(d.settlement).toBeUndefined();
    expect(r.estimated).toBe(0);

    resetAutomationStores();
    setNdxTestEnv();
    ensureBotRecord(NDX_BOT_ID);
    positionsStore.insert(otherPosition());
    const control = await sweepBot(NDX_BOT_ID, DAY1 + 3 * 3_600_000, { executor: new MockExecutor(), underlyingPrice: () => 29_300 });
    expect(control.estimated).toBe(1);
    expect(positionsStore.get("pos-o1")?.settlement?.kind).toBe("estimated");
  });

  it("the settlement from the day's closing price skips a Deriv position and never looks one up", async () => {
    positionsStore.insert(derivPosition({ status: "expired", closedAt: DAY1 + 1000 }));
    positionsStore.insert(otherPosition({ status: "expired", closedAt: DAY1 + 1000 }));
    const lookup = vi.fn(async () => 29_300);
    const n = await settleExpiredFromClose({ now: DAY2, lookup });
    expect(n).toBe(1); // only the ordinary one
    expect(positionsStore.get("pos-d1")?.settlement).toBeUndefined();
    expect(positionsStore.get("pos-o1")?.settlement?.kind).toBe("estimated");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("the hindsight comparison leaves a Deriv position out: its strikes mean nothing", async () => {
    const closed = derivPosition({ status: "closed", closePrice: 0.08, closedAt: DAY1 + 1000 });
    const report = await hindsight([closed], DAY2, async () => 29_300);
    expect(report.rows).toEqual([]);
  });
});

describe("Deriv's own result is read and stored as the broker's", () => {
  it("an expired contract that won: the result is Deriv's profit, and the unknown note goes", async () => {
    positionsStore.insert(derivPosition({ status: "expired", closedAt: DAY1 + 1000, resultUnknown: UNKNOWN_RESULT }));
    contract({ status: "won", profit: 8.15 });
    expect(await settleDerivResults(make(), DAY2)).toBe(1);
    const d = positionsStore.get("pos-d1")!;
    expect(d.settlement).toEqual({ kind: "broker", pl: 8.15, at: DAY2 });
    expect(d.resultUnknown).toBeUndefined();
    expect(positionPL(d)).toBe(8.15);
    expect(positionPLKind(d)).toBe("broker");
  });

  it("a contract that lost is a loss, exactly as Deriv reports it (the stake)", async () => {
    positionsStore.insert(derivPosition({ status: "expired", closedAt: DAY1 + 1000 }));
    contract({ status: "lost", profit: -10 });
    await settleDerivResults(make(), DAY2);
    expect(positionPL(positionsStore.get("pos-d1")!)).toBe(-10);
  });

  it("the result does not depend on the strikes, the credit or the quantity the engine carries", async () => {
    positionsStore.insert(derivPosition({ status: "expired", closedAt: DAY1 + 1000, shortStrike: 1, longStrike: 99_999, credit: 55.5, requestedQuantity: 7, filledQuantity: 7 }));
    contract({ status: "won", profit: 3.25 });
    await settleDerivResults(make(), DAY2);
    expect(positionPL(positionsStore.get("pos-d1")!)).toBe(3.25);
  });

  it("an unsold contract that Deriv settled at expiry is picked up from the position the engine left expired", async () => {
    positionsStore.insert(derivPosition());
    expireStalePositions(NDX_BOT_ID, DAY2);
    contract({ status: "lost", profit: -10 });
    await settleDerivResults(make(), DAY2);
    expect(positionsStore.get("pos-d1")).toMatchObject({ status: "expired", settlement: { kind: "broker", pl: -10 } });
  });

  it("a contract Deriv says is still open has no result: it stays 'unknown, check Deriv', nothing is guessed", async () => {
    positionsStore.insert(derivPosition({ status: "expired", closedAt: DAY1 + 1000 }));
    contract(); // open
    expect(await settleDerivResults(make(), DAY2)).toBe(0);
    const d = positionsStore.get("pos-d1")!;
    expect(d.settlement).toBeUndefined();
    expect(d.resultUnknown).toBe(UNKNOWN_RESULT);
    expect(positionPL(d)).toBeNull();
  });

  it("when Deriv cannot be asked (sign-in refused), it stays unknown", async () => {
    positionsStore.insert(derivPosition({ status: "expired", closedAt: DAY1 + 1000 }));
    deriv.otpStatus = 401;
    expect(await settleDerivResults(make(), DAY2)).toBe(0);
    expect(positionsStore.get("pos-d1")).toMatchObject({ resultUnknown: UNKNOWN_RESULT });
    expect(positionsStore.get("pos-d1")?.settlement).toBeUndefined();
  });

  it("a position closed by a sale gets Deriv's reported profit as its result, which wins over the computed one", async () => {
    // sold for 12 against a stake of 10: the engine's own numbers say +2, and Deriv says +2.00
    positionsStore.insert(derivPosition({ status: "closed", closePrice: 0.08, closedAt: DAY1 + 1000 }));
    deriv.contracts.set(987654321, { buy: 10, sold: true, sale: 12, valid: false });
    await settleDerivResults(make(), DAY2);
    const d = positionsStore.get("pos-d1")!;
    expect(d.settlement).toEqual({ kind: "broker", pl: 2, at: DAY2 });
    expect(positionPL(d)).toBe(2);
    expect(positionPLKind(d)).toBe("broker");
  });

  it("each position is asked at most every 10 minutes", async () => {
    positionsStore.insert(derivPosition({ status: "expired", closedAt: DAY1 + 1000 }));
    contract();
    await settleDerivResults(make(), DAY2);
    const opened = deriv.opened.length;
    await settleDerivResults(make(), DAY2 + 5 * 60_000);
    expect(deriv.opened.length).toBe(opened);
    contract({ status: "won", profit: 1 });
    await settleDerivResults(make(), DAY2 + 11 * 60_000);
    expect(positionsStore.get("pos-d1")?.settlement?.pl).toBe(1);
  });

  it("works at any hour (it is a read), and leaves an ordinary position and an executor without it alone", async () => {
    positionsStore.insert(otherPosition({ status: "expired", closedAt: DAY1 + 1000 }));
    nowMs = utc(2026, 10, 10, 3, 0); // a Saturday
    expect(await settleDerivResults(make(), nowMs)).toBe(0);
    expect(await settleDerivResults(undefined, nowMs)).toBe(0);
    expect(await settleDerivResults({}, nowMs)).toBe(0); // an executor without the ability (the simulation, IBKR)
    expect(positionsStore.get("pos-o1")?.settlement).toBeUndefined();
    expect(deriv.opened).toEqual([]);
    expect(isDerivPosition(derivPosition())).toBe(true);
    expect(isDerivPosition(otherPosition())).toBe(false);
  });
});

describe("the executor reads Deriv's own result", () => {
  it("settled contracts report Deriv's profit; open ones report nothing; a foreign reference is null", async () => {
    contract({ status: "won", profit: 4.4 });
    expect(await make().getContractResult("deriv-buy-987654321")).toEqual({ settled: true, profit: 4.4, status: "won" });
    expect(await make().getContractResult("deriv-sell-987654321")).toEqual({ settled: true, profit: 4.4, status: "won" });
    contract();
    expect(await make().getContractResult("deriv-buy-987654321")).toEqual({ settled: false, profit: null, status: "open" });
    expect(await make().getContractResult("ib-77")).toBeNull();
    deriv.contracts.set(987654321, { buy: 10, sold: true, sale: 12, valid: false });
    expect(await make().getContractResult("deriv-sell-987654321")).toEqual({ settled: true, profit: 2, status: "sold" });
  });

  it("a contract Deriv does not know is an error, never a made-up result", async () => {
    await expect(make().getContractResult("deriv-buy-5")).rejects.toThrow(/ContractNotFound/);
  });
});

describe("the bot is not flagged by an unknown result (it is a note on the position, not an error)", () => {
  it("settling and marking unknown change nothing on the bot", async () => {
    positionsStore.insert(derivPosition({ status: "expired", closedAt: DAY1 + 1000 }));
    contract();
    await settleDerivResults(make(), DAY2);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(false);
  });
});
