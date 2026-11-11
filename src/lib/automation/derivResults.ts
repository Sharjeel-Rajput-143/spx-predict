import "server-only";
import { reportsOwnResult, unknownResultFor } from "./brokerVenue";
import { positionsStore } from "./store";
import type { BrokerExecutor, Position } from "./types";

/**
 * The result of a Deriv position is Deriv's own. It is never worked out from the position's strikes or credit (a Deriv contract has neither: they are
 * only what the engine carries), and an estimate is never stored for it. A contract that was sold, expired or was left unsold gets the profit Deriv itself
 * reports for it (settled by `settleDerivResults`); until then, or when Deriv cannot be asked, the position says "unknown, check Deriv".
 */

export const UNKNOWN_RESULT = "unknown, check Deriv";

export const isDerivPosition = (p: Pick<Position, "venue">): boolean => p.venue === "deriv";

const RETRY_AFTER_MS = 10 * 60_000;
const g = globalThis as typeof globalThis & { __derivResultAttempts?: Map<string, number> };
const attempts = (g.__derivResultAttempts ??= new Map<string, number>());

/** Marks a Deriv position's result as unknown (no estimate is stored). */
export function markResultUnknown(positionId: string): void {
  const p = positionsStore.get(positionId);
  if (p && reportsOwnResult(p) && !p.settlement && p.resultUnknown !== unknownResultFor(p.venue)) positionsStore.update(positionId, { resultUnknown: unknownResultFor(p.venue) });
}

/**
 * Reads Deriv's own result for each finished Deriv position that has none: positions that expired or were left unsold (and so were marked expired), and positions
 * closed by a sale (their result is then Deriv's reported profit, not a computed one). A settled contract gets `settlement: { kind: "broker", pl }`; one Deriv says is
 * still open, or one that cannot be read, stays "unknown, check Deriv". Reads only, so it works at any hour; each position is tried at most every 10 minutes.
 * Returns how many it settled. `recentMs` limits a pass to positions closed within that long (the quick pass the Bybit risk monitor makes, with a short `retryAfterMs`).
 */
export async function settleDerivResults(executor: Pick<BrokerExecutor, "getContractResult"> | undefined, now: number = Date.now(), options: { retryAfterMs?: number; recentMs?: number } = {}): Promise<number> {
  const read = executor?.getContractResult;
  if (!read) return 0;
  const waiting = positionsStore.query((p) => reportsOwnResult(p) && !p.settlement && (p.status === "expired" || p.status === "closed") && !!p.brokerOrderRef);
  let settled = 0;
  for (const p of waiting) {
    if (options.recentMs !== undefined && (p.closedAt ?? 0) < now - options.recentMs) continue; // only trades that closed lately (the quick pass)
    const last = attempts.get(p.id);
    if (last !== undefined && now - last < (options.retryAfterMs ?? RETRY_AFTER_MS)) continue;
    attempts.set(p.id, now);
    try {
      const r = await read.call(executor, p.brokerOrderRef!);
      if (r && r.settled && r.profit !== null && Number.isFinite(r.profit)) {
        positionsStore.update(p.id, { settlement: { kind: "broker", pl: Math.round(r.profit * 100) / 100, at: now }, resultUnknown: undefined });
        settled++;
      } else if (p.status === "expired") {
        markResultUnknown(p.id);
      }
    } catch {
      if (p.status === "expired") markResultUnknown(p.id);
    }
  }
  return settled;
}

/** For tests: forget when each position was last tried. */
export const resetDerivResultAttempts = (): void => attempts.clear();
