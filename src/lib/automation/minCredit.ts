/**
 * The lowest credit an open may be priced at. A SmartPricing ladder walks from the mid toward the far end of the spread; on a wide or stale
 * quote that far end can be almost nothing (a ladder once ended at 0.05 on a spread worth about 1.10, and that rung filled). A rung under
 * the floor is never sent. Pure arithmetic: no I/O.
 */

const TICK = 0.05;
/** With no floor set, a quarter of the credit the bot expects. */
export const DEFAULT_FLOOR_FRACTION = 0.25;

const cents = (n: number) => Math.round(n * 100) / 100;

/** The floor in force: the bot's own setting, else a quarter of its expected credit, to the nearest tick. */
export function effectiveMinCredit(config: { minCredit?: number; openingCreditEstimate: number }): number {
  if (config.minCredit !== undefined && Number.isFinite(config.minCredit) && config.minCredit >= 0) return cents(config.minCredit);
  return cents(Math.round((config.openingCreditEstimate * DEFAULT_FLOOR_FRACTION) / TICK) * TICK);
}

export interface FloorResult {
  /** The rungs at or above the floor, in the original order. */
  kept: number[];
  /** The rungs under it, which are never sent. */
  dropped: number[];
}

/** Splits a ladder at the floor. Rungs fall from the mid to the final price, so what is kept is a prefix of the ladder. */
export function applyFloor(prices: number[], floor: number): FloorResult {
  const kept: number[] = [];
  const dropped: number[] = [];
  for (const p of prices) (p + 1e-9 >= floor ? kept : dropped).push(p);
  return { kept, dropped };
}
