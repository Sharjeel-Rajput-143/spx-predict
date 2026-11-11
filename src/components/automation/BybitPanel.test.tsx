import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BybitView } from "@/lib/automation/bybitView";
import { BybitPanelView, OpenByHand, type OpenControls, CLOSED_BY, CLOSED_BY_EXPLAINED, PAGE_SIZE, TradeDetails, durationText, pageWindow, paginate, plTone, rowOpeners, signedDollars, signedPercent } from "./BybitPanel";
import { showsBybitTab } from "./executorLabels";

const T = Date.UTC(2026, 9, 6, 15, 0);
const view = (over: Partial<BybitView> = {}): BybitView => ({
  symbol: "BTCUSDT",
  positionSize: 0.001,
  mode: "24 hours a day, every day",
  killSwitch: false,
  open: { side: "Long", size: 0.001, entryPrice: 76_000, currentPrice: 76_500, pnl: 0.5, pnlPercent: 0.66, valueUsd: 76.5, stopLoss: 75_240, takeProfit: 77_520, ifStopLoss: -0.76, ifTakeProfit: 1.52, breakeven: null, manual: false },
  openError: null,
  mismatch: null,
  history: [
    { orderId: "o1", side: "Long", size: 0.001, entryPrice: 76_000, exitPrice: 75_000, pnl: -1.12, pnlPercent: -1.47, fees: 0.12, openFee: 0.0418, closeFee: 0.0413, grossPnl: -1, leverage: 10, entryValue: 76, exitValue: 75, openedAt: T - 125_000, closedBy: "stop_loss", byBot: true, manual: false, closedAt: T },
    { orderId: "o2", side: "Short", size: 0.001, entryPrice: 76_000, exitPrice: 75_000, pnl: 1.25, pnlPercent: 1.64, fees: 0.08, openFee: 0.04, closeFee: 0.04, grossPnl: 1.33, leverage: 10, entryValue: 76, exitValue: 75, openedAt: null, closedBy: "signal_flip", byBot: true, manual: false, closedAt: T + 3_600_000 },
    { orderId: "o3", side: "Long", size: 0.001, entryPrice: 75_688.9, exitPrice: 75_660.2, pnl: -0.11, pnlPercent: -0.15, fees: null, openFee: null, closeFee: null, grossPnl: -0.11, leverage: null, entryValue: null, exitValue: null, openedAt: null, closedBy: "closed_at_broker", byBot: false, manual: false, closedAt: T + 7_200_000 },
  ],
  historyError: null,
  historyClearedAt: null,
  todayResetAt: null,
  historyTotals: { count: 3, wins: 1, losses: 2, total: 0.02, todayResult: 0.52 },
  closed: [],
  closedCount: 0,
  totals: { day: "2026-10-06", dayResult: 0.5, realizedToday: 0, openLoss: 0, running: 0, limit: 10, room: 10, reached: false, tripped: false },
  asOf: 0,
  ...over,
});
const html = (v: BybitView, extra: Partial<Parameters<typeof BybitPanelView>[0]> = {}) => renderToStaticMarkup(<BybitPanelView v={v} {...extra} />);

describe("Reset today", () => {
  it("the Today figure has a Reset button when the page can reset, none when it cannot, and says since when after a reset", () => {
    expect(html(view(), { onResetToday: () => {} })).toContain('data-testid="reset-today"');
    expect(html(view())).not.toContain('data-testid="reset-today"');
    const after = html(view({ todayResetAt: T }), { onResetToday: () => {} });
    expect(after).toMatch(/Closed trades \+ the open one since /);
  });
});

describe("the profit and loss text", () => {
  it("a profit has a plus sign and is green; a loss has a minus sign and is red; zero is plain", () => {
    expect(signedDollars(0.5)).toBe("+$0.50");
    expect(signedDollars(-1)).toBe("-$1.00");
    expect(signedDollars(1234.5)).toBe("+$1,234.50");
    expect(signedDollars(0)).toBe("$0.00");
    expect(signedPercent(0.3)).toBe("+0.30%");
    expect(signedPercent(-1.5)).toBe("-1.50%");
    expect([plTone(1), plTone(-1), plTone(0), plTone(null)]).toEqual(["text-up", "text-down", "text-fg", "text-faint"]);
  });
});

describe("the status strip", () => {
  it("says what this is and what is switched on", () => {
    const out = html(view());
    expect(out).toContain("Bybit DEMO account (paper money)");
    expect(out).toContain("BTCUSDT perpetual");
    expect(out).toContain("0.001 BTC per trade");
    expect(out).toContain("Trades 24 hours a day, every day");
    expect(out).toContain("Kill switch off");
  });

  it("the kill switch and a reached daily limit are called out in red words", () => {
    const out = html(view({ killSwitch: true, totals: { ...view().totals, reached: true, tripped: true, room: 0 } }));
    expect(out).toContain("Kill switch ON: no new trades");
    expect(out).toContain("Daily loss limit reached: no new trades today");
    expect(out).toContain("no new trade is made until the next day");
  });
});

describe("the four numbers", () => {
  it("open profit in green with a plus sign, today, total since cleared, and the room before the daily limit", () => {
    const out = html(view());
    expect(out).toMatch(/text-up[^>]*>\+\$0\.50</);
    expect(out).toContain("Open trade profit / loss");
    expect(out).toContain("Today");
    expect(out).toMatch(/\+\$0\.52/);
    expect(out).toContain("Total since cleared");
    expect(out).toMatch(/\+\$0\.02/);
    expect(out).toContain("Daily loss limit");
    expect(out).toContain("$10.00");
    expect(out).toContain("left of $10.00");
  });

  it("says plainly when nothing is open", () => {
    expect(html(view({ open: null }))).toContain("No open trade</span>");
  });
});

describe("the open trade", () => {
  it("explains the trade in a sentence, and shows entry, price now, profit in colour, size and both stops with what each would do", () => {
    const out = html(view());
    expect(out).toContain("You are");
    expect(out).toMatch(/>LONG</);
    expect(out).toContain("0.001 BTC of BTCUSDT");
    expect(out).toContain("worth about $76.50");
    expect(out).toContain("You make money if the price rises.");
    expect(out).toContain("76,000.00");
    expect(out).toContain("76,500.00");
    expect(out).toMatch(/text-up[^>]*data-testid="bybit-open-pl"[^>]*>\+\$0\.50</);
    expect(out).toContain("+0.66%");
    expect(out).toContain("75,240.00");
    expect(out).toContain("Bybit closes the trade by itself if the price gets there: -$0.76");
    expect(out).toContain("77,520.00");
    expect(out).toContain("Bybit closes the trade by itself if the price gets there: +$1.52");
  });

  it("an open loss is red with a minus sign, and a short says it makes money if the price falls", () => {
    const out = html(view({ open: { side: "Short", size: 0.001, entryPrice: 76_000, currentPrice: 76_400, pnl: -0.4, pnlPercent: -0.53, valueUsd: 76.4, stopLoss: 76_760, takeProfit: 74_480, ifStopLoss: -0.76, ifTakeProfit: 1.52, breakeven: null, manual: false } }));
    expect(out).toMatch(/text-down[^>]*data-testid="bybit-open-pl"[^>]*>-\$0\.40</);
    expect(out).toMatch(/>SHORT</);
    expect(out).toContain("You make money if the price falls.");
  });

  it("a trade the bot did not open is explained, not alarming", () => {
    const out = html(view({ mismatch: "This trade was not opened by the bot (it was placed by hand or by a script at Bybit)." }));
    expect(out).toContain("This trade was not opened by the bot");
  });

  it("a Bybit that can't be read shows the reason and no trade", () => {
    const out = html(view({ open: null, openError: "Bybit GET /v5/position/list failed (HTTP 500)" }));
    expect(out).toContain("Bybit could not be read just now");
    expect(out).toContain("HTTP 500");
    expect(out).not.toContain("No open trade. The account is flat");
  });
});

describe("the trade history", () => {
  it("lists every trade with entry, exit, the result in colour with its percent, and how it closed", () => {
    const out = html(view());
    expect(out).toContain("Trade history");
    expect(out).toContain("Bybit&#x27;s own list of closed trades");
    expect(out).toContain("3 trades");
    expect(out).toContain("1 won");
    expect(out).toContain("2 lost");
    expect(out).toMatch(/text-down[^>]*>-\$1\.12/);
    expect(out).toContain("-1.47%");
    expect(out).toMatch(/text-up[^>]*>\+\$1\.25/);
    expect(out).toContain("Stop loss");
    expect(out).toContain("Signal flip");
    expect(out).toContain("By hand at Bybit");
    expect(out).toContain("75,660.20");
    expect(out).toContain("Bybit order o3");
    expect(out).toContain("not opened by the bot");
  });

  it("every way a trade can close has a plain label", () => {
    for (const k of ["signal_flip", "stop_loss", "take_profit", "daily_limit", "kill_switch", "end_of_day", "manual", "liquidation", "closed_at_broker"]) expect(CLOSED_BY[k].label.length).toBeGreaterThan(3);
  });

  it("Clear history is there when it can be used, says what it does, and is off with nothing to clear", () => {
    const out = html(view(), { onClear: () => {} });
    expect(out).toContain("Clear history");
    expect(html(view({ history: [], historyTotals: { count: 0, wins: 0, losses: 0, total: 0, todayResult: 0 } }), { onClear: () => {} })).toMatch(/disabled=""[^>]*>Clear history/);
    expect(html(view(), { onClear: () => {}, clearing: true })).toContain("Clearing...");
    expect(html(view())).not.toContain("Clear history"); // no handler, no button
  });

  it("after a clear it says so, and the empty list explains", () => {
    const out = html(view({ history: [], historyClearedAt: T, historyTotals: { count: 0, wins: 0, losses: 0, total: 0, todayResult: 0.5 } }));
    expect(out).toContain("The history was cleared. New trades will appear here.");
    expect(out).toContain("Cleared ");
  });

  it("with no trades yet it says what lands here; a history Bybit can't give is explained", () => {
    expect(html(view({ history: [], historyTotals: { count: 0, wins: 0, losses: 0, total: 0, todayResult: 0 } }))).toContain("No closed trades yet");
    expect(html(view({ history: [], historyError: "Bybit GET /v5/position/closed-pnl failed (HTTP 500)" }))).toContain("trade history could not be read just now");
  });
});

describe("the Bybit tab on the Automation page", () => {
  it("shows only when Bybit is the broker", () => {
    expect(showsBybitTab({ venue: "bybit", sandbox: true })).toBe(true);
    for (const venue of ["mock", "deriv", "ibkr", "tradier", null] as const) expect(showsBybitTab({ venue })).toBe(false);
    expect(showsBybitTab(null)).toBe(false);
  });
});

describe("the trade details popup", () => {
  const rows = view().history;
  const details = (r: (typeof rows)[number]) => renderToStaticMarkup(<TradeDetails r={r} symbol="BTCUSDT" />);
  const esc = (t: string) => t.replace(/'/g, "&#x27;"); // the page escapes apostrophes in its markup

  it("every history row can be clicked (it is a button you can also reach with the keyboard) and says so", () => {
    const out = html(view());
    expect((out.match(/data-testid="bybit-history-row"/g) ?? []).length).toBe(3);
    expect(out).toContain('role="button"');
    expect(out).toContain('tabindex="0"');
    expect(out).toContain("Show the details of this Long trade");
    expect(out).toContain("Click a trade for its details.");
    expect(out).not.toContain("Trade details"); // closed until a trade is picked
  });

  it("clicking a row, or pressing Enter or Space on it, opens that trade; any other key does nothing", () => {
    const opened: string[] = [];
    const h = rowOpeners("o2", (id) => opened.push(id));
    h.onClick();
    let prevented = 0;
    for (const key of ["Enter", " ", "a", "Tab", "Escape"]) h.onKeyDown({ key, preventDefault: () => void prevented++ });
    expect(opened).toEqual(["o2", "o2", "o2"]);
    expect(prevented).toBe(2); // Enter and Space are taken over (Space would scroll the page); the others are left alone
  });

  it("a trade picked opens the popup with its details", () => {
    const out = html(view(), { openOrderId: "o1" });
    expect(out).toContain("Trade details");
    expect(out).toContain('data-testid="bybit-trade-details"');
    expect(out).toContain("role=\"dialog\"");
  });

  it("an id that is no longer in the list opens nothing", () => {
    expect(html(view(), { openOrderId: "gone" })).not.toContain("Trade details");
  });

  it("shows the result big and coloured, how it closed with the reason in words, and the full money picture", () => {
    const out = details(rows[0]);
    expect(out).toMatch(/text-down[^>]*>-\$1\.12/);
    expect(out).toContain("-1.47%");
    expect(out).toContain("after fees, as Bybit reports it");
    expect(out).toContain("Stop loss");
    expect(out).toContain(esc(CLOSED_BY_EXPLAINED.stop_loss));
    expect(out).toContain("75,000.00");
    expect(out).toContain("76,000.00");
    expect(out).toContain("-$1,000.00 per BTC (-1.32%)"); // a long that fell from 76,000 to 75,000
    expect(out).toContain("$76.00 at entry, $75.00 at exit");
    expect(out).toContain("10x");
    expect(out).toMatch(/text-down[^>]*>-\$1\.00</); // profit before fees
    expect(out).toContain("-$0.1200 (opening $0.0418 + closing $0.0413)");
    expect(out).toContain("Result after fees");
    expect(out).toContain("This site&#x27;s bot");
    expect(out).toContain("o1");
  });

  it("a trade the bot opened shows when and for how long; one it did not shows neither", () => {
    const a = details(rows[0]);
    expect(a).toContain("Opened");
    expect(a).toContain("Held for");
    expect(a).toContain("2 min 5 s");
    const c = details(rows[2]);
    expect(c).not.toContain("Held for");
    expect(c).toContain("Not the bot (by hand or by a script at Bybit)");
    expect(c).toContain(esc(CLOSED_BY_EXPLAINED.closed_at_broker));
  });

  it("a short that fell is shown as a gain per BTC; missing numbers show a dash, never a made-up value", () => {
    expect(details(rows[1])).toContain("+$1,000.00 per BTC (+1.32%)");
    const c = details(rows[2]);
    expect(c).toContain("Fees</dt><dd class=\"tabular text-fg\">—");
    expect(c).not.toContain("Leverage");
    expect(c).not.toContain("Position value");
  });

  it("a close whose reason Bybit no longer shows says so", () => {
    expect(details({ ...rows[0], closedBy: null })).toContain("no longer show how this one was closed");
  });

  it("explains every way of closing, and shows time spans in words", () => {
    for (const k of Object.keys(CLOSED_BY)) expect(CLOSED_BY_EXPLAINED[k], k).toBeTruthy();
    expect([durationText(5_000), durationText(125_000), durationText(3_780_000), durationText(2 * 86_400_000 + 4 * 3_600_000)]).toEqual(["5 s", "2 min 5 s", "1 h 3 min", "2 d 4 h"]);
  });
});

describe("the history pages: 20 trades at a time", () => {
  const trades = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...view().history[0], orderId: `t${i + 1}`, closedAt: T + (n - i) * 60_000 })) as BybitView["history"];
  const withTrades = (n: number) => view({ history: trades(n), historyTotals: { count: n, wins: 0, losses: n, total: -n, todayResult: 0 } });
  const rowsShown = (out: string) => (out.match(/data-testid="bybit-history-row"/g) ?? []).length;

  it("shows 20 per page", () => {
    expect(PAGE_SIZE).toBe(20);
    expect(paginate(trades(45), 1).rows).toHaveLength(20);
    expect(paginate(trades(45), 1).rows[0].orderId).toBe("t1");
    expect(paginate(trades(45), 2).rows.map((r) => r.orderId)).toEqual(Array.from({ length: 20 }, (_, i) => `t${i + 21}`));
    expect(paginate(trades(45), 3).rows).toHaveLength(5);
  });

  it("works out 'Showing 21-40 of 45' and the page count, and keeps the page inside the list", () => {
    expect(paginate(trades(45), 2)).toMatchObject({ page: 2, pages: 3, from: 21, to: 40, total: 45 });
    expect(paginate(trades(45), 3)).toMatchObject({ page: 3, from: 41, to: 45 });
    expect(paginate(trades(45), 99).page).toBe(3);
    expect(paginate(trades(45), 0).page).toBe(1);
    expect(paginate(trades(45), -4).page).toBe(1);
    expect(paginate(trades(45), Number.NaN).page).toBe(1);
    expect(paginate(trades(45), 2.7).page).toBe(2);
    expect(paginate([], 1)).toMatchObject({ rows: [], page: 1, pages: 1, from: 0, to: 0, total: 0 });
    expect(paginate(trades(20), 1)).toMatchObject({ pages: 1, from: 1, to: 20 });
    expect(paginate(trades(21), 1).pages).toBe(2);
  });

  it("the page numbers shown are the first, the last and the ones around the current page, with gaps marked", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(2, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(1, 5)).toEqual([1, 2, null, 5]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageWindow(10, 10)).toEqual([1, null, 9, 10]);
  });

  it("the first page shows 20 rows, says which, has Previous off and Next on, and numbers the pages", () => {
    const out = html(withTrades(45));
    expect(rowsShown(out)).toBe(20);
    expect(out).toContain("Showing 1-20 of 45");
    expect(out).toMatch(/disabled=""[^>]*>Previous</);
    expect(out).not.toMatch(/disabled=""[^>]*>Next</);
    expect(out).toContain('aria-current="page"');
    expect(out).toContain("History pages");
    expect(out).toContain("All 45 trades");
  });

  it("a later page shows its own rows (the last one is short) and turns Next off", () => {
    const mid = html(withTrades(45), { initialPage: 2 });
    expect(rowsShown(mid)).toBe(20);
    expect(mid).toContain("Showing 21-40 of 45");
    expect(mid).toContain("Bybit order t21");
    expect(mid).not.toContain("Bybit order t1 ·");
    const last = html(withTrades(45), { initialPage: 3 });
    expect(rowsShown(last)).toBe(5);
    expect(last).toContain("Showing 41-45 of 45");
    expect(last).toMatch(/disabled=""[^>]*>Next</);
    expect(last).not.toMatch(/disabled=""[^>]*>Previous</);
  });

  it("a page number past the end (after a clear, or fewer trades) lands on the last page instead of an empty one", () => {
    const out = html(withTrades(45), { initialPage: 40 });
    expect(rowsShown(out)).toBe(5);
    expect(out).toContain("Showing 41-45 of 45");
  });

  it("20 or fewer trades: no page buttons, just a count", () => {
    const out = html(withTrades(20));
    expect(rowsShown(out)).toBe(20);
    expect(out).toContain("Showing all 20");
    expect(out).not.toContain("History pages");
    expect(html(view())).toContain("Showing all 3"); // the usual three-trade fixture
  });

  it("no trades: no pager at all", () => {
    expect(html(view({ history: [], historyTotals: { count: 0, wins: 0, losses: 0, total: 0, todayResult: 0 } }))).not.toContain("bybit-pager");
  });

  it("the totals line is for every trade, not just the page", () => {
    expect(html(withTrades(45))).toContain("All 45 trades");
  });
});


// ---- release 7: the LIVE twin of the page, the Open UP / Open DOWN buttons, and the Manual label

/** Expands the page into plain elements so a test can find a control by its test id and call its handler, with no browser. */
function expand(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ children?: ReactNode }>;
    if (typeof el.type === "function") return walk((el.type as (props: unknown) => ReactNode)(el.props));
    out.push(el);
    walk(el.props.children);
  };
  walk(node);
  return out;
}
const flat = (v: BybitView, extra: Partial<Parameters<typeof BybitPanelView>[0]> = {}) => html(v, extra).replace(/<!-- -->/g, "");
const noTrade = (over: Partial<BybitView> = {}) => view({ open: null, ...over });
const controls = (over: Partial<OpenControls> = {}): OpenControls => ({ live: false, busy: false, message: null, asking: null, onAsk: () => {}, onCancel: () => {}, onOpen: () => {}, ...over });
const press = (v: BybitView, c: OpenControls, testid: string) => {
  const found = expand(<OpenByHand c={c} size={v.positionSize} symbol={v.symbol} />).find((e) => (e.props as Record<string, unknown>)["data-testid"] === testid);
  if (!found) throw new Error(`no control ${testid}`);
  (found.props as { onClick: () => void }).onClick();
};

describe("the LIVE twin of the page", () => {
  it("has the same layout as the demo page: the status strip, the four cards, the open trade card and the history table with the same columns", () => {
    for (const live of [false, true]) {
      const out = flat(view(), { live });
      for (const part of ['data-testid="bybit-status"', 'data-testid="bybit-totals"', 'data-testid="bybit-open"', 'data-testid="bybit-history"']) expect(out, `${live} ${part}`).toContain(part);
      for (const head of ["Open trade profit / loss", "Today", "Total since cleared", "Daily loss limit", "Open trade", "Trade history", "Closed", "Side", "Size", "Entry", "Exit", "Result", "How it closed"]) expect(out, `${live} ${head}`).toContain(head);
      expect(out).toContain("Stop loss (set at Bybit)");
      expect(out).toContain("Take profit (set at Bybit)");
      expect(out).toContain("updates every 3 seconds");
    }
  });
  it("says Bybit LIVE account (real money) in red on the live twin, and DEMO (paper money) on the demo page, never both", () => {
    const live = flat(view(), { live: true });
    expect(live).toMatch(/text-down[^>]*>Bybit LIVE account \(real money\)</);
    expect(live).not.toContain("DEMO");
    const demo = flat(view());
    expect(demo).toContain("Bybit DEMO account (paper money)");
    expect(demo).not.toContain("LIVE account");
  });
  it("uses the same 'How it closed' labels", () => {
    const rows = Object.keys(CLOSED_BY).map((k, i) => ({ ...view().history[0], orderId: `x${i}`, closedBy: k }));
    const out = flat(view({ history: rows, historyTotals: { count: rows.length, wins: 0, losses: rows.length, total: -1, todayResult: 0 } }), { live: true });
    for (const { label } of Object.values(CLOSED_BY)) expect(out).toContain(label);
  });
  it("shows the daily loss limit it is given ($2 on live)", () => {
    const out = flat(view({ totals: { ...view().totals, limit: 2, room: 2 } }), { live: true });
    expect(out).toMatch(/left of \$2\.00/);
  });
  it("hides Clear history and Reset on live (no handler is given), and shows them on the demo page", () => {
    const live = flat(view(), { live: true });
    expect(live).not.toContain("Clear history");
    expect(live).not.toContain('data-testid="reset-today"');
    const demo = flat(view(), { onClear: () => {}, onResetToday: () => {} });
    expect(demo).toContain("Clear history");
    expect(demo).toContain('data-testid="reset-today"');
  });
  it("the container reads only the live route on live, and only the demo route on the demo page", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.join(__dirname, "BybitPanel.tsx"), "utf8");
    expect(src).toContain('fetch(live ? "/api/automation/live/trades" : "/api/automation/bybit")');
    expect(src).toContain('fetch(live ? "/api/automation/live/open" : "/api/automation/bybit/open"');
    expect(src).toContain("body: JSON.stringify(live ? { direction, confirm: true } : { direction })");
    expect(src).toContain("onClear={live ? undefined : clear}");
    expect(src).toContain("onResetToday={live ? undefined : resetToday}");
  });
});

describe("Open UP and Open DOWN", () => {
  it("are shown only when no trade is running: not with an open trade, not while Bybit cannot be read", () => {
    expect(flat(noTrade(), { openControls: controls() })).toContain('data-testid="open-up"');
    expect(flat(noTrade(), { openControls: controls() })).toContain('data-testid="open-down"');
    expect(flat(view(), { openControls: controls() })).not.toContain("open-up");
    expect(flat(noTrade({ openError: "Bybit did not answer" }), { openControls: controls() })).not.toContain("open-up");
    expect(flat(noTrade())).not.toContain("open-up"); // a page that gives no controls shows none
  });
  it("on the DEMO page a click opens at once: no question is asked", () => {
    const onOpen = vi.fn();
    const onAsk = vi.fn();
    press(noTrade(), controls({ onOpen, onAsk }), "open-up");
    press(noTrade(), controls({ onOpen, onAsk }), "open-down");
    expect(onOpen.mock.calls).toEqual([["up"], ["down"]]);
    expect(onAsk).not.toHaveBeenCalled();
    expect(flat(noTrade(), { openControls: controls() })).not.toContain("open-confirm-box");
  });
  it("on the LIVE page a click only asks 'Are you sure?' (real money); only the confirm button opens; cancel opens nothing", () => {
    const onOpen = vi.fn();
    const onAsk = vi.fn();
    const onCancel = vi.fn();
    const c = controls({ live: true, onOpen, onAsk, onCancel });
    press(noTrade(), c, "open-up");
    press(noTrade(), c, "open-down");
    expect(onAsk.mock.calls).toEqual([["up"], ["down"]]);
    expect(onOpen).not.toHaveBeenCalled();
    const asking = { ...c, asking: "down" as const };
    const out = flat(noTrade(), { live: true, openControls: asking });
    expect(out).toContain('data-testid="open-confirm-box"');
    expect(out).toContain("Are you sure?");
    expect(out).toMatch(/REAL money/);
    expect(out).toMatch(/Real money can be lost/);
    press(noTrade(), asking, "open-confirm");
    expect(onOpen.mock.calls).toEqual([["down"]]);
    press(noTrade(), asking, "open-cancel");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("no question box is shown until a direction was asked, and nothing is clickable while busy", () => {
    expect(flat(noTrade(), { live: true, openControls: controls({ live: true }) })).not.toContain("open-confirm-box");
    const busy = flat(noTrade(), { openControls: controls({ busy: true }) });
    expect(busy.match(/<button[^>]*data-testid="open-up"[^>]*>/)?.[0]).toMatch(/disabled=""/);
    expect(busy.match(/<button[^>]*data-testid="open-down"[^>]*>/)?.[0]).toMatch(/disabled=""/);
  });
  it("shows the answer: the opened trade, or the refusal in plain words", () => {
    expect(flat(noTrade(), { openControls: controls({ message: { ok: true, text: "Opened a long (UP) trade." } }) })).toContain("Opened a long (UP) trade.");
    const refused = flat(noTrade(), { openControls: controls({ message: { ok: false, text: "The kill switch is on for this bot: no new trade can be opened." } }) });
    expect(refused).toContain("The kill switch is on for this bot");
    expect(refused).toMatch(/bg-down-soft[^>]*data-testid="open-message"/);
  });
  it("the plain words differ: live says real money, demo says paper money", () => {
    expect(flat(noTrade(), { live: true, openControls: controls({ live: true }) })).toMatch(/LIVE account with REAL money/);
    expect(flat(noTrade(), { openControls: controls() })).toMatch(/demo account at once \(paper money\)/);
  });
});

describe("the Manual label", () => {
  it("a trade opened with the button says Manual in the history, in its details and on the open trade; a signal trade does not", () => {
    const rows = [{ ...view().history[0], orderId: "m1", manual: true, byBot: true }, { ...view().history[1], orderId: "s1", manual: false, byBot: true }];
    const out = flat(view({ history: rows, historyTotals: { count: 2, wins: 1, losses: 1, total: 0, todayResult: 0 } }));
    expect(out.match(/data-testid="bybit-manual-pill"/g)).toHaveLength(1);
    const details = renderToStaticMarkup(<TradeDetails r={rows[0]} symbol="BTCUSDT" />);
    expect(details).toContain("Manual: the Open UP / Open DOWN button on this site");
    expect(renderToStaticMarkup(<TradeDetails r={rows[1]} symbol="BTCUSDT" />)).toContain("This site&#x27;s bot (a signal)");
    const manualOpen = flat(view({ open: { ...view().open!, manual: true } }));
    expect(manualOpen).toContain('data-testid="bybit-manual-pill"');
    expect(flat(view())).not.toContain("bybit-manual-pill");
  });
});

describe("the pullback exit rule on the demo Bybit page", () => {
  const rule = (over: Partial<NonNullable<BybitView["pullback"]>> = {}) => ({ enabled: true, fallUsd: 0.03, minPeakUsd: 0.12, ...over });
  it("the demo page says the rule in plain words: the fall, and the minimum peak ($0.12 by default)", () => {
    const out = flat(view({ pullback: rule() }));
    expect(out).toContain('data-testid="bybit-pullback"');
    expect(out).toMatch(/Pullback exit ON: closes a trade when its profit falls \$0\.03 below its best, once that best is at least \$0\.12/);
    expect(out).not.toContain("(no minimum)");
  });
  it("a saved minimum of 0 says so; a saved other value is shown as saved; switched off says OFF", () => {
    expect(flat(view({ pullback: rule({ minPeakUsd: 0 }) }))).toContain("at least $0.00 (no minimum)");
    expect(flat(view({ pullback: rule({ minPeakUsd: 0.3, fallUsd: 0.05 }) }))).toMatch(/falls \$0\.05 below its best, once that best is at least \$0\.30/);
    expect(flat(view({ pullback: rule({ enabled: false }) }))).toContain("Pullback exit OFF");
  });
  it("the live twin shows the LIVE bot's own rule in the same words; a view without it shows nothing", () => {
    expect(flat(view({ pullback: rule({ minPeakUsd: 0.3 }) }), { live: true })).toMatch(/Pullback exit ON: closes a trade when its profit falls \$0\.03 below its best, once that best is at least \$0\.30/);
    expect(flat(view())).not.toContain("bybit-pullback");
    expect(flat(view({ pullback: null }))).not.toContain("bybit-pullback");
  });
});
