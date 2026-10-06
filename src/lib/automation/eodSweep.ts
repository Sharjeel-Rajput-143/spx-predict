import "server-only";
import { DEFAULT_EOD_SWEEP_MINUTES, parseClockMinutes } from "./config";
import { getBotStaticConfig, listBotIds } from "./bots";
import { expireAllActivePositions } from "./expiry";
import { easternDateKey } from "./tradingHours";

const TICK_MS = 60_000;
let started = false;
/** Per bot: each bot has its own sweep time, so each has its own "done today". */
const lastSweptTradingDate = new Map<string, string>();

function easternMinutesOfDay(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

/** When this bot's positions are swept (minutes after midnight ET): its own
 * setting, or 4:05pm. A bot whose inputs aren't complete holds no positions,
 * so it just gets the default rather than stopping the other bots' sweeps. */
export function sweepMinutesFor(botId: string): number {
  try {
    const time = getBotStaticConfig(botId).eodSweepTime;
    return time ? parseClockMinutes(time, "eodSweepTime") : DEFAULT_EOD_SWEEP_MINUTES;
  } catch {
    return DEFAULT_EOD_SWEEP_MINUTES;
  }
}

/** Marks active positions `expired` - one bot's with a bot id, otherwise every
 * bot's. Safe to call more than once; expiring an already-expired set is a no-op. */
export function runEndOfDaySweep(nowMs: number = Date.now(), botId?: string): number {
  const count = expireAllActivePositions(nowMs, botId);
  const today = easternDateKey(nowMs);
  for (const id of botId ? [botId] : listBotIds()) lastSweptTradingDate.set(id, today);
  return count;
}

/** Sweeps every bot whose own sweep time has passed and that hasn't been
 * swept today. Returns the bots it swept. */
export function runDueSweeps(now: number): string[] {
  const today = easternDateKey(now);
  const minutes = easternMinutesOfDay(now);
  const swept: string[] = [];
  for (const botId of listBotIds()) {
    if (lastSweptTradingDate.get(botId) === today) continue;
    if (minutes >= sweepMinutesFor(botId)) {
      runEndOfDaySweep(now, botId);
      swept.push(botId);
    }
  }
  return swept;
}

function tick(): void {
  runDueSweeps(Date.now());
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

/** Test hook: forget which bots were already swept. */
export function __resetSweepState(): void {
  lastSweptTradingDate.clear();
}
