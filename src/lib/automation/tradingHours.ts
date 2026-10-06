import "server-only";
import { nyseCalendarDay } from "@/lib/nyseCalendar";
import { getGlobalWindow } from "./appSettings";
import { TRADING_HOURS, parseClockMinutes } from "./config";

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

/** The hours guard for one bot: its own window when it sets one, else the
 * global window - both on the NYSE calendar. */
export function hoursConfigFor(hours?: { start: string; end: string }): TradingHoursConfig {
  const { startMinutes, endMinutes } = getGlobalWindow();
  return {
    ...TRADING_HOURS,
    startMinutes,
    endMinutes,
    ...(hours ? { startMinutes: parseClockMinutes(hours.start, "hours.start"), endMinutes: parseClockMinutes(hours.end, "hours.end") } : {}),
    ...NYSE_CALENDAR,
  };
}

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

export function isWithinTradingHours(ms: number, config: TradingHoursConfig = hoursConfigFor()): boolean {
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

const clock12 = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`.replace(/^(\d+)(am|pm)$/, "$1:00$2");
};

/** "9:35am - 3:55pm" */
export function describeWindow(config: Pick<TradingHoursConfig, "startMinutes" | "endMinutes"> = getGlobalWindow()): string {
  return `${clock12(config.startMinutes)} - ${clock12(config.endMinutes)}`;
}

/** The time of day the engine saw, and - when it's outside the window - why:
 * "Current time is 9:40am" / "Saturday 3:10pm - the market is closed on weekends". */
export function describeTradingTime(ms: number, config: TradingHoursConfig = hoursConfigFor()): string {
  const { weekday, hour, minute } = easternParts(ms, config.timezone);
  const minutes = hour * 60 + minute;
  const now = clock12(minutes);
  const days: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
  if (weekday === "Sat" || weekday === "Sun") return `${days[weekday]} ${now} - the market is closed on weekends`;
  if (config.isHoliday?.(ms)) return `${days[weekday] ?? weekday} ${now} - ${nyseCalendarDay(ms).label ?? "market holiday"}, the market is closed`;
  const early = config.earlyCloseMinutes?.(ms);
  if (early !== undefined && minutes > Math.min(config.endMinutes, early - (16 * 60 - config.endMinutes))) {
    return `Current time is ${now} - early close day, the window ended ${clock12(early - (16 * 60 - config.endMinutes))}`;
  }
  return `Current time is ${now}`;
}
