import type { PositionType } from "./types";

export interface StrikeConfig {
  putShortOffset: number;
  callShortOffset: number;
  widthPoints: number;
  strikeIncrement: number;
}

export interface StrikePair {
  shortStrike: number;
  longStrike: number;
}

function roundToIncrement(value: number, increment: number): number {
  return Math.round(value / increment) * increment;
}

/** short_strike = round_to_increment(price + signed_offset). The long strike
 * is always derived from the short strike, never straight from price - that
 * straight-from-price shortcut is exactly what produced Option Alpha's
 * 7715/7715 strike collision bug the spec calls out. */
export function computeStrikes(positionType: PositionType, price: number, config: StrikeConfig): StrikePair {
  const offset = positionType === "short_put_spread" ? config.putShortOffset : config.callShortOffset;
  const shortStrike = roundToIncrement(price + offset, config.strikeIncrement);
  const longStrike = positionType === "short_put_spread" ? shortStrike - config.widthPoints : shortStrike + config.widthPoints;
  return { shortStrike, longStrike };
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

  if (shortStrike % config.strikeIncrement !== 0 || longStrike % config.strikeIncrement !== 0) {
    return { ok: false, reason: "strikes must be multiples of the configured increment" };
  }

  if (Math.abs(shortStrike - longStrike) !== config.widthPoints) {
    return { ok: false, reason: "gap between strikes must equal the configured width" };
  }

  return { ok: true };
}

/** width * 100 * quantity - credit received, per spread credit. */
export function maxRisk(widthPoints: number, quantity: number, creditPerSpread: number): number {
  return widthPoints * 100 * quantity - creditPerSpread * 100 * quantity;
}
