import type { PositionType, StrikeRounding } from "./types";

export interface StrikeConfig {
  putShortOffset: number;
  callShortOffset: number;
  widthPoints: number;
  strikeIncrement: number;
  /** Default "outward". */
  strikeRounding?: StrikeRounding;
}

export interface StrikePair {
  shortStrike: number;
  longStrike: number;
}

/** Everything that went into choosing the strikes, kept on every decision so a
 * strike can always be traced back to the price, offset and rounding behind it. */
export interface StrikePlan extends StrikePair {
  positionType: PositionType;
  price: number;
  /** Signed points added to the price (decimals allowed: -0.01). */
  offset: number;
  /** price + offset, before snapping onto the grid. */
  target: number;
  rounding: StrikeRounding;
  increment: number;
  widthPoints: number;
}

const EPSILON = 1e-9;

/** Float noise (21005.01 - 0.01 landing on 21004.999999999996) must not push a
 * strike a whole increment the wrong way, so values are cleaned first. */
const clean = (n: number) => Math.round(n * 1e6) / 1e6;

/** Snaps `target` onto the grid. outward: a put goes down, a call goes up (the
 * out-of-the-money side). nearest: the closest strike, ties up. */
export function roundToStrike(target: number, increment: number, side: "put" | "call", mode: StrikeRounding): number {
  const steps = clean(target) / increment;
  const n = mode === "nearest" ? Math.round(steps + EPSILON) : side === "put" ? Math.floor(steps + EPSILON) : Math.ceil(steps - EPSILON);
  return clean(n * increment);
}

/** short_strike = round(price + signed_offset). The long strike is always
 * derived from the short strike, never straight from price - that
 * straight-from-price shortcut is exactly what produced Option Alpha's
 * 7715/7715 strike collision bug the spec calls out. */
export function planStrikes(positionType: PositionType, price: number, config: StrikeConfig): StrikePlan {
  const side = positionType === "short_put_spread" ? "put" : "call";
  const offset = side === "put" ? config.putShortOffset : config.callShortOffset;
  const rounding = config.strikeRounding ?? "outward";
  const target = clean(price + offset);
  const shortStrike = roundToStrike(target, config.strikeIncrement, side, rounding);
  const longStrike = side === "put" ? clean(shortStrike - config.widthPoints) : clean(shortStrike + config.widthPoints);
  return { positionType, price, offset, target, rounding, increment: config.strikeIncrement, widthPoints: config.widthPoints, shortStrike, longStrike };
}

export function computeStrikes(positionType: PositionType, price: number, config: StrikeConfig): StrikePair {
  const { shortStrike, longStrike } = planStrikes(positionType, price, config);
  return { shortStrike, longStrike };
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

/** "down" / "up" / "to the nearest" - which way the short strike was snapped. */
export function roundingWords(plan: Pick<StrikePlan, "positionType" | "rounding">): string {
  if (plan.rounding === "nearest") return "to the nearest";
  return plan.positionType === "short_put_spread" ? "down" : "up";
}

/** "Target 21,003.69 (21,003.7 - 0.01), rounded down to 5 -> short 21,000, long 20,990" */
export function describePlan(plan: StrikePlan): string {
  const sign = plan.offset < 0 ? "-" : "+";
  const how = plan.rounding === "nearest" ? "to the nearest" : `${roundingWords(plan)} to`;
  return `Target ${fmt(plan.target)} (${fmt(plan.price)} ${sign} ${fmt(Math.abs(plan.offset))}), rounded ${how} ${fmt(plan.increment)} -> short ${fmt(plan.shortStrike)}, long ${fmt(plan.longStrike)}`;
}

export interface StrikeValidation {
  ok: boolean;
  reason?: string;
}

/** The four invariants the spec requires checked before any order is sent. */
export function validateStrikes(positionType: PositionType, strikes: StrikePair, config: StrikeConfig): StrikeValidation {
  const { shortStrike, longStrike } = strikes;

  if (shortStrike === longStrike) return { ok: false, reason: "short and long strikes are equal" };

  if (positionType === "short_put_spread" && !(shortStrike > longStrike)) {
    return { ok: false, reason: "short put strike must be greater than long put strike" };
  }
  if (positionType === "short_call_spread" && !(shortStrike < longStrike)) {
    return { ok: false, reason: "short call strike must be less than long call strike" };
  }

  if (!onGrid(shortStrike, config.strikeIncrement) || !onGrid(longStrike, config.strikeIncrement)) {
    return { ok: false, reason: "strikes must be multiples of the configured increment" };
  }

  if (clean(Math.abs(shortStrike - longStrike)) !== config.widthPoints) {
    return { ok: false, reason: "gap between strikes must equal the configured width" };
  }

  return { ok: true };
}

function onGrid(strike: number, increment: number): boolean {
  const steps = clean(strike) / increment;
  return Math.abs(steps - Math.round(steps)) < EPSILON;
}

/** width * 100 * quantity - credit received, per spread credit. */
export function maxRisk(widthPoints: number, quantity: number, creditPerSpread: number): number {
  // Whole cents: 3 x (500 - 220) must read 840, not 839.9999999999999.
  return Math.round((widthPoints * 100 * quantity - creditPerSpread * 100 * quantity) * 100) / 100;
}
