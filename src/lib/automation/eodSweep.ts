import "server-only";
import { EOD_SWEEP_HOUR_ET, EOD_SWEEP_MINUTE_ET } from "./config";
import { expireAllActivePositions } from "./expiry";
import { easternDateKey } from "./tradingHours";

const TICK_MS = 60_000;
let started = false;
let lastSweptTradingDate: string | null = null;

function easternHourMinute(ms: number): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: get("hour") % 24, minute: get("minute") };
}

/** The actual 4:05pm ET sweep - marks every active position `expired`. Safe
 * to call more than once; expiring an already-expired set is a no-op. */
export function runEndOfDaySweep(nowMs: number = Date.now()): number {
  const count = expireAllActivePositions(nowMs);
  lastSweptTradingDate = easternDateKey(nowMs);
  return count;
}

function tick(): void {
  const now = Date.now();
  const today = easternDateKey(now);
  if (lastSweptTradingDate === today) return;
  const { hour, minute } = easternHourMinute(now);
  const isPastSweepTime = hour > EOD_SWEEP_HOUR_ET || (hour === EOD_SWEEP_HOUR_ET && minute >= EOD_SWEEP_MINUTE_ET);
  if (isPastSweepTime) runEndOfDaySweep(now);
}

/** Lazily started (same pattern as automations/scheduler.ts's
 * startAutomationScheduler), kept alive for the life of the process. The
 * per-signal stale-position check (expiry.ts's expireStalePositions) is the
 * safety net if this never gets started or a tick is missed. */
export function startEodScheduler(): void {
  if (started) return;
  started = true;
  tick();
  setInterval(tick, TICK_MS);
}
