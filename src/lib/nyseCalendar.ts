/**
 * NYSE holiday/early-close calendar, computed by rule rather than a
 * hardcoded date table so it never goes stale. Mirrors the conventions NYSE
 * actually publishes (the same ones Option Alpha and TradingView observe):
 * a fixed-date holiday landing on Saturday is observed the preceding
 * Friday, one landing on Sunday is observed the following Monday; floating
 * holidays are always weekdays by construction.
 */

export interface NyseCalendarDay {
  status: "closed" | "early-close" | "open";
  label?: string;
}

function weekdayOf(year: number, month: number, day: number): number {
  // 0 = Sunday ... 6 = Saturday. Uses UTC-anchored dates purely as calendar
  // arithmetic - no timezone conversion involved, Date.UTC also normalizes
  // an out-of-range day (e.g. day 0 or day -1) into the previous month.
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number {
  const firstDow = weekdayOf(year, month, 1);
  const offset = (weekday - firstDow + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = weekdayOf(year, month, daysInMonth);
  const diff = (lastDow - weekday + 7) % 7;
  return daysInMonth - diff;
}

/** Saturday shifts to the preceding Friday, Sunday to the following Monday. */
function observedDate(year: number, month: number, day: number): { month: number; day: number } {
  const dow = weekdayOf(year, month, day);
  if (dow === 6) return { month, day: day - 1 };
  if (dow === 0) return { month, day: day + 1 };
  return { month, day };
}

/** Meeus/Jones/Butcher algorithm for the Gregorian Easter Sunday. */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function fullClosureKeys(year: number): Map<string, string> {
  const days = new Map<string, string>();
  const add = (month: number, day: number, label: string) => days.set(dateKey(year, month, day), label);

  const newYears = observedDate(year, 1, 1);
  add(newYears.month, newYears.day, "New Year's Day");
  add(1, nthWeekdayOfMonth(year, 1, 1, 3), "Martin Luther King, Jr. Day");
  add(2, nthWeekdayOfMonth(year, 2, 1, 3), "Washington's Birthday");

  const easter = easterSunday(year);
  const goodFriday = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  add(goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate(), "Good Friday");

  add(5, lastWeekdayOfMonth(year, 5, 1), "Memorial Day");
  if (year >= 2022) {
    const juneteenth = observedDate(year, 6, 19);
    add(juneteenth.month, juneteenth.day, "Juneteenth");
  }
  const independence = observedDate(year, 7, 4);
  add(independence.month, independence.day, "Independence Day");
  add(9, nthWeekdayOfMonth(year, 9, 1, 1), "Labor Day");
  add(11, nthWeekdayOfMonth(year, 11, 4, 4), "Thanksgiving Day");
  const christmas = observedDate(year, 12, 25);
  add(christmas.month, christmas.day, "Christmas Day");

  return days;
}

function earlyCloseKeys(year: number): Map<string, string> {
  const days = new Map<string, string>();

  // Day after Thanksgiving - always a Friday, always an early close.
  const thanksgiving = nthWeekdayOfMonth(year, 11, 4, 4);
  days.set(dateKey(year, 11, thanksgiving + 1), "Day after Thanksgiving");

  // July 3rd, unless July 4th fell on Saturday (then July 3rd is itself the
  // observed, fully-closed Independence Day holiday) or July 3rd is a weekend.
  const july4Dow = weekdayOf(year, 7, 4);
  const july3Dow = weekdayOf(year, 7, 3);
  if (july4Dow !== 6 && july3Dow !== 0 && july3Dow !== 6) {
    days.set(dateKey(year, 7, 3), "Day before Independence Day");
  }

  // Christmas Eve, unless Dec 25th fell on Saturday (then Dec 24th is itself
  // the observed, fully-closed Christmas holiday) or Dec 24th is a weekend.
  const dec25Dow = weekdayOf(year, 12, 25);
  const dec24Dow = weekdayOf(year, 12, 24);
  if (dec25Dow !== 6 && dec24Dow !== 0 && dec24Dow !== 6) {
    days.set(dateKey(year, 12, 24), "Christmas Eve");
  }

  return days;
}

function easternDateKey(ms: number): { key: string; year: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const year = get("year");
  return { key: dateKey(year, get("month"), get("day")), year };
}

/** Full closure / 1:00pm ET early close / ordinary trading day, for the
 * calendar date `ms` falls on in America/New_York. Callers still need their
 * own weekend check - this only knows about holidays. */
export function nyseCalendarDay(ms: number): NyseCalendarDay {
  const { key, year } = easternDateKey(ms);
  const closed = fullClosureKeys(year).get(key);
  if (closed) return { status: "closed", label: closed };
  const early = earlyCloseKeys(year).get(key);
  if (early) return { status: "early-close", label: early };
  return { status: "open" };
}
