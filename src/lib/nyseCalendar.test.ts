import { describe, expect, it } from "vitest";
import { nyseCalendarDay } from "./nyseCalendar";

// Noon UTC always lands on the same America/New_York calendar date year
// round (never crosses midnight ET in either EST or EDT), so these probes
// don't need to account for DST.
function noonUtc(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 16, 0, 0);
}

describe("nyseCalendarDay", () => {
  it("flags the 2025 full-closure holidays", () => {
    const holidays: [number, number, number][] = [
      [2025, 1, 1], // New Year's Day
      [2025, 1, 20], // MLK Day
      [2025, 2, 17], // Washington's Birthday
      [2025, 4, 18], // Good Friday
      [2025, 5, 26], // Memorial Day
      [2025, 6, 19], // Juneteenth
      [2025, 7, 4], // Independence Day
      [2025, 9, 1], // Labor Day
      [2025, 11, 27], // Thanksgiving
      [2025, 12, 25], // Christmas
    ];
    for (const [y, m, d] of holidays) {
      expect(nyseCalendarDay(noonUtc(y, m, d)).status).toBe("closed");
    }
  });

  it("flags the 2025 early closes", () => {
    const earlyCloses: [number, number, number][] = [
      [2025, 7, 3],
      [2025, 11, 28],
      [2025, 12, 24],
    ];
    for (const [y, m, d] of earlyCloses) {
      expect(nyseCalendarDay(noonUtc(y, m, d)).status).toBe("early-close");
    }
  });

  it("treats an ordinary weekday as open", () => {
    expect(nyseCalendarDay(noonUtc(2025, 3, 12)).status).toBe("open");
  });

  it("does not treat Juneteenth as a holiday before it was recognized", () => {
    // June 19, 2020 was a Friday, but Juneteenth wasn't an NYSE holiday until 2022.
    expect(nyseCalendarDay(noonUtc(2020, 6, 19)).status).toBe("open");
  });
});
