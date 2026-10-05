import { describe, expect, it } from "vitest";
import { easternDateKey, isWithinTradingHours } from "./tradingHours";

// All reference times are Oct 2026, EDT (UTC-4). Confirmed via Intl against
// the same timezone the implementation uses, not hand-computed offsets.
const TUESDAY_10_40_ET = Date.UTC(2026, 9, 6, 14, 40); // Oct 6 2026, 10:40am ET
const TUESDAY_09_35_ET = Date.UTC(2026, 9, 6, 13, 35); // exactly the open boundary
const TUESDAY_09_34_ET = Date.UTC(2026, 9, 6, 13, 34); // one minute before open
const TUESDAY_15_55_ET = Date.UTC(2026, 9, 6, 19, 55); // exactly the close boundary
const TUESDAY_15_56_ET = Date.UTC(2026, 9, 6, 19, 56); // one minute after close
const SATURDAY_NOON_ET = Date.UTC(2026, 9, 10, 16, 0);
const SUNDAY_NOON_ET = Date.UTC(2026, 9, 11, 16, 0);

describe("isWithinTradingHours", () => {
  it("is true on a weekday mid-session", () => {
    expect(isWithinTradingHours(TUESDAY_10_40_ET)).toBe(true);
  });

  it("includes the 9:35 open boundary", () => {
    expect(isWithinTradingHours(TUESDAY_09_35_ET)).toBe(true);
  });

  it("excludes one minute before 9:35", () => {
    expect(isWithinTradingHours(TUESDAY_09_34_ET)).toBe(false);
  });

  it("includes the 15:55 close boundary", () => {
    expect(isWithinTradingHours(TUESDAY_15_55_ET)).toBe(true);
  });

  it("excludes one minute after 15:55", () => {
    expect(isWithinTradingHours(TUESDAY_15_56_ET)).toBe(false);
  });

  it("excludes Saturday", () => {
    expect(isWithinTradingHours(SATURDAY_NOON_ET)).toBe(false);
  });

  it("excludes Sunday", () => {
    expect(isWithinTradingHours(SUNDAY_NOON_ET)).toBe(false);
  });

  it("honors the Phase 2 holiday hook when provided", () => {
    const config = {
      timezone: "America/New_York",
      startMinutes: 9 * 60 + 35,
      endMinutes: 15 * 60 + 55,
      isHoliday: () => true,
    };
    expect(isWithinTradingHours(TUESDAY_10_40_ET, config)).toBe(false);
  });
});

describe("isWithinTradingHours - NYSE calendar", () => {
  // Nov 2026 is EST (UTC-5).
  const THANKSGIVING_NOON_ET = Date.UTC(2026, 10, 26, 17, 0); // Thu Nov 26, full closure
  const BLACK_FRIDAY_12_55_ET = Date.UTC(2026, 10, 27, 17, 55); // early close day, last allowed minute
  const BLACK_FRIDAY_12_56_ET = Date.UTC(2026, 10, 27, 17, 56);
  const BLACK_FRIDAY_14_00_ET = Date.UTC(2026, 10, 27, 19, 0); // would be fine on a normal day

  it("is closed all day on a market holiday", () => {
    expect(isWithinTradingHours(THANKSGIVING_NOON_ET)).toBe(false);
  });

  it("ends the window five minutes before a 1:00pm early close", () => {
    expect(isWithinTradingHours(BLACK_FRIDAY_12_55_ET)).toBe(true);
    expect(isWithinTradingHours(BLACK_FRIDAY_12_56_ET)).toBe(false);
    expect(isWithinTradingHours(BLACK_FRIDAY_14_00_ET)).toBe(false);
  });
});

describe("easternDateKey", () => {
  it("formats as YYYY-MM-DD in America/New_York", () => {
    expect(easternDateKey(TUESDAY_10_40_ET)).toBe("2026-10-06");
  });

  it("stays on the prior ET day late at night UTC", () => {
    // 2026-10-07 00:30 UTC is still 2026-10-06 8:30pm in New York.
    expect(easternDateKey(Date.UTC(2026, 9, 7, 0, 30))).toBe("2026-10-06");
  });
});
