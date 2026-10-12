import { describe, expect, it } from "vitest";
import { NO_FILTERS, analyze, etParts, filterOptions, hourLabel, type AnalyzeFilters, type BotInfo } from "./analyze";
import { buildPosition } from "./testSupport";
import type { Position } from "./types";

// Every number below was worked out by hand from the five positions in `book`. One contract each, spreads 10 points wide,
// so a position's risk is (10 - credit) x 100 and its result is (credit - close price) x 100.

const et = (month: number, day: number, h: number, m = 0) => Date.UTC(2026, month - 1, day, h + 4, m); // October 2026, daylight time
const BOT: BotInfo = { id: "ndx", name: "NDX Bias", accountId: "paper-1", group: "Index", estimate: 3.5 };

let n = 0;
const closed = (type: Position["type"], open: number, close: number, credit: number, closePrice: number, over: Partial<Position> = {}) =>
  buildPosition({ id: `p${++n}`, botId: "ndx", underlying: "NDX", type, ...(type === "short_put_spread" ? { shortStrike: 20_970, longStrike: 20_960 } : { shortStrike: 21_035, longStrike: 21_045 }), status: "closed", requestedQuantity: 1, filledQuantity: 1, credit, closePrice, openedAt: open, closedAt: close, expiry: new Date(open - 4 * 3_600_000).toISOString().slice(0, 10), ...over });

/** The five that count (Tue-Thu, 6-8 October 2026). */
const book = (): Position[] => [
  closed("short_put_spread", et(10, 6, 10, 0), et(10, 6, 10, 30), 4, 1, { tags: ["trend"] }), //  A  +300, risk 600
  closed("short_call_spread", et(10, 6, 11, 15), et(10, 6, 12, 0), 3.5, 6), //                      B  -250, risk 650
  closed("short_put_spread", et(10, 7, 9, 40), et(10, 7, 15, 0), 4, 2), //                          C  +200, risk 600
  closed("short_call_spread", et(10, 8, 14, 5), et(10, 8, 15, 50), 3, 3), //                        D    0 (break-even), risk 700
  closed("short_put_spread", et(10, 8, 10, 10), et(10, 8, 16, 15), 1.5, 0, { status: "expired", closePrice: null, settlement: { kind: "estimated", pl: 150, underlyingPrice: 21_100, settleValue: 0, at: et(10, 8, 16, 15) } }), // E +150, risk 850
];
const now = et(10, 9, 12, 0);
const run = (positions: Position[], f: Partial<AnalyzeFilters> = {}, at = now) => analyze(positions, [BOT], { ...NO_FILTERS, ...f }, at);

describe("what counts", () => {
  it("only a finished position with a result: refused orders, open positions and results not yet known are left out, and the last are counted apart", () => {
    const extra: Position[] = [
      buildPosition({ id: "rej", botId: "ndx", type: "short_put_spread", status: "rejected" }),
      buildPosition({ id: "open", botId: "ndx", type: "short_put_spread", status: "open", openedAt: et(10, 8, 10, 0) }),
      closed("short_put_spread", et(10, 8, 10, 0), et(10, 8, 11, 0), 4, 1, { closePrice: null, id: "noprice" }), // closed, price never reported
    ];
    const a = run([...book(), ...extra]);
    expect(a.positions).toBe(5);
    expect(a.withoutResult).toBe(1);
    expect(a.counted.map((c) => c.position.id)).not.toContain("noprice");
  });
});

describe("the four tiles and the metrics", () => {
  const a = run(book());
  it("closed P/L is the sum of the results, from fills and from the estimated settlement alike", () => {
    expect(a.closedPL).toBe(400); // 300 - 250 + 200 + 0 + 150
  });
  it("profit factor is gross wins over gross losses; win rate is wins over all; wins, losses and positions", () => {
    expect(a.profitFactor).toBeCloseTo(650 / 250, 6);
    expect(a.positions).toBe(5);
    expect(a.wins).toBe(3);
    expect(a.losses).toBe(1); // the break-even one is neither
    expect(a.winRate).toBeCloseTo(3 / 5, 6);
  });
  it("P/L per day is the average over the days positions ended: +50, +200, +150 -> 133.33", () => {
    expect(a.daily.map((d) => [d.dateKey, d.pl, d.count])).toEqual([["2026-10-06", 50, 2], ["2026-10-07", 200, 1], ["2026-10-08", 150, 2]]);
    expect(a.plPerDay).toBeCloseTo(133.33, 2);
  });
  it("Sharpe is the mean over the standard deviation of the daily return on risk, annualised over 252 days", () => {
    expect(a.daily.map((d) => d.returnOnRisk)).toEqual([50 / 1250, 200 / 600, 150 / 1550]);
    expect(a.sharpe).toBeCloseTo(15.9892, 3);
  });
  it("Sortino is blank when no day lost money (nothing to divide by), and works when one did", () => {
    expect(a.sortino).toBeNull();
    const losing = run([...book(), closed("short_put_spread", et(10, 9, 10, 0), et(10, 9, 11, 0), 4, 8)]); // -400 on risk 600
    expect(losing.sortino).not.toBeNull();
    expect(losing.sortino).toBeCloseTo(-2.3402, 3); // mean of the four daily returns over their downside deviation, x sqrt(252)
  });
  it("Sharpe needs at least two days and some variation", () => {
    expect(run([book()[0]]).sharpe).toBeNull();
    expect(run([book()[0], closed("short_put_spread", et(10, 7, 10, 0), et(10, 7, 10, 30), 4, 1)]).sharpe).toBeNull(); // two days, identical return: no deviation
  });
});

describe("the averages", () => {
  const a = run(book());
  it("P/L, win, loss, risk and return on risk", () => {
    expect(a.avgPL).toBe(80);
    expect(a.avgWin).toBeCloseTo(216.67, 2);
    expect(a.avgLoss).toBe(-250);
    expect(a.avgRisk).toBe(680);
    expect(a.avgReturnOnRisk).toBeCloseTo(0.1250377, 6);
  });
  it("days to expiration and days in trade are zero for same-day positions", () => {
    expect(a.avgDte).toBe(0);
    expect(a.avgDaysInTrade).toBe(0);
  });
  it("the entry probability of profit is never made up: it needs option prices and a model", () => {
    expect(a.entryPop).toBeNull();
  });
  it("a position held overnight shows its days in trade and its days to expiration", () => {
    const overnight = closed("short_put_spread", et(10, 6, 15, 0), et(10, 7, 10, 0), 4, 1, { expiry: "2026-10-08" });
    const b = run([overnight]);
    expect(b.avgDte).toBe(2);
    expect(b.avgDaysInTrade).toBe(1);
  });
});

describe("the charts' data", () => {
  const a = run(book());
  it("the running total follows the order positions ended: 300, 50, 250, 250, 400", () => {
    expect(a.curve.map((c) => c.value)).toEqual([300, 50, 250, 250, 400]);
  });
  it("day of the week is by the day it was opened: Tue +50, Wed +200, Thu +150, Mon and Fri nothing", () => {
    expect(a.byWeekday.map((b) => [b.label, b.value, b.count])).toEqual([["Mon", 0, 0], ["Tue", 50, 2], ["Wed", 200, 1], ["Thu", 150, 2], ["Fri", 0, 0]]);
  });
  it("hour of the day is by the hour it was opened, and always spans 9AM to 3PM", () => {
    expect(a.byHour.map((b) => [b.label, b.value])).toEqual([["9AM", 200], ["10AM", 450], ["11AM", -250], ["12PM", 0], ["1PM", 0], ["2PM", 0], ["3PM", 0]]);
    expect(hourLabel(0)).toBe("12AM");
    expect(hourLabel(12)).toBe("12PM");
  });
  it("by strategy and by symbol, the best first", () => {
    expect(a.byStrategy.map((b) => [b.label, b.value])).toEqual([["Short Put Spread", 650], ["Short Call Spread", -250]]);
    expect(a.bySymbol.map((b) => [b.label, b.value])).toEqual([["NDX", 400]]);
  });
  it("since is the first day anything ended", () => {
    expect(a.since).toBe("2026-10-06");
  });
});

describe("the filters", () => {
  it("strategy: only the call spreads", () => {
    const a = run(book(), { strategies: ["short_call_spread"] });
    expect(a.positions).toBe(2);
    expect(a.closedPL).toBe(-250);
    expect(a.winRate).toBe(0);
    expect(a.profitFactor).toBe(0);
  });
  it("day opened: Tuesday only", () => {
    expect(run(book(), { days: [2] }).closedPL).toBe(50);
  });
  it("hour opened: 10am only", () => {
    expect(run(book(), { hours: [10] }).closedPL).toBe(450);
  });
  it("days to expiration: 0 keeps all, 1 keeps none", () => {
    expect(run(book(), { dtes: [0] }).positions).toBe(5);
    const none = run(book(), { dtes: [1] });
    expect(none.positions).toBe(0);
    expect(none.closedPL).toBeNull();
    expect(none.winRate).toBeNull();
    expect(none.sharpe).toBeNull();
  });
  it("tags, bot, account, group and symbol", () => {
    expect(run(book(), { tags: ["trend"] }).closedPL).toBe(300);
    expect(run(book(), { bots: ["ndx"] }).positions).toBe(5);
    expect(run(book(), { bots: ["other"] }).positions).toBe(0);
    expect(run(book(), { accounts: ["paper-1"] }).positions).toBe(5);
    expect(run(book(), { accounts: ["live-9"] }).positions).toBe(0);
    expect(run(book(), { groups: ["Index"] }).positions).toBe(5);
    expect(run(book(), { groups: ["Other"] }).positions).toBe(0);
    expect(run(book(), { symbols: ["SPX"] }).positions).toBe(0);
  });
  it("several filters together narrow it down", () => {
    const a = run(book(), { strategies: ["short_put_spread"], days: [2, 4], hours: [10] });
    expect(a.closedPL).toBe(450); // A (Tue 10am) and E (Thu 10am)
  });
  it("range: everything inside a window, nothing once it has moved past", () => {
    expect(run(book(), { range: "7d" }, et(10, 12, 12)).positions).toBe(5);
    expect(run(book(), { range: "7d" }, et(10, 20, 12)).positions).toBe(0);
    expect(run(book(), { range: "30d" }, et(10, 20, 12)).positions).toBe(5);
    expect(run(book(), { range: "ytd" }, et(10, 20, 12)).positions).toBe(5);
    expect(run(book(), { range: "ytd" }, Date.UTC(2027, 1, 1)).positions).toBe(0);
  });
  it("what each filter offers is only what the positions contain", () => {
    const o = filterOptions(book(), [BOT]);
    expect(o).toMatchObject({ accounts: ["paper-1"], symbols: ["NDX"], tags: ["trend"], dtes: [0], groups: ["Index"], hours: [9, 10, 11, 14] });
    expect(o.strategies.sort()).toEqual(["short_call_spread", "short_put_spread"]);
    expect(o.bots).toEqual([{ id: "ndx", name: "NDX Bias" }]);
  });
});

describe("an empty book", () => {
  it("has no numbers, not zeros", () => {
    const a = run([]);
    expect(a).toMatchObject({ positions: 0, closedPL: null, plPerDay: null, profitFactor: null, winRate: null, avgPL: null, avgRisk: null, avgDte: null, since: null, sharpe: null, sortino: null });
    expect(a.curve).toEqual([]);
    expect(a.byWeekday.every((b) => b.value === 0)).toBe(true);
  });
});

describe("New York time", () => {
  it("reads the date, weekday and hour in New York, across the evening and a change of date", () => {
    expect(etParts(Date.UTC(2026, 9, 6, 14, 40))).toEqual({ dateKey: "2026-10-06", weekday: 2, hour: 10 });
    expect(etParts(Date.UTC(2026, 9, 7, 2, 30))).toEqual({ dateKey: "2026-10-06", weekday: 2, hour: 22 }); // still Tuesday evening in New York
    expect(etParts(Date.UTC(2026, 10, 27, 15, 0))).toEqual({ dateKey: "2026-11-27", weekday: 5, hour: 10 }); // standard time
  });
});
