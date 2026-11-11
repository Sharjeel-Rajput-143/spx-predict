import { beforeEach, describe, expect, it } from "vitest";
import { BTC_BOT_ID, ensureBotRecord } from "./bots";
import { BYBIT_TAKER_FEE_RATE, bybitPL, closedTradeRow, dailyLimitBlock, dayStatus, estimatedFees } from "./bybitDay";
import { resetDerivResultAttempts, settleDerivResults } from "./derivResults";
import { positionsStore } from "./store";
import { BASE_NOW, buildPosition, resetAutomationStores } from "./testSupport";

/**
 * The BTC bot's daily loss limit counts its trades AFTER FEES, like Bybit's own history. Bybit's figure is used once it is listed; until then the fills less estimated fees.
 * Seen on the real app: a short closed at 07:00 (entry 75,199.90, exit 75,143.20) showed -$0.03 in Trade history but counted as +$0.06 against the limit ($10.06 left),
 * because Bybit's figure had not arrived yet and the limit used the fills alone.
 */

const UNIT = 0.001; // BTC per engine contract (POSITION_SIZE)
const NOW = BASE_NOW;
/** A closed Bybit trade, as the engine records it: credit = the entry price in engine units (price x coin size / 100), close price likewise (a long's is 2 x entry - exit). */
const trade = (over: { side: "short" | "long"; entry: number; exit: number; settledPl?: number; closedAt?: number; id?: string }) => {
  const entryU = (over.entry * UNIT) / 100;
  const exitU = (over.exit * UNIT) / 100;
  return positionsStore.insert(
    buildPosition({
      id: over.id ?? `t-${Math.random().toString(36).slice(2)}`,
      botId: BTC_BOT_ID,
      underlying: "BTC",
      venue: "bybit",
      type: over.side === "short" ? "short_call_spread" : "short_put_spread",
      status: "closed",
      requestedQuantity: 1,
      filledQuantity: 1,
      credit: entryU,
      closePrice: over.side === "short" ? exitU : 2 * entryU - exitU,
      closedAt: over.closedAt ?? NOW - 30_000,
      brokerOrderRef: `bybit-close-${over.id ?? "x"}`,
      ...(over.settledPl !== undefined ? { settlement: { kind: "broker" as const, pl: over.settledPl, at: NOW } } : {}),
    }),
  );
};

beforeEach(() => {
  resetAutomationStores();
  resetDerivResultAttempts();
  ensureBotRecord(BTC_BOT_ID);
});

describe("a trade's result after fees", () => {
  it("the reported case: a short 75,199.90 to 75,143.20 is +$0.06 on the fills but -$0.03 after fees, and the limit counts -$0.03 ($9.97 left, not $10.06)", () => {
    const p = trade({ side: "short", entry: 75_199.9, exit: 75_143.2 });
    expect(Math.round((75_199.9 - 75_143.2) * UNIT * 100) / 100).toBe(0.06); // the fills alone
    expect(Math.round(estimatedFees(p, UNIT)! * 100) / 100).toBe(0.08); // 0.055% of both fills (about $75 each)
    expect(bybitPL(p, UNIT)).toBeCloseTo(-0.03, 2);
    const s = dayStatus(BTC_BOT_ID, 10, NOW, null, UNIT);
    expect(s.realized).toBe(-0.03);
    expect(s.room).toBe(9.97);
    expect(closedTradeRow(p, UNIT)).toMatchObject({ pl: -0.03, plSource: "estimated", entryPrice: 75_199.9, exitPrice: 75_143.2 });
  });

  it("Bybit's own figure replaces the estimate as soon as it is there, and is never reduced by fees again", () => {
    const p = trade({ side: "short", entry: 75_199.9, exit: 75_143.2, settledPl: -0.03 });
    expect(bybitPL(p, UNIT)).toBe(-0.03);
    const stops = [trade({ side: "long", entry: 75_000, exit: 74_700, settledPl: -0.29 }), trade({ side: "long", entry: 75_000, exit: 74_660, settledPl: -0.34 })];
    expect(stops).toHaveLength(2);
    const s = dayStatus(BTC_BOT_ID, 10, NOW, null, UNIT);
    expect(s.realized).toBe(-0.66); // -0.03 - 0.29 - 0.34
    expect(s.room).toBe(9.34);
    expect(closedTradeRow(p, UNIT).plSource).toBe("bybit");
  });

  it("the two earlier stop losses, settled by Bybit, counted after fees: -$0.29 and -$0.34 leave $9.37", () => {
    trade({ side: "long", entry: 75_000, exit: 74_700, settledPl: -0.29 });
    trade({ side: "long", entry: 75_000, exit: 74_660, settledPl: -0.34 });
    expect(dayStatus(BTC_BOT_ID, 10, NOW, null, UNIT).room).toBe(9.37);
  });

  it("a long is the same: its exit comes from the engine's close price (2 x entry - exit)", () => {
    const p = trade({ side: "long", entry: 76_000, exit: 77_000 });
    expect(exitPriceOfRounded(p)).toBe(77_000);
    expect(bybitPL(p, UNIT)).toBeCloseTo(1 - BYBIT_TAKER_FEE_RATE * 153_000 * UNIT, 4);
  });

  it("a trade with no exit price has no result and counts as 0 (never a guess)", () => {
    const p = positionsStore.insert(buildPosition({ id: "unpriced", botId: BTC_BOT_ID, underlying: "BTC", venue: "bybit", type: "short_call_spread", status: "closed", credit: 0.75, closePrice: null as never, closedAt: NOW - 1000 }));
    expect(bybitPL(p, UNIT)).toBeNull();
    expect(dayStatus(BTC_BOT_ID, 10, NOW, null, UNIT)).toMatchObject({ realized: 0, closedToday: 1 });
  });
});

const exitPriceOfRounded = (p: Parameters<typeof estimatedFees>[0]) => Math.round(((2 * p.credit! - p.closePrice!) * 100) / UNIT);

describe("the limit is never looser than the real result", () => {
  it("a loss that is inside the limit on the fills but over it after fees blocks the next entry", () => {
    trade({ side: "long", entry: 76_000, exit: 75_940 }); // -$0.06 on the fills, about -$0.14 after fees
    expect(dailyLimitBlock(BTC_BOT_ID, 0.2, NOW, UNIT)).toBeNull(); // a limit above the real loss: no block (checked first: reaching a limit is remembered for the day)
    expect(dayStatus(BTC_BOT_ID, 0.1, NOW, null, UNIT)).toMatchObject({ reached: true });
    expect(dailyLimitBlock(BTC_BOT_ID, 0.1, NOW, UNIT)).toMatch(/daily loss limit/);
  });

  it("room can exceed the limit when the day's realized wins outweigh its losses: that is the rule (wins and losses of the day are added; only an OPEN profit offsets nothing)", () => {
    trade({ side: "long", entry: 76_000, exit: 77_000, id: "win" }); // +$0.92 after fees
    expect(dayStatus(BTC_BOT_ID, 10, NOW, null, UNIT).room).toBe(10.92);
    expect(dayStatus(BTC_BOT_ID, 10, NOW, 5, UNIT).room).toBe(10.92); // an open profit adds nothing
    expect(dayStatus(BTC_BOT_ID, 10, NOW, -2, UNIT).room).toBe(8.92); // an open loss uses it up
  });
});

describe("Bybit's own result is fetched quickly after a close", () => {
  const read = (listedAfter: number) => {
    const calls: number[] = [];
    return { calls, executor: { getContractResult: async () => (calls.push(Date.now()), calls.length > listedAfter ? { settled: true, profit: -0.03, status: "closed" } : { settled: false, profit: null, status: "not listed yet" }) } };
  };

  it("the quick pass asks again after a few seconds (not ten minutes) and stores the after-fees figure once Bybit lists it", async () => {
    const p = trade({ side: "short", entry: 75_199.9, exit: 75_143.2, closedAt: NOW - 20_000, id: "fresh" });
    const { calls, executor } = read(1);
    const quick = { retryAfterMs: 8_000, recentMs: 15 * 60_000 };
    expect(await settleDerivResults(executor, NOW, quick)).toBe(0); // not listed yet
    expect(await settleDerivResults(executor, NOW + 3_000, quick)).toBe(0); // too soon to ask again
    expect(calls).toHaveLength(1);
    expect(await settleDerivResults(executor, NOW + 9_000, quick)).toBe(1); // asked again, listed now
    expect(positionsStore.get(p.id)?.settlement).toMatchObject({ kind: "broker", pl: -0.03 });
    expect(await settleDerivResults(executor, NOW + 20_000, quick)).toBe(0); // settled: not asked again
    expect(calls).toHaveLength(2);
  });

  it("the ordinary pass still waits ten minutes between tries, and the quick pass leaves old unsettled trades alone (no hammering Bybit for ever)", async () => {
    trade({ side: "short", entry: 75_000, exit: 74_900, closedAt: NOW - 3_600_000, id: "old" });
    const old = read(99);
    expect(await settleDerivResults(old.executor, NOW, { retryAfterMs: 8_000, recentMs: 15 * 60_000 })).toBe(0);
    expect(old.calls).toHaveLength(0); // closed an hour ago: not part of the quick pass
    await settleDerivResults(old.executor, NOW); // the ordinary pass tries once
    await settleDerivResults(old.executor, NOW + 9_000); // and not again after 9 seconds
    expect(old.calls).toHaveLength(1);
  });
});
