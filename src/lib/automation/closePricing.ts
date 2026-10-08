import { SMART_PRICING_MODES, type FinalPrices, type SmartPricingMode } from "./smartPricing";

/**
 * How a trigger's Close Position step prices its order, as Option Alpha's SmartPricing dialog: a speed (the ladder preset, or a
 * market order) and the final price - the worst price the bot will pay to close. Several final prices can be set; the best one
 * (for a close, the lowest) is used. Unset, the step uses the bot's own SmartPricing setting and close price.
 * Option Alpha's "% of typical slippage for the symbol" is not here: it comes from its own liquidity statistics.
 */

export type CloseSpeed = SmartPricingMode | "market";
export const CLOSE_SPEEDS: readonly CloseSpeed[] = [...SMART_PRICING_MODES, "market"];

export const TRADE_OPS = ["×", "+", "−", "÷"] as const;
export type TradeOp = (typeof TRADE_OPS)[number];

export interface ClosePricing extends Omit<FinalPrices, "tradePrice"> {
  speed: CloseSpeed;
  /** The position's own trade price (the credit it was opened for) with an operation: "× .5" is half of it. */
  tradePrice?: { op: TradeOp; value: number };
}

/** The credit the position was opened for, put through the operation; null when there is no credit to work from or the result isn't a price. */
export function applyTradeOp(credit: number | null | undefined, t: { op: TradeOp; value: number }): number | null {
  if (credit == null || !Number.isFinite(credit) || credit <= 0) return null;
  const out = t.op === "×" ? credit * t.value : t.op === "+" ? credit + t.value : t.op === "−" ? credit - t.value : credit / t.value;
  return Number.isFinite(out) && out > 0 ? Math.round(out * 100) / 100 : null;
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export function validateClosePricing(value: unknown): { ok: true; pricing: ClosePricing } | { ok: false; reason: string } {
  const v = value as Partial<ClosePricing> | null;
  if (!v || typeof v !== "object") return { ok: false, reason: "The close pricing needs a speed and a final price." };
  if (!CLOSE_SPEEDS.includes(v.speed as CloseSpeed)) return { ok: false, reason: `The speed must be one of: ${CLOSE_SPEEDS.join(", ")}.` };
  const out: ClosePricing = { speed: v.speed as CloseSpeed };
  if (v.percent !== undefined) {
    if (!positive(v.percent) || v.percent > 100) return { ok: false, reason: "The % of bid/ask must be above 0 and at most 100." };
    out.percent = v.percent;
  }
  if (v.slippage !== undefined) {
    if (!positive(v.slippage)) return { ok: false, reason: "The slippage from the mid price must be a positive amount." };
    out.slippage = v.slippage;
  }
  if (v.flat !== undefined) {
    if (!positive(v.flat)) return { ok: false, reason: "The price must be a positive amount." };
    out.flat = v.flat;
  }
  if (v.tradePrice !== undefined) {
    if (!TRADE_OPS.includes(v.tradePrice?.op as TradeOp) || !positive(v.tradePrice?.value)) return { ok: false, reason: "The position trade price needs an operation (× + − ÷) and a positive value." };
    out.tradePrice = { op: v.tradePrice.op, value: v.tradePrice.value };
  }
  if (out.speed !== "market" && out.percent === undefined && out.slippage === undefined && out.flat === undefined && out.tradePrice === undefined) {
    return { ok: false, reason: "Choose at least one final price." };
  }
  return { ok: true, pricing: out };
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** The final prices in words: "100% of bid/ask, or $0.05 slippage from the mid (the best one is used)". */
export function describeFinals(p: ClosePricing): string {
  const parts: string[] = [];
  if (p.percent !== undefined) parts.push(`${p.percent}% of bid/ask`);
  if (p.slippage !== undefined) parts.push(`up to ${money(p.slippage)} slippage from the mid price`);
  if (p.flat !== undefined) parts.push(money(p.flat));
  if (p.tradePrice) parts.push(`position trade price ${p.tradePrice.op} ${p.tradePrice.value}`);
  return parts.length > 1 ? `${parts.join(" or ")} (the best is used)` : (parts[0] ?? "");
}

export function describeClosePricing(p: ClosePricing): string {
  if (p.speed === "market") return "Market order";
  return `SmartPricing ${p.speed[0].toUpperCase()}${p.speed.slice(1)}, final price ${describeFinals(p)}`;
}

/**
 * How much of the position a Close Position step closes, as Option Alpha's Quantity: a percent of it, or a number of contracts.
 * (Option Alpha's "shares" is for stock; these positions are spreads, traded in contracts.) Unset = all of it.
 */
export type CloseQuantity = { mode: "percent"; value: number } | { mode: "contracts"; value: number };

export function validateCloseQuantity(value: unknown): { ok: true; quantity: CloseQuantity } | { ok: false; reason: string } {
  const v = value as Partial<CloseQuantity> | null;
  if (!v || typeof v !== "object") return { ok: false, reason: "The quantity needs a mode and a value." };
  if (v.mode === "percent") {
    if (!positive(v.value) || v.value > 100) return { ok: false, reason: "The % of the position must be above 0 and at most 100." };
    return { ok: true, quantity: { mode: "percent", value: v.value } };
  }
  if (v.mode === "contracts") {
    if (!positive(v.value) || !Number.isInteger(v.value)) return { ok: false, reason: "The contracts must be a whole number of at least 1." };
    return { ok: true, quantity: { mode: "contracts", value: v.value } };
  }
  return { ok: false, reason: "The quantity is either a percent of the position or a number of contracts." };
}

/** How many of a position's `total` contracts to close: whole contracts, at least 1, never more than it holds. */
export function contractsToClose(total: number, q: CloseQuantity | undefined): number {
  if (!q || total <= 0) return total;
  const n = q.mode === "percent" ? Math.round((total * q.value) / 100) : q.value;
  return Math.min(total, Math.max(1, n));
}

export function describeQuantity(q: CloseQuantity | undefined): string {
  if (!q) return "100% of position";
  return q.mode === "percent" ? `${q.value}% of position` : `${q.value} contract${q.value === 1 ? "" : "s"}`;
}
