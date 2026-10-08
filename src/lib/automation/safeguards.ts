import "server-only";
import { positionsStore } from "./store";
import { maxRisk } from "./strikes";
import { easternDateKey } from "./tradingHours";
import { ACTIVE_POSITION_STATUSES } from "./types";
import type { Position, PositionType } from "./types";

export function activePositionsForBot(botId: string, type?: PositionType): Position[] {
  return positionsStore.query(
    (p) => p.botId === botId && ACTIVE_POSITION_STATUSES.includes(p.status) && (!type || p.type === type),
  );
}

export function activePositionsForBots(botIds: string[]): Position[] {
  const ids = new Set(botIds);
  return positionsStore.query((p) => ids.has(p.botId) && ACTIVE_POSITION_STATUSES.includes(p.status));
}

/** "New positions per trading day" counts positions whose opening attempt
 * (openedAt, set when the position row is first created in `opening`
 * status) falls on today's America/New_York trading date - regardless of
 * whether that attempt ultimately filled, partially filled, or was rejected. */
export function countTodayNewPositions(botId: string, nowMs: number, resetAt = 0): number {
  const today = easternDateKey(nowMs);
  return positionsStore.query(
    (p) => p.botId === botId && !p.splitFrom && p.openedAt != null && p.openedAt > resetAt && easternDateKey(p.openedAt) === today,
  ).length;
}

/** Sum of max risk across a bot's active positions, using each position's
 * realized credit once known or the configured estimate until then.
 * `exclude`: positions a dry run says it *would* have closed, so the Open step is judged as it would be after them. */
export function sumActiveAllocationRisk(botId: string, widthPoints: number, estimatedCredit: number, exclude?: ReadonlySet<string>): number {
  return activePositionsForBot(botId).filter((p) => !exclude?.has(p.id)).reduce((sum, p) => {
    const credit = p.credit ?? estimatedCredit;
    const quantity = p.filledQuantity || p.requestedQuantity;
    return sum + maxRisk(widthPoints, quantity, credit);
  }, 0);
}

export interface Leg {
  underlying: string;
  expiry: string;
  strike: number;
  optionType: "put" | "call";
}

export function positionLegs(p: Pick<Position, "underlying" | "expiry" | "shortStrike" | "longStrike" | "type">): Leg[] {
  const optionType = p.type === "short_put_spread" ? "put" : "call";
  return [
    { underlying: p.underlying, expiry: p.expiry, strike: p.shortStrike, optionType },
    { underlying: p.underlying, expiry: p.expiry, strike: p.longStrike, optionType },
  ];
}

function legsMatch(a: Leg, b: Leg): boolean {
  return a.underlying === b.underlying && a.expiry === b.expiry && a.strike === b.strike && a.optionType === b.optionType;
}

/** "Leg stomping": a new position's legs must not collide with any leg of an
 * existing active position in the same bot or any bot sharing the account. */
export function findOverlap(newLegs: Leg[], existingPositions: Position[]): Position | null {
  for (const existing of existingPositions) {
    const existingLegs = positionLegs(existing);
    if (newLegs.some((leg) => existingLegs.some((existingLeg) => legsMatch(leg, existingLeg)))) return existing;
  }
  return null;
}
