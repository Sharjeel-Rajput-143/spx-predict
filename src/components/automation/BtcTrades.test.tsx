import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BybitView, HistoryRow } from "@/lib/automation/bybitView";
import { buildPosition } from "@/lib/automation/testSupport";
import { PositionsView } from "./bot/PositionsTab";
import { BTC_LABEL, BtcTradesView, botTrades, resultsByDay } from "./BtcTrades";
import { CalendarGrid } from "./CalendarView";

/** The BTC Bybit Bot's trades on Positions and the Calendar: BTC prices, the result after fees, how each closed, labelled as the Bybit demo. */

const T = Date.UTC(2026, 9, 6, 15, 0);
const row = (over: Partial<HistoryRow>): HistoryRow => ({ orderId: "o1", side: "Long", size: 0.001, entryPrice: 74_901.4, exitPrice: 75_112.8, pnl: -0.29, pnlPercent: -0.39, fees: 0.08, openFee: 0.04, closeFee: 0.04, grossPnl: -0.21, leverage: 10, entryValue: 74.9, exitValue: 75.1, openedAt: T - 60_000, closedBy: "stop_loss", byBot: true, manual: false, closedAt: T, ...over });
const view = (over: Partial<BybitView> = {}): BybitView => ({
  symbol: "BTCUSDT",
  positionSize: 0.001,
  mode: "24 hours a day, every day",
  killSwitch: false,
  open: null,
  openError: null,
  mismatch: null,
  history: [
    row({ orderId: "a", pnl: 0.03, pnlPercent: 0.04, entryPrice: 75_000, exitPrice: 75_080, closedBy: "breakeven_stop", closedAt: T }),
    row({ orderId: "b", pnl: -0.29, closedBy: "stop_loss", closedAt: T - 3_600_000 }),
    row({ orderId: "c", pnl: 0.5, closedBy: "take_profit", closedAt: T - 7_200_000 }),
    row({ orderId: "d", pnl: 0.2, closedBy: "signal_flip", closedAt: T - 9_000_000 }),
    row({ orderId: "hand", pnl: 9, closedBy: "closed_at_broker", byBot: false, manual: false, closedAt: T - 1000 }),
  ],
  historyError: null,
  historyClearedAt: null,
  todayResetAt: null,
  historyTotals: { count: 5, wins: 4, losses: 1, total: 9.44, todayResult: 0 },
  closed: [],
  closedCount: 0,
  totals: { day: "2026-10-06", dayResult: 0, realizedToday: 0, openLoss: 0, running: 0, limit: 10, room: 10, reached: false, tripped: false },
  asOf: 0,
  ...over,
});

describe("the BTC trades on Positions", () => {
  it("shows the closed trades with BTC prices, the result after fees, and how each closed, labelled as the Bybit demo", () => {
    const html = renderToStaticMarkup(<BtcTradesView v={view()} />);
    expect(html).toContain(BTC_LABEL);
    expect(html).toContain("Bybit demo");
    expect(html).toContain("BTCUSDT");
    expect(html).toContain("75,000.00"); // entry
    expect(html).toContain("75,080.00"); // exit
    expect(html).toContain("+$0.03");
    expect(html).toContain("-$0.29");
    for (const label of ["Breakeven stop", "Stop loss", "Take profit", "Signal flip"]) expect(html).toContain(label);
    expect(html).toContain("after fees");
    expect(html).not.toMatch(/put spread|call spread|NDX/i);
  });

  it("lists only the trades the bot opened: a trade placed by hand at Bybit is not among the bot's positions", () => {
    const v = view();
    expect(botTrades(v).map((r) => r.orderId)).toEqual(["a", "b", "c", "d"]);
    const html = renderToStaticMarkup(<BtcTradesView v={v} />);
    expect(html).toContain("4 trades");
    expect(html).not.toContain("+$9.00");
  });

  it("the total is the sum after fees of the bot's own trades", () => {
    const html = renderToStaticMarkup(<BtcTradesView v={view()} />);
    expect(html).toContain("+$0.44"); // 0.03 - 0.29 + 0.5 + 0.2
  });

  it("an open trade shows live from Bybit, and says when its stop was moved to breakeven; no open trade says the account is flat", () => {
    const open = { side: "Long" as const, size: 0.001, entryPrice: 75_000, currentPrice: 75_300, pnl: 0.3, pnlPercent: 0.4, valueUsd: 75.3, stopLoss: 75_090, takeProfit: 76_500, ifStopLoss: 0.09, ifTakeProfit: 1.5, breakeven: { price: 75_090, at: T }, manual: false };
    const html = renderToStaticMarkup(<BtcTradesView v={view({ open })} />);
    expect(html).toContain("You are");
    expect(html).toContain("moved to breakeven");
    expect(html).toContain("75,090.00");
    const flat = renderToStaticMarkup(<BtcTradesView v={view()} />);
    expect(flat).toContain("The Bybit demo account is flat");
  });

  it("says plainly when Bybit's history cannot be read, and when there is nothing yet", () => {
    expect(renderToStaticMarkup(<BtcTradesView v={view({ historyError: "Bybit GET failed (HTTP 500)" })} />)).toContain("could not be read just now: Bybit GET failed");
    expect(renderToStaticMarkup(<BtcTradesView v={view({ history: [] })} />)).toContain("No closed trades yet");
  });

  it("the Positions list keeps Bybit trades out of its option tables: a simulated SPX spread stays, a Bybit one (even from the NDX days) does not", () => {
    const spx = buildPosition({ id: "spx-open", type: "short_put_spread", status: "open" });
    const old = buildPosition({ id: "old-bybit", botId: "ndx_ema_bias", underlying: "NDX", type: "short_put_spread", status: "closed", venue: "bybit", shortStrike: 21_000, longStrike: 20_990, credit: 0.76, closePrice: 0.77 });
    const html = renderToStaticMarkup(
      <PositionsView positions={[spx, old]} orders={[]} signals={[]} now={T} estimateFor={() => 3.5} botName={(id) => id} onChanged={() => {}} notify={() => {}} />,
    );
    expect(html).toContain("SPX");
    expect(html).not.toContain("NDX");
    expect(html).not.toContain("21,000");
  });

  it("the BTC bot's own page, with no trades yet, has no empty option tables", () => {
    const html = renderToStaticMarkup(<PositionsView positions={[]} showBtc orders={[]} signals={[]} now={T} estimateFor={() => undefined} onChanged={() => {}} notify={() => {}} />);
    expect(html).not.toContain("Open positions");
    expect(html).not.toContain("Closed positions");
  });
});

describe("the Calendar", () => {
  it("sums the bot's trades per New York day, after fees", () => {
    const days = resultsByDay(botTrades(view()));
    expect([...days.values()].reduce((s, d) => s + d.trades, 0)).toBe(4);
    expect(Math.round([...days.values()].reduce((s, d) => s + d.pnl, 0) * 100) / 100).toBe(0.44);
  });

  it("shows each day's BTC result in the month grid and in the list, labelled", () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const html = renderToStaticMarkup(<CalendarGrid btcDays={new Map([[today, { pnl: 1.25, trades: 2 }]])} />);
    expect(html).toContain('data-testid="btc-day"');
    expect(html).toContain("+$1.25");
    expect(html).toContain("BTC · 2 trades");
    expect(html).toContain(BTC_LABEL);
    expect(html).toContain("around the clock");
  });

  it("without Bybit nothing about BTC is shown", () => {
    const html = renderToStaticMarkup(<CalendarGrid btcDays={null} />);
    expect(html).not.toContain("btc-day");
    expect(html).not.toContain("BTC");
  });
});
