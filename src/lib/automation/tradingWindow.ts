import { easternMinutesOfDay, hoursConfigFor, type TradingHoursConfig } from "./tradingHours";
import type { BrokerExecutor } from "./types";

/**
 * The hours the engine judges a signal, a scheduled close or an open against. An executor with its own trading window (Deriv's, 09:35 to 15:55 New York
 * time by default) decides it for the underlyings it trades: whatever the global or the bot's own hours say, nothing is sent to it outside that window.
 * Any other executor leaves the hours as they were (the bot's own, else the global window).
 */
export function hoursFor(executor: Pick<BrokerExecutor, "tradingWindowFor"> | undefined, underlying: string | undefined, fallback?: { start: string; end: string }): TradingHoursConfig {
  const own = underlying ? executor?.tradingWindowFor?.(underlying) : null;
  return { ...hoursConfigFor(own ?? fallback), ...(own?.alwaysOn ? { alwaysOn: true } : {}) };
}

/** True when the executor itself restricts the hours for this underlying (so a skip is worded as "outside trading window" and says nothing reached the broker). */
export const hasExecutorWindow = (executor: Pick<BrokerExecutor, "tradingWindowFor"> | undefined, underlying: string | undefined): boolean => !!(underlying && executor?.tradingWindowFor?.(underlying));

/** Whether a NEW contract can still be bought now, for an executor that has a last buy time (Deriv's): `late` once now is past it, and the time in "HH:MM" New York time. */
export function lastBuyCheck(executor: Pick<BrokerExecutor, "lastBuyMinutesFor"> | undefined, underlying: string | undefined, now: number): { late: boolean; at: string } | null {
  const last = underlying ? executor?.lastBuyMinutesFor?.(underlying, now) : null;
  if (last === null || last === undefined) return null;
  const at = `${String(Math.floor(last / 60)).padStart(2, "0")}:${String(((last % 60) + 60) % 60).padStart(2, "0")}`;
  return { late: easternMinutesOfDay(now) > last, at };
}
