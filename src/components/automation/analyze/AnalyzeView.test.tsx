import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BotInfo } from "@/lib/automation/analyze";
import { buildPosition } from "@/lib/automation/testSupport";
import type { Position } from "@/lib/automation/types";
import { AnalyzeView } from "./AnalyzeView";
import { AreaChart, BarList, CalendarGrid, ColumnChart, Donut, MiniBars, Spark, money } from "./charts";

// Server-render tests: no browser, no network.
const html = (n: React.ReactElement) => renderToStaticMarkup(n);
const et = (day: number, h: number, m = 0) => Date.UTC(2026, 9, day, h + 4, m);
const BOT: BotInfo = { id: "ndx", name: "NDX Bias", accountId: "paper-1", group: "Index", estimate: 3.5 };
const NOW = et(9, 18);

let n = 0;
const closed = (type: Position["type"], open: number, close: number, credit: number, closePrice: number, over: Partial<Position> = {}) =>
  buildPosition({ id: `a${++n}`, botId: "ndx", underlying: "NDX", type, ...(type === "short_put_spread" ? { shortStrike: 20_970, longStrike: 20_960 } : { shortStrike: 21_035, longStrike: 21_045 }), status: "closed", requestedQuantity: 1, filledQuantity: 1, credit, closePrice, openedAt: open, closedAt: close, expiry: "2026-10-06", ...over });
const book = [
  closed("short_put_spread", et(6, 10), et(6, 10, 30), 4, 1),
  closed("short_call_spread", et(6, 11, 15), et(6, 12), 3.5, 6),
  closed("short_put_spread", et(7, 9, 40), et(7, 15), 4, 2),
];
const view = (positions: Position[]) => html(<AnalyzeView positions={positions} bots={[BOT]} now={NOW} botName={() => "NDX Bias"} />);

describe("the Analyze view", () => {
  it("has the filters, the four tiles, the chart, the breakdowns, the metrics and averages, the report and the export, like Option Alpha's", () => {
    const out = view(book);
    for (const t of ["Account filter", "Symbols filter", "Tags filter", "Strategy filter", "DTE filter", "Bot filter", "Bot Group filter", "Day filter", "Hour filter"]) expect(out, t).toContain(`aria-label="${t}"`);
    for (const t of ["Closed P/L", "P/L per day", "Profit factor", "Win rate", "Total", "Daily", "Calendar", "Day of Week", "Hour of Day", "By Strategy", "By Symbol", "Range", "Metrics", "Positions", "Wins", "Losses", "Sharpe ratio", "Sortino ratio", "Averages", "Return on risk", "Entry POP", "DTE", "Days in trade", "Hindsight Report", "Create Report", "Export Data", "Short Put Spread", "Short Call Spread"]) expect(out, t).toContain(t);
  });

  it("shows the numbers worked out: +250 closed, 66.7% win rate, profit factor 2.00 (500 over 250)", () => {
    const out = view(book);
    expect(out).toContain("+$250"); // 300 - 250 + 200
    expect(out).toContain("66.7%");
    expect(out).toContain("2.00");
    expect(out).toContain("Since 10/06/2026");
  });

  it("never makes up the probability of profit: Entry POP is a dash with its reason", () => {
    const out = view(book);
    expect(out).toContain("needs option prices and a pricing model");
  });

  it("an empty book shows dashes and explains the charts, and the report and export are switched off", () => {
    const out = view([]);
    expect(out).toContain("No closed positions with a result in this range.");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Export Data<\/button>/);
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Create Report<\/button>/);
  });

  it("says when finished positions have no result yet and so are not counted", () => {
    const noPrice = closed("short_put_spread", et(8, 10), et(8, 11), 4, 1, { closePrice: null });
    expect(view([...book, noPrice])).toContain("1 finished position has no result yet");
  });
});

describe("the charts", () => {
  it("money reads like a price, with the sign in front", () => {
    expect(money(1234)).toBe("$1,234");
    expect(money(-90)).toBe("-$90");
    expect(money(0)).toBe("$0");
  });
  it("the area chart draws a line and an area, and says so when there is nothing", () => {
    expect(html(<AreaChart points={[{ at: 1, value: 0 }, { at: 2, value: 300 }]} empty="none" />)).toContain("<path");
    expect(html(<AreaChart points={[]} empty="No data here" />)).toContain("No data here");
  });
  it("the columns show a bar for a day with positions only, green above zero and red below", () => {
    const out = html(<ColumnChart buckets={[{ key: "1", label: "Mon", value: 100, count: 1 }, { key: "2", label: "Tue", value: -50, count: 1 }, { key: "3", label: "Wed", value: 0, count: 0 }]} />);
    expect(out.match(/bg-up\/70/g)).toHaveLength(1);
    expect(out.match(/bg-down\/80/g)).toHaveLength(1);
    expect(out).toContain("Mon");
  });
  it("columns with nothing in them say so", () => {
    expect(html(<ColumnChart buckets={[{ key: "1", label: "Mon", value: 0, count: 0 }]} empty="Nothing yet." />)).toContain("Nothing yet.");
  });
  it("the bar list scales to the biggest and colours losses red", () => {
    const out = html(<BarList buckets={[{ key: "a", label: "Short Put Spread", value: 650, count: 2 }, { key: "b", label: "Short Call Spread", value: -250, count: 1 }]} empty="none" />);
    expect(out).toContain("width:100%");
    expect(out).toContain("$650");
    expect(out).toContain("-$250");
    expect(out).toContain("bg-down/80");
  });
  it("the calendar shows the latest month with its days and total, and each day's result", () => {
    const out = html(<CalendarGrid daily={[{ dateKey: "2026-10-06", pl: 50, count: 2, returnOnRisk: 0.04 }, { dateKey: "2026-10-07", pl: -200, count: 1, returnOnRisk: -0.3 }]} />);
    expect(out).toContain("October 2026");
    expect(out).toContain("-$150"); // the month's total: 50 - 200
    expect(out).toContain("$50");
    expect(out).toContain("-$200");
    for (const d of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) expect(out).toContain(d);
  });
  it("small visuals draw without data and with it", () => {
    expect(html(<Donut fraction={0.5} label="x" />)).toContain("stroke-dasharray");
    expect(html(<Donut fraction={null} label="x" />)).toContain("<svg");
    expect(html(<Spark values={[1, 2, 3]} />)).toContain("polyline");
    expect(html(<Spark values={[]} />)).not.toContain("polyline");
    expect(html(<MiniBars values={[1, -2, 3]} />)).toContain("bg-down/80");
  });
});
