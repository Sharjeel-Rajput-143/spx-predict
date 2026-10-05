import "server-only";
import { nyseCalendarDay } from "@/lib/nyseCalendar";
import { TRADING_HOURS } from "./config";

export interface TradingHoursConfig {
  timezone: string;
  startMinutes: number;
  endMinutes: number;
  /** Full-day closures (holidays). */
  isHoliday?: (ms: number) => boolean;
  /** Minutes-of-day the market closes on an early-close day, if `ms` is one. */
  earlyCloseMinutes?: (ms: number) => number | undefined;
}

const REGULAR_CLOSE_MINUTES = 16 * 60;
const EARLY_CLOSE_MINUTES = 13 * 60;

/** The default hours guard follows the NYSE calendar: no trading on a holiday,
 * and on a 1:00pm early close the window ends the same distance before the
 * close as it does on a normal day (15:55 -> 12:55). */
const NYSE_CALENDAR: Pick<TradingHoursConfig, "isHoliday" | "earlyCloseMinutes"> = {
  isHoliday: (ms) => nyseCalendarDay(ms).status === "closed",
  earlyCloseMinutes: (ms) => (nyseCalendarDay(ms).status === "early-close" ? EARLY_CLOSE_MINUTES : undefined),
};

function easternParts(ms: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: get("weekday"), hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

export function isWithinTradingHours(ms: number, config: TradingHoursConfig = { ...TRADING_HOURS, ...NYSE_CALENDAR }): boolean {
  if (config.isHoliday?.(ms)) return false;
  const { weekday, hour, minute } = easternParts(ms, config.timezone);
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutesOfDay = hour * 60 + minute;
  const earlyClose = config.earlyCloseMinutes?.(ms);
  const endMinutes = earlyClose === undefined ? config.endMinutes : earlyClose - (REGULAR_CLOSE_MINUTES - config.endMinutes);
  return minutesOfDay >= config.startMinutes && minutesOfDay <= Math.min(config.endMinutes, endMinutes);
}

/** "YYYY-MM-DD" for the America/New_York calendar date `ms` falls on - used
 * to tag 0DTE expiry, the daily new-position count, and the error failsafe's
 * per-trading-day counter, so all three roll over at the same boundary. */
export function easternDateKey(ms: number, timezone: string = TRADING_HOURS.timezone): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
