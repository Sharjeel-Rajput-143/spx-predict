import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Order, Position } from "@/lib/automation/types";
import { buildPosition } from "@/lib/automation/testSupport";
import { PayoffChart } from "./PayoffChart";
import { PositionDetails } from "./PositionDetails";
import { PositionsView } from "./PositionsTab";

// Server-render tests: no browser, no network.
const noop = () => undefined;
const NOW = Date.UTC(2026, 9, 6, 18, 0); // 2026-10-06 2pm ET - the day buildPosition expires on
const html = (n: React.ReactElement) => renderToStaticMarkup(n);

const open: Position = buildPosition({ id: "p1", type: "short_put_spread", status: "open", shortStrike: 7730, longStrike: 7725, credit: 2.2, underlyingAtOpen: 7734.87, openedAt: NOW - 3_600_000 });
const closed: Position = buildPosition({ id: "p2", type: "short_call_spread", status: "closed", shortStrike: 7740, longStrike: 7745, credit: 2.2, closePrice: 1.7, closedAt: NOW - 600_000, openedAt: NOW - 7_200_000 });

const order = (over: Partial<Order> & { id: string; positionId: string }): Order => ({
  kind: "open",
  status: "filled",
  limitPrice: 2.2,
  filledQuantity: 3,
  ref: "mock-1",
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - 3_599_000,
  ...over,
});

const render = (position: Position, extra: Partial<React.ComponentProps<typeof PositionDetails>> = {}) =>
  html(<PositionDetails position={position} orders={[]} signals={[]} estimate={2.2} bot={{ id: "b", name: "SPX Bullish", accountId: "paper-1" }} last={7786.58} now={NOW} onClose={noop} onChanged={noop} notify={noop} {...extra} />);

describe("Position details panel", () => {
  it("has the guide's header, metrics, greeks, probability grid, payoff, exit options, bot, trades, tags and notes", () => {
    const out = render(open);
    for (const t of [
      "Position details", "SPX", "Short Put Spread", "OCT 6", "7730", "7725",
      "Total P/L", "Return %", "Credit to open", "$660", "Market value", "Capital at risk", "$840", "Return on risk",
      "Trade price", "$2.20", "Mid price", "Bid / ask", "Quantity", "3 contracts", "DIT", "Price at open", "7,734.87",
      "Delta", "Theta", "Gamma", "Vega",
      "Reward/risk", "78.6%", "OTM %", "Breakeven", "7,727.8", "Max profit", "Max loss",
      "Alpha", "EV", "Prob of profit", "Prob of max profit", "Prob of max loss",
      "Profit and loss at expiry", "Exit options", "None set on this position", "Profit %", "Profit $", "Stop loss %", "Stop loss $", "0 days to expiration",
      "SPX Bullish", "Paper Trading", "Move", "Trades", "No orders sent.", "Tags", "Add tag", "Notes", "Edit notes",
    ]) {
      expect(out, t).toContain(t);
    }
    expect(out).toContain('role="dialog"');
  });

  it("shows the exit options a position was opened with, and says they are on", () => {
    const out = render({ ...open, exitOptions: { profitPercent: 50, stopDollars: 400, touchPoints: 25 } });
    for (const t of ["On for this position", "50% of the credit", "$400", "within 25 points of the short strike", "checked every minute"]) expect(out, t).toContain(t);
    expect(out).not.toContain("None set on this position");
    expect(out).not.toContain("aren&#x27;t built");
  });

  it("a position with no exit options says so, and does not claim they are unavailable", () => {
    const out = render(open);
    expect(out).toContain("None set on this position");
    expect(out).not.toContain("aren&#x27;t built in Phase 1");
    expect(out).not.toContain("Bot exit options are off");
  });

  it("header buttons: copy, Close position (an open position), and a disabled Resolve (nothing is stuck)", () => {
    const out = render(open);
    expect(out).toContain('aria-label="Copy position summary"');
    expect(out).toContain(">Close position<");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>(?:<span>)?Resolve…(?:<\/span>)?<\/button>/);
    expect(out).not.toContain("Override");
  });

  it("numbers it can't know are dashes with an explanation, never estimates", () => {
    const out = render(open);
    expect(out).toContain("Needs live option prices");
    expect(out).toContain("Nothing is estimated");
    expect(out).not.toMatch(/Alpha<[^>]*>[^<]*<[^>]*>[^<]*\+\$/); // no invented EV/alpha figure
  });

  it("OTM % uses the live price, in the money turns red", () => {
    expect(render(open, { last: 7786.58 })).toContain("0.73%"); // (7786.58 - 7730) / 7786.58
    expect(render(open, { last: 7700 })).toMatch(/text-down[^>]*>-0\.39%/);
  });

  it("falls back to the price at open when there is no live quote, and says so", () => {
    const out = render(open, { last: null });
    expect(out).toContain("SPX at open");
    expect(out).toContain("Blue pill: SPX at open."); // not lower-cased
    expect(out).toContain("7,734.87");
  });

  it("a closed, priced position shows its P/L and return, and has no Close button", () => {
    const out = render(closed, { estimate: undefined });
    expect(out).toContain("+$150"); // (2.20 - 1.70) x 100 x 3
    expect(out).toContain("+22.7%"); // 150 / 660
    expect(out).toContain("+17.9%"); // 150 / 840
    expect(out).not.toContain(">Close position<");
    expect(out).toMatch(/<button[^>]*disabled[^>]*title="Only an open position can be moved"[^>]*>(?:<span>)?Move(?:<\/span>)?<\/button>|<button[^>]*title="Only an open position can be moved"[^>]*disabled/);
  });

  it("with no known credit there is nothing to draw, rather than a guess", () => {
    const out = render({ ...open, credit: null }, { estimate: undefined });
    expect(out).toContain("No credit is known");
    expect(out).not.toContain('aria-label="Profit and loss at expiry"');
  });

  it("lists each fill with its price movement, fill price and an Automation log link", () => {
    const out = render(open, {
      orders: [order({ id: "o1", positionId: "p1" }), order({ id: "o2", positionId: "p1", kind: "close", limitPrice: 0, createdAt: NOW - 1000, updatedAt: NOW })],
    });
    expect(out).toContain("Open 3 contracts");
    expect(out).toContain("2.20 → 2.20");
    expect(out).toContain("filled at $2.20");
    expect(out).toContain("Close 3 contracts");
    expect(out).toContain("Automation log");
    expect(out).toContain("/automation/bots/b?tab=log");
  });

  it("shows existing tags and notes", () => {
    const out = render({ ...open, tags: ["opening-bias"], notes: "Watch the 10am reversal." });
    expect(out).toContain("opening-bias");
    expect(out).toContain("Watch the 10am reversal.");
  });
});

describe("Payoff chart", () => {
  const spread = { type: "short_put_spread" as const, shortStrike: 7730, longStrike: 7725, credit: 2.2, quantity: 3 };
  const render = (underlying: number | null) => html(<PayoffChart spread={spread} underlying={underlying} />);

  it("draws the payoff with a dashed breakeven line, the strikes, and a current-price pill", () => {
    const out = render(7786.58);
    expect(out).toContain('aria-label="Profit and loss at expiry"');
    expect(out).toContain("BE 7,727.8");
    expect(out).toContain("7,725");
    expect(out).toContain("7,730");
    expect(out).toContain("border-dashed");
    expect(out).toContain("7,786.58"); // the pill
  });

  it("splits the fill at zero: a green clip above and a red clip below", () => {
    const out = render(null);
    expect(out.match(/<clipPath/g)).toHaveLength(2);
    expect(out).toContain("var(--up)");
    expect(out).toContain("var(--down)");
  });

  it("labels the y axis in dollars from -max loss to +max profit and has no pill without a price", () => {
    const out = render(null);
    expect(out).toMatch(/-\$[\d,]+/);
    expect(out).toMatch(/\+\$[\d,]+/);
    expect(out).not.toContain("bg-accent px-2 py-0.5");
  });
});

describe("Show tags on the positions tables", () => {
  it("offers the checkbox in both headers", () => {
    const out = html(
      <PositionsView positions={[open, closed]} orders={[]} signals={[]} now={NOW} estimateFor={() => 2.2} onChanged={noop} notify={noop} />,
    );
    expect(out.match(/Show tags/g)).toHaveLength(2);
  });
});

describe("Resolve, for a position that is stuck", () => {
  const resolveButton = (out: string) => /<button[^>]*?(\sdisabled="")?[^>]*><span>Resolve…<\/span><\/button>/.exec(out);
  const enabled = (out: string) => {
    const m = /<button([^>]*)><span>Resolve…<\/span><\/button>/.exec(out);
    return m !== null && !/\sdisabled=/.test(m[1]);
  };

  it("is available on a closing or opening position, and says what it does", () => {
    for (const status of ["closing", "opening"] as const) {
      const out = render({ ...open, status });
      expect(resolveButton(out), status).not.toBeNull();
      expect(enabled(out), status).toBe(true);
      expect(out).toContain("Ask the broker what is really held and settle this position from that");
    }
  });

  it("is switched off for a position that is not stuck, and the old Override is gone", () => {
    for (const status of ["open", "closed", "expired", "rejected"] as const) {
      const out = render({ ...open, status });
      expect(enabled(out), status).toBe(false);
      expect(out).toContain("Resolve is for a position stuck in closing or opening");
      expect(out).not.toContain("Override");
    }
  });

  it("a position stuck in closing can still be closed again with the Close position button", () => {
    expect(render({ ...open, status: "closing" })).toContain(">Close position<");
  });
});

describe("the Trades list shows what the broker said about a refused price", () => {
  it("the price band in numbers, the broker's own words, and the limit that was sent on a close", () => {
    const orders = [order({ id: "o1", positionId: "p1", kind: "close", status: "canceled", limitPrice: 4.35, filledQuantity: 0, rejectReason: "Order canceled - price band", priceBand: { edge: 1.6, marketPrice: 1.1 } })];
    const out = render({ ...open, status: "closing" }, { orders });
    expect(out).toContain("IBKR price band: market 1.10, won&#x27;t take 1.60 or beyond");
    expect(out).toContain("Order canceled - price band");
    expect(out).toContain("4.35 →");
  });

  it("an order with no refusal shows neither", () => {
    const out = render(open, { orders: [order({ id: "o2", positionId: "p1" })] });
    expect(out).not.toContain("price band");
  });
});
