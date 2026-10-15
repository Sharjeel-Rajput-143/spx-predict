/**
 * IBKR refuses an order priced too far through its market (its "price band", error 202): a BUY far above, or a SELL far below, what the
 * spread trades at. The refusal is immediate, and it carries what the broker itself thinks: the market price, and the edge, the first price
 * it will not take. So a refusal is information: the order is priced again from the broker's own numbers.
 *
 *  - The edge is EXCLUSIVE ("at or more aggressive than X"): X itself is refused. A BUY has to be at least one tick below it, a SELL at least
 *    one tick above. The tick is 0.05 below 3.00 and 0.10 from 3.00 up, as the bridge rounds.
 *  - A BUY is also never priced more than `maxAboveMarket` above the broker's market price.
 *  - Nothing goes beyond the bot's own final price, and a credit is never under the minimum credit.
 * Pure arithmetic: no I/O, no clock.
 */

export interface PriceBand {
  /** The first price the broker refuses, on this order's side. Present only when the broker's message had it. */
  edge?: number;
  /** What the broker thinks the spread trades at. Present only when the broker's message had it. */
  marketPrice?: number;
}

/** The most re-prices of one ladder: a broker that keeps refusing is not argued with. */
export const MAX_REPRICES = 2;
/** The most a closing BUY is priced above the broker's market price, unless the setting says otherwise. */
export const DEFAULT_MAX_ABOVE_MARKET = 1;

const cents = (n: number) => Math.round(n * 100) / 100;
/** The bridge's tick: 0.05 under 3.00, 0.10 from there. */
export const tickAt = (price: number) => (Math.abs(price) < 3 ? 0.05 : 0.1);
const down = (p: number) => cents(Math.floor(p / tickAt(p) + 1e-9) * tickAt(p));
const up = (p: number) => cents(Math.ceil(p / tickAt(p) - 1e-9) * tickAt(p));
const nearest = (p: number) => cents(Math.round(p / tickAt(p)) * tickAt(p));

/** The highest price a BUY may be sent at: at least one tick under the edge. */
export function highestBuy(edge: number): number {
  let p = down(edge - 0.01);
  while (p >= edge - 1e-9) p = cents(p - tickAt(p));
  return p;
}

/** The lowest price a SELL may be sent at: at least one tick over the edge. */
export function lowestSell(edge: number): number {
  let p = up(edge + 0.01);
  while (p <= edge + 1e-9) p = cents(p + tickAt(p));
  return p;
}

export interface RepriceInput {
  /** "debit" = a closing BUY, "credit" = an opening SELL. */
  side: "debit" | "credit";
  band: PriceBand;
  /** The price the broker just refused. */
  refused: number;
  /** The worst price the bot would accept (its ladder's final price): the most for a BUY, the least for a SELL. Never gone beyond. */
  finalPrice: number;
  /** How many prices the new ladder may have. */
  rungs: number;
  /** A SELL is never priced under this. */
  minCredit?: number;
  /** A BUY is never priced more than this above the broker's market price (when it gave one). */
  maxAboveMarket?: number;
  /** A spread is never worth more than its width. */
  width?: number;
}

export type RepriceResult = { ok: true; prices: number[]; note: string } | { ok: false; reason: string };

/**
 * The prices to try next, from the broker's own numbers: starting at its market price, stepping toward the worst price it will take, never
 * past the edge, the bot's own final price, the cap above market, or the minimum credit. Gives up (says why) when nothing sensible is left, or
 * when the broker gave nothing to go on.
 */
export function repriceAfterBand(input: RepriceInput): RepriceResult {
  const { side, band, refused, finalPrice, rungs } = input;
  const { edge, marketPrice } = band;
  if (edge === undefined && marketPrice === undefined) return { ok: false, reason: "the broker gave no price to go on" };
  const tick = DEFAULT_TICK;
  const cap = input.width !== undefined ? input.width - tick : Infinity;

  // The farthest price this side may go, and where it starts.
  let far: number;
  let start: number;
  if (side === "debit") {
    far = finalPrice;
    if (edge !== undefined) far = Math.min(far, highestBuy(edge));
    if (marketPrice !== undefined) far = Math.min(far, nearest(marketPrice + (input.maxAboveMarket ?? DEFAULT_MAX_ABOVE_MARKET)));
    far = Math.min(far, cap);
    start = marketPrice !== undefined ? Math.min(nearest(marketPrice), far) : far;
    if (!(far > 0) || !(start > 0)) return { ok: false, reason: `no price above zero is allowed (edge ${edge ?? "?"}, market ${marketPrice ?? "?"})` };
    if (far >= refused - 1e-9 && marketPrice === undefined) return { ok: false, reason: `the broker's edge ${edge} does not leave a lower price to try than ${refused}` };
  } else {
    far = finalPrice;
    if (edge !== undefined) far = Math.max(far, lowestSell(edge));
    if (input.minCredit !== undefined) far = Math.max(far, input.minCredit);
    start = marketPrice !== undefined ? Math.max(nearest(marketPrice), far) : far;
    if (start > cap) start = cap;
    if (far > cap) return { ok: false, reason: `the lowest price the broker takes (${far}) is not a credit this spread can pay` };
    if (far <= refused + 1e-9 && marketPrice === undefined) return { ok: false, reason: `the broker's edge ${edge} does not leave a higher price to try than ${refused}` };
  }

  const prices: number[] = [];
  const n = Math.max(1, rungs);
  for (let i = 0; i < n; i++) {
    const raw = n === 1 ? start : start + ((far - start) * i) / (n - 1);
    const p = side === "debit" ? Math.min(nearest(raw), far) : Math.max(nearest(raw), far);
    if (prices.length === 0 || prices[prices.length - 1] !== p) prices.push(p);
  }
  // Never the very price just refused again.
  const fresh = prices.filter((p) => Math.abs(p - refused) > 1e-9);
  if (fresh.length === 0) return { ok: false, reason: `the only price left, ${refused}, is the one the broker just refused` };
  const where = [marketPrice !== undefined ? `the market is ${marketPrice.toFixed(2)}` : null, edge !== undefined ? `it will not take ${edge.toFixed(2)} or ${side === "debit" ? "more" : "less"}` : null].filter(Boolean).join(", ");
  return { ok: true, prices: fresh, note: `${where}: re-priced to ${fresh.map((p) => p.toFixed(2)).join(", ")}` };
}

const DEFAULT_TICK = 0.05;
