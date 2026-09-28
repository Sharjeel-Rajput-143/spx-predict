import { nyseCalendarDay } from "./nyseCalendar";
import type { Ticker } from "./types";

export type MarketStatus = "open" | "pre" | "after" | "closed";

/**
 * Regular-hours check backed by the rule-based NYSE holiday/early-close
 * calendar (nyseCalendar.ts) for "regular"-session tickers. The "almost24"
 * (CME Globex-style) branch below is intentionally untouched - futures
 * observe their own holiday calendar, out of scope here.
 */
function easternParts(now: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(get("minute"));
  return { weekday, minutesOfDay: hour * 60 + minute };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function getMarketStatus(ticker: Ticker, now: number = Date.now()): MarketStatus {
  const { weekday, minutesOfDay } = easternParts(now);
  const isWeekend = weekday === "Sat" || weekday === "Sun";

  if (ticker.session === "almost24") {
    // CME Globex-style schedule: closed Fri 17:00 ET - Sun 18:00 ET, plus a
    // short daily maintenance break, otherwise treated as open.
    if (weekday === "Sat") return "closed";
    if (weekday === "Sun" && minutesOfDay < 18 * 60) return "closed";
    if (weekday === "Fri" && minutesOfDay >= 17 * 60) return "closed";
    if (minutesOfDay >= 17 * 60 && minutesOfDay < 18 * 60) return "closed"; // daily break
    return "open";
  }

  if (isWeekend) return "closed";

  const calendarDay = nyseCalendarDay(now);
  if (calendarDay.status === "closed") return "closed";

  // Early-close days (day after Thanksgiving, Christmas Eve, July 3rd) end
  // the regular session at 1:00pm ET instead of 4:00pm, but keep the same
  // 4-hour after-hours window TradingView-style platforms show afterward.
  const closeMinute = calendarDay.status === "early-close" ? 13 * 60 : 16 * 60;

  if (minutesOfDay < 4 * 60) return "closed";
  if (minutesOfDay < 9 * 60 + 30) return "pre";
  if (minutesOfDay < closeMinute) return "open";
  if (minutesOfDay < closeMinute + 4 * 60) return "after";
  return "closed";
}

export function formatOpensIn(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "Opens in Xh Ym" for the closed badge - next weekday 9:30 ET that isn't a
 * full NYSE holiday (an early-close day still opens normally at 9:30). */
export function nextOpenMs(now: number = Date.now()): number {
  const oneDay = 24 * 60 * 60_000;
  for (let i = 0; i < 12; i++) {
    const candidate = now + i * oneDay;
    const { weekday } = easternParts(candidate);
    if (weekday === "Sat" || weekday === "Sun") continue;
    if (nyseCalendarDay(candidate).status === "closed") continue;
    // Build a Date for 9:30 ET on that candidate day using the same
    // formatter's date parts, then just search forward minute-by-minute
    // from `now` is overkill - approximate by snapping to 9:30 ET via offset.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(candidate);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const y = get("year");
    const m = get("month");
    const d = get("day");
    // 9:30 ET expressed via a fixed UTC offset guess (-05:00/-04:00 handled
    // by re-deriving through Date.parse of an ISO string interpreted as ET
    // is not directly supported without a tz DB, so approximate using the
    // offset implied by comparing UTC now to the ET parts above).
    const utcNow = new Date(now);
    const etNowParts = easternParts(now);
    const offsetMinutes = Math.round((utcNow.getTime() - now) / 60_000) + (utcNow.getUTCHours() * 60 + utcNow.getUTCMinutes() - etNowParts.minutesOfDay);
    const target = Date.UTC(Number(y), Number(m) - 1, Number(d), 9, 30) + offsetMinutes * 60_000;
    if (target > now) return target;
  }
  return now + oneDay;
}
