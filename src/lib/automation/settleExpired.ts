import "server-only";
import { fetchYahooDailyClose } from "@/lib/marketData/yahooFinance";
import { payoffAt } from "./payoff";
import { positionQuantity } from "./pnl";
import { positionsStore } from "./store";
import { easternDateKey } from "./tradingHours";
import type { Position } from "./types";

/**
 * An expired position whose result was never worked out - the end-of-day sweep couldn't run (a host that sleeps between calls) or had no
 * price - is settled from that day's official closing price, the way an index option settles: the spread's value at that price, from its
 * strikes and credit. The result says it is an estimate (and a person can still type the real one in). Nothing is guessed: no closing
 * price, no result.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const RETRY_AFTER_MS = 10 * 60_000;
/** The most closing prices fetched in one go, so a page waiting on this is never held up for long. */
const MAX_LOOKUPS = 3;

const g = globalThis as typeof globalThis & { __settleAttempts?: Map<string, number> };
const attempts = (g.__settleAttempts ??= new Map<string, number>());

export type CloseLookup = (symbol: string, dateKey: string) => Promise<number | null>;

/** Settles what it can, returns how many positions it settled. */
export async function settleExpiredFromClose(options: { botId?: string; now?: number; lookup?: CloseLookup } = {}): Promise<number> {
  const now = options.now ?? Date.now();
  const lookup = options.lookup ?? ((symbol, dateKey) => fetchYahooDailyClose(symbol, dateKey));
  const today = easternDateKey(now);
  const waiting = positionsStore.query(
    (p) => p.status === "expired" && !p.settlement && p.credit != null && p.expiry < today && (options.botId === undefined || p.botId === options.botId),
  );
  if (waiting.length === 0) return 0;

  const groups = new Map<string, Position[]>();
  for (const p of waiting) {
    const key = `${p.underlying}|${p.expiry}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  let settled = 0;
  let lookups = 0;
  for (const [key, positions] of groups) {
    const last = attempts.get(key);
    if (last !== undefined && now - last < RETRY_AFTER_MS) continue;
    if (lookups >= MAX_LOOKUPS) break;
    lookups++;
    const [symbol, dateKey] = key.split("|");
    const close = await lookup(symbol, dateKey).catch(() => null);
    if (close === null || !Number.isFinite(close) || close <= 0) {
      attempts.set(key, now);
      continue;
    }
    attempts.delete(key);
    for (const p of positions) {
      const quantity = positionQuantity(p);
      const spread = { type: p.type, shortStrike: p.shortStrike, longStrike: p.longStrike, credit: p.credit!, quantity };
      const pl = round2(payoffAt(spread, close));
      const settleValue = round2(p.credit! - pl / (100 * quantity));
      positionsStore.update(p.id, { underlyingAtClose: p.underlyingAtClose ?? close, settlement: { kind: "estimated", pl, underlyingPrice: close, settleValue, at: now } });
      settled++;
    }
  }
  return settled;
}

/** Test hook: forget which lookups failed recently. */
export function __resetSettleAttempts(): void {
  attempts.clear();
}
