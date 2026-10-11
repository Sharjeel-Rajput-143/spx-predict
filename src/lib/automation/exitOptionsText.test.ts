import { describe, expect, it } from "vitest";
import { botExitTriggers, exitOptionRows, hasExitOptions } from "./exitOptionsText";

describe("exit options as shown to a person", () => {
  it("nothing set reads None everywhere, and is not 'on'", () => {
    expect(hasExitOptions(undefined)).toBe(false);
    expect(hasExitOptions({})).toBe(false);
    expect(exitOptionRows(undefined).map((r) => r[1])).toEqual(["None", "None", "None", "None", "None", "None"]);
  });

  it("each option reads back as it was set", () => {
    const rows = Object.fromEntries(exitOptionRows({ profitPercent: 50, profitDollars: 1250, stopPercent: 100, stopDollars: 400.5, touchPoints: 25, expirationMinutes: 30 }));
    expect(rows).toEqual({
      "Profit %": "50% of the credit",
      "Profit $": "$1,250",
      "Stop loss %": "100% of the credit",
      "Stop loss $": "$400.5",
      Touch: "within 25 points of the short strike",
      "Close before expiry": "30 minutes before the market closes, at market",
    });
    expect(hasExitOptions({ stopPercent: 100 })).toBe(true);
  });

  it("a bot is 'on' for exactly the triggers whose Open Position step has exit options", () => {
    expect(botExitTriggers(undefined)).toEqual([]);
    expect(botExitTriggers({ bullish: { exit: {} }, bearish: null })).toEqual([]);
    expect(botExitTriggers({ bullish: { exit: { stopPercent: 100 } } })).toEqual(["bullish"]);
    expect(botExitTriggers({ bullish: { exit: { profitPercent: 50 } }, bearish: { exit: { touchPoints: 10 } } })).toEqual(["bullish", "bearish"]);
  });
});
