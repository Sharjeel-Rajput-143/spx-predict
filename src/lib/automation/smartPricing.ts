/**
 * Option Alpha's SmartPricing, as documented: timed limit orders that start
 * near the mid price and step toward the "final price" - the worst price the
 * bot will accept - waiting a few seconds at each. The final price stays
 * active for the order's fill timeout, then cancels. "100% of bid/ask" is the
 * final price all the way across the spread (the bid when selling, the ask
 * when buying); 80% would stop short of it.
 *
 * Presets (from Option Alpha's docs): Normal = up to 4 prices, 10 seconds
 * each; Fast = up to 3 prices, 5 seconds each; Patient = up to 5 prices, 20
 * seconds each; Off = a single limit order at the final price.
 *
 * This file is arithmetic only: no I/O, no clock.
 */

export type SmartPricingMode = "normal" | "fast" | "patient" | "off";

export const SMART_PRICING_MODES: SmartPricingMode[] = ["normal", "fast", "patient", "off"];

export const SMART_PRICING_PRESETS: Record<SmartPricingMode, { prices: number; secondsEach: number }> = {
  normal: { prices: 4, secondsEach: 10 },
  fast: { prices: 3, secondsEach: 5 },
  patient: { prices: 5, secondsEach: 20 },
  off: { prices: 1, secondsEach: 0 },
};

export interface Quote {
  bid: number;
  ask: number;
}

/** The two legs' own quotes. */
export interface LegQuotes {
  short: Quote;
  long: Quote;
  /** True when the data is delayed (a paper account without a subscription): quotes then run wide and stale. Unset = not known. */
  delayed?: boolean;
}

/** Smallest price step. TODO(unconfirmed): SPX/NDX option tick sizes - 0.05 is used until confirmed. */
export const DEFAULT_PRICE_TICK = 0.05;

const roundTo = (n: number, tick: number) => Math.round(n / tick) * tick;
const cents = (n: number) => Math.round(n * 100) / 100;

export type SpreadSide = "credit" | "debit";

/** What the spread can be traded at, as one price: `mid`, and `natural` - the far end of the spread
 * (the worst price to sell at / the most to pay). Opening a short spread is a credit (sell the short leg,
 * buy the long); closing it is a debit (buy the short back, sell the long). */
export function spreadMarket(side: SpreadSide, legs: LegQuotes): { mid: number; natural: number; best: number } | null {
  const { short, long } = legs;
  if (![short.bid, short.ask, long.bid, long.ask].every(Number.isFinite)) return null;
  if (short.bid > short.ask || long.bid > long.ask) return null; // crossed: not a market we should trade on
  // Hitting the bids on the short leg and lifting the long's ask is the worst credit; the reverse is the best.
  const creditNatural = short.bid - long.ask;
  const creditBest = short.ask - long.bid;
  const natural = side === "credit" ? creditNatural : creditBest;
  const best = side === "credit" ? creditBest : creditNatural;
  return { mid: (natural + best) / 2, natural, best };
}

/** Final prices other than "% of bid/ask", as Option Alpha lets several be set at once: the best one is the final price. */
export interface FinalPrices {
  /** % of the way from the mid to the bid/ask. */
  percent?: number;
  /** At most this much from the mid price (never beyond the bid/ask). */
  slippage?: number;
  /** A fixed price. */
  flat?: number;
  /** A price worked out from the position's own trade price. */
  tradePrice?: number;
}

export interface LadderInput {
  side: SpreadSide;
  legs: LegQuotes;
  mode: SmartPricingMode;
  /** The final price as a percent of the way from mid to bid/ask. 100 = the full spread. */
  finalPercent: number;
  /** When given, these replace `finalPercent`: each is a candidate final price and the best one wins (the lowest to pay, the highest to receive). */
  finals?: FinalPrices;
  tick?: number;
  /** A credit can't be worth more than the width. */
  width?: number;
}

export interface Ladder {
  prices: number[];
  mid: number;
  final: number;
  mode: SmartPricingMode;
  secondsEach: number;
}

export type LadderResult = { ok: true; ladder: Ladder } | { ok: false; reason: string };

/** The prices to try, in order: the first at the mid, the last at the final price, evenly between,
 * rounded to the tick with duplicates collapsed (a tight spread has fewer than four distinct prices). */
export function buildLadder(input: LadderInput): LadderResult {
  const tick = input.tick ?? DEFAULT_PRICE_TICK;
  const market = spreadMarket(input.side, input.legs);
  if (!market) return { ok: false, reason: "The quotes are missing or crossed." };
  const { mid, natural } = market;
  if (!(mid > 0)) return { ok: false, reason: `The spread's mid price is ${cents(mid)}, not a price worth trading at.` };

  const pct = Math.min(Math.max(input.finalPercent, 0), 100) / 100;
  let finalRaw = mid + (natural - mid) * pct;
  if (input.finals) {
    const f = input.finals;
    const candidates: number[] = [];
    if (f.percent !== undefined) candidates.push(mid + (natural - mid) * (Math.min(Math.max(f.percent, 0), 100) / 100));
    if (f.slippage !== undefined) candidates.push(input.side === "debit" ? Math.min(mid + f.slippage, natural) : Math.max(mid - f.slippage, natural));
    if (f.flat !== undefined) candidates.push(f.flat);
    if (f.tradePrice !== undefined) candidates.push(f.tradePrice);
    if (candidates.length > 0) finalRaw = input.side === "debit" ? Math.min(...candidates) : Math.max(...candidates);
  }
  const preset = SMART_PRICING_PRESETS[input.mode];
  const raw: number[] = [];
  if (preset.prices === 1) raw.push(finalRaw);
  else for (let i = 0; i < preset.prices; i++) raw.push(mid + ((finalRaw - mid) * i) / (preset.prices - 1));

  const cap = input.width !== undefined ? input.width - tick : Infinity;
  const prices: number[] = [];
  for (const p of raw) {
    const price = cents(Math.min(Math.max(roundTo(p, tick), tick), cap));
    if (prices.length === 0 || prices[prices.length - 1] !== price) prices.push(price);
  }
  if (prices.length === 0) return { ok: false, reason: "No price in the ladder is within the allowed range." };
  return { ok: true, ladder: { prices, mid: cents(mid), final: prices[prices.length - 1], mode: input.mode, secondsEach: preset.secondsEach } };
}

/** "SmartPricing Normal: 3.55, 3.45, 3.35, 3.30 (10s each, mid 3.55, final 100% of bid/ask)" */
export function describeLadder(l: Ladder, finalPercent: number | string): string {
  const final = typeof finalPercent === "number" ? `${finalPercent}% of bid/ask` : finalPercent;
  if (l.mode === "off") return `Limit at ${l.final.toFixed(2)} (${final}, mid ${l.mid.toFixed(2)})`;
  return `SmartPricing ${l.mode[0].toUpperCase()}${l.mode.slice(1)}: ${l.prices.map((p) => p.toFixed(2)).join(", ")} (${l.secondsEach}s each, mid ${l.mid.toFixed(2)}, final ${final})`;
}
