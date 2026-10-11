import { validateClosePricing, type ClosePricing } from "./closePricing";
import { maxRisk, planStrikes } from "./strikes";
import type { BotStaticConfig, PositionType } from "./types";

/**
 * What a trigger's Open Position step is set to do, as Option Alpha's panel: how the short and long strike are chosen, how many
 * contracts, how the order is priced, tags, the entry and position criteria, and the exit options. Anything left unset is what
 * the bot's own inputs say (its offsets, width, quantity and open price), so a trigger changes only what was edited.
 *
 * Not here, because they need data this platform does not have: strikes by delta, standard deviation or GEX, VIX and IV Rank,
 * earnings and event dates, and Option Alpha's typical-slippage statistics.
 */

export type Side = "above" | "below";

export type ShortStrikeMethod =
  | { method: "points"; amount: number; side: Side }
  | { method: "percent"; amount: number; side: Side }
  | { method: "flat"; strike: number };

export type LongStrikeMethod = { method: "points"; amount: number } | { method: "percent"; amount: number } | { method: "flat"; strike: number };

export type SizeMethod =
  | { method: "contracts"; count: number }
  | { method: "risk"; dollars: number; cap?: number }
  | { method: "allocation"; percent: number; capDollars?: number; capContracts?: number };

/** "Bot has enough available capital" and "doesn't have a position with an identical leg" are always checked (the allocation limit and the overlap guard). */
export interface EntryCriteria {
  lessOpen?: number;
  lessToday?: number;
  lessForSymbol?: number;
}

export interface PositionCriteria {
  /** The spread's bid/ask width (what it would cost to cross) is less than this. Needs a quote. */
  maxBidAskSpread?: number;
  /** The spread's mid price is between these. Needs a quote. */
  midMin?: number;
  midMax?: number;
  widthMin?: number;
  widthMax?: number;
  /** The short strike is more than this % out of the money. */
  otmPercentAbove?: number;
}

/** Closes a position the bot opened when any of these is met. P/L is worked out from the spread's mid price. Dollars are for the whole position. */
export interface ExitOptions {
  /** Close when the profit is this % of the credit received, or more. */
  profitPercent?: number;
  profitDollars?: number;
  /** Close when the loss is this % of the credit received, or more. */
  stopPercent?: number;
  stopDollars?: number;
  /** Close when the underlying is within this many points of the short strike (or beyond it). */
  touchPoints?: number;
  /** Close at market this many minutes before the market closes, on the day the position expires. Needs no option prices: only the clock. */
  expirationMinutes?: number;
}

export interface OpenSettings {
  shortStrike?: ShortStrikeMethod;
  longStrike?: LongStrikeMethod;
  size?: SizeMethod;
  pricing?: ClosePricing;
  tags?: string[];
  entry?: EntryCriteria;
  position?: PositionCriteria;
  exit?: ExitOptions;
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const nonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
const isSide = (v: unknown): v is Side => v === "above" || v === "below";

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export function validateShortStrike(v: unknown): Checked<ShortStrikeMethod> {
  const m = v as Partial<ShortStrikeMethod> & { amount?: unknown; side?: unknown; strike?: unknown };
  if (!m || typeof m !== "object") return fail("The short strike needs a method.");
  if (m.method === "points" || m.method === "percent") {
    if (!nonNegative(m.amount)) return fail("The short strike amount must be zero or more.");
    if (m.method === "percent" && m.amount >= 100) return fail("The short strike percent must be under 100.");
    if (!isSide(m.side)) return fail("The short strike must be above or below the price.");
    return { ok: true, value: { method: m.method, amount: m.amount, side: m.side } };
  }
  if (m.method === "flat") {
    if (!positive(m.strike)) return fail("The short strike price must be positive.");
    return { ok: true, value: { method: "flat", strike: m.strike } };
  }
  return fail("The short strike method must be points, percent or a flat strike.");
}

export function validateLongStrike(v: unknown): Checked<LongStrikeMethod> {
  const m = v as { method?: unknown; amount?: unknown; strike?: unknown } | null;
  if (!m || typeof m !== "object") return fail("The long strike needs a method.");
  if (m.method === "points" || m.method === "percent") {
    if (!positive(m.amount)) return fail("The long strike amount must be above zero.");
    if (m.method === "percent" && m.amount >= 100) return fail("The long strike percent must be under 100.");
    return { ok: true, value: { method: m.method, amount: m.amount } };
  }
  if (m.method === "flat") {
    if (!positive(m.strike)) return fail("The long strike price must be positive.");
    return { ok: true, value: { method: "flat", strike: m.strike } };
  }
  return fail("The long strike method must be points, percent or a flat strike.");
}

export function validateSize(v: unknown): Checked<SizeMethod> {
  const m = v as { method?: unknown; count?: unknown; dollars?: unknown; cap?: unknown; percent?: unknown; capDollars?: unknown; capContracts?: unknown } | null;
  if (!m || typeof m !== "object") return fail("The position size needs a method.");
  if (m.method === "contracts") return whole(m.count) ? { ok: true, value: { method: "contracts", count: m.count } } : fail("The contracts must be a whole number of at least 1.");
  if (m.method === "risk") {
    if (!positive(m.dollars)) return fail("The risk must be a positive amount.");
    if (m.cap !== undefined && !whole(m.cap)) return fail("The contract cap must be a whole number of at least 1.");
    return { ok: true, value: { method: "risk", dollars: m.dollars, ...(m.cap !== undefined ? { cap: m.cap as number } : {}) } };
  }
  if (m.method === "allocation") {
    if (!positive(m.percent) || m.percent > 100) return fail("The % of the allocation must be above 0 and at most 100.");
    if (m.capDollars !== undefined && !positive(m.capDollars)) return fail("The dollar cap must be a positive amount.");
    if (m.capContracts !== undefined && !whole(m.capContracts)) return fail("The contract cap must be a whole number of at least 1.");
    return { ok: true, value: { method: "allocation", percent: m.percent, ...(m.capDollars !== undefined ? { capDollars: m.capDollars as number } : {}), ...(m.capContracts !== undefined ? { capContracts: m.capContracts as number } : {}) } };
  }
  return fail("The position size must be contracts, a risk in dollars, or a % of the allocation.");
}

function pick<T extends object>(v: unknown, keys: (keyof T & string)[], rules: Partial<Record<keyof T & string, (x: unknown) => string | null>>): Checked<T> {
  const src = (v ?? {}) as Record<string, unknown>;
  if (typeof v !== "object" || v === null) return fail("Expected a set of values.");
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (src[k] === undefined) continue;
    const problem = rules[k]?.(src[k]) ?? null;
    if (problem) return fail(problem);
    out[k] = src[k];
  }
  return { ok: true, value: out as T };
}

const needWhole = (what: string) => (x: unknown) => (whole(x) ? null : `${what} must be a whole number of at least 1.`);
const needPositive = (what: string) => (x: unknown) => (positive(x) ? null : `${what} must be above zero.`);
const needPercent = (what: string) => (x: unknown) => (positive(x) && x <= 100 ? null : `${what} must be above 0 and at most 100.`);

export const validateEntry = (v: unknown) =>
  pick<EntryCriteria>(v, ["lessOpen", "lessToday", "lessForSymbol"], {
    lessOpen: needWhole("The open positions limit"),
    lessToday: needWhole("The new positions today limit"),
    lessForSymbol: needWhole("The open positions with the symbol limit"),
  });

export function validatePositionCriteria(v: unknown): Checked<PositionCriteria> {
  const checked = pick<PositionCriteria>(v, ["maxBidAskSpread", "midMin", "midMax", "widthMin", "widthMax", "otmPercentAbove"], {
    maxBidAskSpread: needPositive("The bid/ask spread"),
    midMin: needPositive("The minimum mid price"),
    midMax: needPositive("The maximum mid price"),
    widthMin: needPositive("The minimum width"),
    widthMax: needPositive("The maximum width"),
    otmPercentAbove: needPositive("The out-of-the-money percent"),
  });
  if (!checked.ok) return checked;
  const c = checked.value;
  if (c.midMin !== undefined && c.midMax !== undefined && c.midMin > c.midMax) return fail("The minimum mid price is above the maximum.");
  if (c.widthMin !== undefined && c.widthMax !== undefined && c.widthMin > c.widthMax) return fail("The minimum width is above the maximum.");
  return checked;
}

export const validateExit = (v: unknown) =>
  pick<ExitOptions>(v, ["profitPercent", "profitDollars", "stopPercent", "stopDollars", "touchPoints", "expirationMinutes"], {
    profitPercent: needPercent("The profit taking %"),
    profitDollars: needPositive("The profit taking amount"),
    stopPercent: needPositive("The stop loss %"),
    stopDollars: needPositive("The stop loss amount"),
    touchPoints: needPositive("The touch distance"),
    expirationMinutes: (x) => (whole(x) && x <= 390 ? null : "The expiration exit must be a whole number of minutes before the close, from 1 to 390."),
  });

/** A whole OpenSettings from the outside: every part is checked, an unknown part is dropped, `pricing` may not use the position trade price. */
export function validateOpenSettings(v: unknown): Checked<OpenSettings> {
  if (typeof v !== "object" || v === null) return fail("Expected the open settings.");
  const src = v as Record<string, unknown>;
  const out: OpenSettings = {};
  const take = <T>(key: string, run: (x: unknown) => Checked<T>, set: (t: T) => void): string | null => {
    if (src[key] === undefined) return null;
    const r = run(src[key]);
    if (!r.ok) return r.reason;
    set(r.value);
    return null;
  };
  const problem =
    take("shortStrike", validateShortStrike, (t) => (out.shortStrike = t)) ??
    take("longStrike", validateLongStrike, (t) => (out.longStrike = t)) ??
    take("size", validateSize, (t) => (out.size = t)) ??
    take("entry", validateEntry, (t) => (out.entry = t)) ??
    take("position", validatePositionCriteria, (t) => (out.position = t)) ??
    take("exit", validateExit, (t) => (out.exit = t)) ??
    take(
      "pricing",
      (x) => {
        const r = validateClosePricing(x);
        if (!r.ok) return r;
        if (r.pricing.speed === "market") return fail("An opening order always has a limit price: Market isn't available when opening.");
        if (r.pricing.tradePrice) return fail("The position trade price isn't available when opening: there is no position yet.");
        return { ok: true as const, value: r.pricing };
      },
      (t) => (out.pricing = t),
    );
  if (problem) return fail(problem);
  if (src.tags !== undefined) {
    if (!Array.isArray(src.tags)) return fail("The tags must be a list.");
    out.tags = [...new Set(src.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean))].slice(0, 20);
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------------------------------------------------

const clean = (n: number) => Math.round(n * 1e6) / 1e6;

export interface StrikeInputs {
  putShortOffset: number;
  callShortOffset: number;
  widthPoints: number;
}

/**
 * The offsets and width this signal's strikes are built with: the bot's own, replaced by what the trigger's short and long strike
 * methods say. The long strike needs the short one (it is "from the short leg"), so the short strike is worked out first.
 * The strike checks (order, grid, width) still run on the result.
 */
export function resolveStrikeInputs(config: BotStaticConfig, type: PositionType, price: number, s: OpenSettings | undefined): { ok: true; inputs: StrikeInputs; words: string[] } | { ok: false; reason: string } {
  const put = type === "short_put_spread";
  let offset = put ? config.putShortOffset : config.callShortOffset;
  const words: string[] = [];
  const m = s?.shortStrike;
  if (m) {
    if (m.method === "flat") {
      offset = clean(m.strike - price);
      words.push(`Short strike: flat ${m.strike}`);
    } else {
      const points = m.method === "points" ? m.amount : (price * m.amount) / 100;
      offset = clean(m.side === "below" ? -points : points);
      words.push(`Short strike: ${m.method === "points" ? `$${m.amount}` : `${m.amount}%`} ${m.side} the price`);
    }
  }
  let width = config.widthPoints;
  const l = s?.longStrike;
  if (l) {
    const base = { ...config, putShortOffset: put ? offset : config.putShortOffset, callShortOffset: put ? config.callShortOffset : offset };
    const short = planStrikes(type, price, base).shortStrike;
    if (l.method === "points") width = l.amount;
    else if (l.method === "percent") width = Math.max(config.strikeIncrement, Math.round((short * l.amount) / 100 / config.strikeIncrement) * config.strikeIncrement);
    else {
      width = clean(put ? short - l.strike : l.strike - short);
      if (!(width > 0)) return { ok: false, reason: `The flat long strike ${l.strike} is not ${put ? "below" : "above"} the short strike ${short}.` };
    }
    words.push(l.method === "flat" ? `Long strike: flat ${l.strike}` : `Long strike: ${l.method === "points" ? `$${l.amount}` : `${l.amount}%`} ${put ? "below" : "above"} the short leg`);
    width = clean(width);
  }
  return { ok: true, inputs: { putShortOffset: put ? offset : config.putShortOffset, callShortOffset: put ? config.callShortOffset : offset, widthPoints: width }, words };
}

/** How many contracts to open: whole contracts. 0 means the size comes to less than one contract (nothing should be opened). Risk is
 * per contract: the width less the expected credit, times 100. */
export function resolveQuantity(config: BotStaticConfig, size: SizeMethod | undefined, widthPoints: number): { quantity: number; words: string } {
  if (!size) return { quantity: config.quantity, words: `${config.quantity} contract${config.quantity === 1 ? "" : "s"}` };
  if (size.method === "contracts") return { quantity: size.count, words: `${size.count} contract${size.count === 1 ? "" : "s"}` };
  const perContract = maxRisk(widthPoints, 1, config.openingCreditEstimate);
  if (!(perContract > 0)) return { quantity: 0, words: "the risk per contract is not above zero" };
  if (size.method === "risk") {
    const n = Math.floor(size.dollars / perContract);
    return { quantity: size.cap !== undefined ? Math.min(n, size.cap) : n, words: `up to $${size.dollars} of risk at $${perContract} per contract${size.cap !== undefined ? `, at most ${size.cap}` : ""}` };
  }
  let dollars = (config.allocationLimit * size.percent) / 100;
  if (size.capDollars !== undefined) dollars = Math.min(dollars, size.capDollars);
  let n = Math.floor(dollars / perContract);
  if (size.capContracts !== undefined) n = Math.min(n, size.capContracts);
  return { quantity: n, words: `${size.percent}% of the $${config.allocationLimit} allocation ($${Math.round(dollars)}) at $${perContract} per contract${size.capContracts !== undefined ? `, at most ${size.capContracts}` : ""}` };
}
