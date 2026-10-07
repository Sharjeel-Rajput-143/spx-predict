import { beforeEach, describe, expect, it } from "vitest";
import { nyseCalendarDay } from "@/lib/nyseCalendar";
import { __resetSweepState, runDueSweeps } from "./eodSweep";
import { easternDateKey, hoursConfigFor, isWithinTradingHours } from "./tradingHours";
import { NDX_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";

// Every clock the bot looks at is New York's, whatever the server's own time zone is (Vercel runs in UTC). These tests give it UTC
// instants, in winter (EST, UTC-5) and summer (EDT, UTC-4), and check that it reads them as New York time.

setTestBotEnv();
setNdxTestEnv();
beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  __resetSweepState();
});

const utc = (iso: string) => Date.parse(`${iso}Z`);

describe("the signal window (9:35am - 3:55pm New York)", () => {
  const cfg = () => hoursConfigFor(undefined);

  it("opens and closes at the same New York times in winter and in summer, though the UTC hour differs", () => {
    // Wed 14 Jan 2026 (EST): 9:35 = 14:35Z, 3:55 = 20:55Z
    expect(isWithinTradingHours(utc("2026-01-14T14:34:00"), cfg())).toBe(false);
    expect(isWithinTradingHours(utc("2026-01-14T14:35:00"), cfg())).toBe(true);
    expect(isWithinTradingHours(utc("2026-01-14T20:55:00"), cfg())).toBe(true);
    expect(isWithinTradingHours(utc("2026-01-14T20:56:00"), cfg())).toBe(false);
    // Wed 15 Jul 2026 (EDT): 9:35 = 13:35Z, 3:55 = 19:55Z
    expect(isWithinTradingHours(utc("2026-07-15T13:34:00"), cfg())).toBe(false);
    expect(isWithinTradingHours(utc("2026-07-15T13:35:00"), cfg())).toBe(true);
    expect(isWithinTradingHours(utc("2026-07-15T19:55:00"), cfg())).toBe(true);
    expect(isWithinTradingHours(utc("2026-07-15T19:56:00"), cfg())).toBe(false);
  });

  it("follows the clock change: the Monday after the spring and the autumn change", () => {
    // Mon 9 Mar 2026 is the first day of EDT; Mon 2 Nov 2026 the first of EST.
    expect(isWithinTradingHours(utc("2026-03-09T13:35:00"), cfg())).toBe(true);
    expect(isWithinTradingHours(utc("2026-03-09T14:35:00"), cfg())).toBe(true); // still inside the window (10:35 EDT)
    expect(isWithinTradingHours(utc("2026-03-09T13:34:00"), cfg())).toBe(false);
    expect(isWithinTradingHours(utc("2026-11-02T14:35:00"), cfg())).toBe(true);
    expect(isWithinTradingHours(utc("2026-11-02T14:34:00"), cfg())).toBe(false);
  });

  it("is closed at weekends and on market holidays, and ends 5 minutes before a 1:00pm early close", () => {
    expect(isWithinTradingHours(utc("2026-07-18T15:00:00"), cfg())).toBe(false); // a Saturday
    expect(nyseCalendarDay(utc("2026-12-25T15:00:00")).status).toBe("closed");
    expect(isWithinTradingHours(utc("2026-12-25T15:00:00"), cfg())).toBe(false); // Christmas Day
    expect(nyseCalendarDay(utc("2026-11-27T15:00:00")).status).toBe("early-close"); // the day after Thanksgiving
    expect(isWithinTradingHours(utc("2026-11-27T17:55:00"), cfg())).toBe(true); // 12:55 EST
    expect(isWithinTradingHours(utc("2026-11-27T17:56:00"), cfg())).toBe(false); // 12:56 EST
  });
});

describe("the trading date is New York's, not UTC's", () => {
  it("stays the same date after UTC midnight in the evening (7pm EST / 8pm EDT is when UTC rolls over)", () => {
    expect(easternDateKey(utc("2026-01-14T23:59:00"))).toBe("2026-01-14"); // 6:59pm EST
    expect(easternDateKey(utc("2026-01-15T00:30:00"))).toBe("2026-01-14"); // 7:30pm EST, already the 15th in UTC
    expect(easternDateKey(utc("2026-01-15T05:00:00"))).toBe("2026-01-15"); // midnight EST
    expect(easternDateKey(utc("2026-07-15T00:30:00"))).toBe("2026-07-14"); // 8:30pm EDT
    expect(easternDateKey(utc("2026-07-15T04:00:00"))).toBe("2026-07-15"); // midnight EDT
  });
});

describe("the end-of-day sweep time (4:05pm New York)", () => {
  beforeEach(() => {
    delete process.env.BOT_NDX_EMA_BIAS_EOD_SWEEP_TIME; // the real default, not the test setup's 16:15
  });

  it("is due at 21:05Z in winter and 20:05Z in summer, never earlier", async () => {
    expect(await runDueSweeps(utc("2026-01-14T21:04:00"))).toEqual([]);
    expect(await runDueSweeps(utc("2026-01-14T21:05:00"))).toContain(NDX_BOT_ID);
    __resetSweepState();
    expect(await runDueSweeps(utc("2026-07-15T20:04:00"))).toEqual([]);
    expect(await runDueSweeps(utc("2026-07-15T20:05:00"))).toContain(NDX_BOT_ID);
  });

  it("runs once per New York day, and again the next New York day", async () => {
    expect(await runDueSweeps(utc("2026-01-14T21:05:00"))).toContain(NDX_BOT_ID);
    expect(await runDueSweeps(utc("2026-01-14T22:00:00"))).toEqual([]); // same day
    expect(await runDueSweeps(utc("2026-01-15T21:05:00"))).toContain(NDX_BOT_ID); // next day
  });
});
