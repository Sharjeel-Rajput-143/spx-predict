import "server-only";
import { envNumber } from "./config";
import { alertsStore, decisionsStore, errorsStore, runsStore, signalsStore } from "./store";

/**
 * The log grows with every signal. Left alone it makes every page and, on a host that loads the records for each request (Vercel),
 * every answer slower, until a TradingView call no longer gets its answer in time. So entries older than LOG_RETENTION_DAYS
 * (default 90; 0 keeps everything) are removed: signals, their decisions and runs, alerts and error records.
 *
 * Positions and their orders are never removed here (they are the bot's history and its P/L), and nothing the bot still needs is
 * old enough to be touched: duplicate protection looks back two minutes, the monitors look at the latest signal, the failsafe at today.
 */
const DAY_MS = 24 * 60 * 60_000;

const shared = globalThis as typeof globalThis & { __lastPrunedAt?: number };

export const retentionDays = (): number => Math.max(0, envNumber("LOG_RETENTION_DAYS", 90));

export interface PruneResult {
  signals: number;
  decisions: number;
  runs: number;
  alerts: number;
  errors: number;
}

export function pruneOldRecords(now: number = Date.now()): PruneResult {
  const days = retentionDays();
  const none: PruneResult = { signals: 0, decisions: 0, runs: 0, alerts: 0, errors: 0 };
  if (days === 0) return none;
  const cutoff = now - days * DAY_MS;
  return {
    signals: signalsStore.removeWhere((s) => s.receivedAt < cutoff),
    decisions: decisionsStore.removeWhere((d) => d.createdAt < cutoff),
    runs: runsStore.removeWhere((r) => r.startedAt < cutoff),
    alerts: alertsStore.removeWhere((a) => a.createdAt < cutoff),
    errors: errorsStore.removeWhere((e) => e.createdAt < cutoff),
  };
}

/** Called often (every minute by the scheduler, on each webhook call); does the work at most once a day per process. */
export function pruneOncePerDay(now: number = Date.now()): PruneResult | null {
  if (shared.__lastPrunedAt !== undefined && now - shared.__lastPrunedAt < DAY_MS) return null;
  shared.__lastPrunedAt = now;
  return pruneOldRecords(now);
}

/** For tests. */
export const __resetPruneClock = (): void => {
  shared.__lastPrunedAt = undefined;
};
