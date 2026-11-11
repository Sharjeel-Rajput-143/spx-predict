import "server-only";
import { holdsUntilClosed } from "./brokerVenue";
import { UNKNOWN_RESULT, isDerivPosition } from "./derivResults";
import { positionsStore } from "./store";
import { easternDateKey } from "./tradingHours";
import { ACTIVE_POSITION_STATUSES } from "./types";

/** A position held at Bybit (a perpetual, no expiry) is never marked expired here: it is still held at the exchange, and only a close order ends it. */
/** Safety net, run at the start of every signal: expires any active position
 * left over from a *prior* trading day (the EOD sweep is supposed to have
 * already done this, but a missed sweep must never block today's first
 * signal). SPX 0DTE options are cash settled and European style, so there's
 * no early-assignment risk in just marking these expired instead of trying
 * to close them. */
export function expireStalePositions(botId: string, nowMs: number): number {
  const today = easternDateKey(nowMs);
  const stale = positionsStore.query(
    (p) => p.botId === botId && ACTIVE_POSITION_STATUSES.includes(p.status) && p.expiry < today && !holdsUntilClosed(p),
  );
  for (const p of stale) positionsStore.update(p.id, { status: "expired", closedAt: nowMs, ...(isDerivPosition(p) ? { resultUnknown: UNKNOWN_RESULT } : {}) });
  return stale.length;
}

/** The end-of-day sweep: every still-active position expires outright, same
 * day or not - the engine never sends an order to close on expiry. Given a
 * bot id it touches only that bot's positions. */
export function expireAllActivePositions(nowMs: number, botId?: string): number {
  const active = positionsStore.query((p) => ACTIVE_POSITION_STATUSES.includes(p.status) && !holdsUntilClosed(p) && (botId === undefined || p.botId === botId));
  for (const p of active) positionsStore.update(p.id, { status: "expired", closedAt: nowMs, ...(isDerivPosition(p) ? { resultUnknown: UNKNOWN_RESULT } : {}) });
  return active.length;
}
