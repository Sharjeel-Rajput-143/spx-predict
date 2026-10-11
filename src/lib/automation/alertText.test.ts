import { describe, expect, it } from "vitest";
import { alertSays, checkAlertText } from "./webhooks";

describe("which direction an alert's text says", () => {
  it.each([
    ["bullish", "bullish"],
    ["NDX Bullish signal", "bullish"],
    ["BEARISH", "bearish"],
    ["NDX_bullish", "bullish"], // an underscore is how many alerts are written
    ["bearish_signal", "bearish"],
    ["bullish5m", "bullish"],
    ['{"ticker":"NDX","action":"bearish","interval":"5"}', "bearish"],
    ["NDX-bullish-cross", "bullish"],
    ["bullish.", "bullish"],
  ])("%s -> %s", (text, expected) => {
    expect(alertSays(text)).toBe(expected);
  });

  it("says both when both words are there, whatever separates them", () => {
    expect(alertSays("bearish -> bullish")).toBe("both");
    expect(alertSays("bullish_bearish")).toBe("both");
  });

  it("does not take a word that merely contains one: letters on either side mean a different word", () => {
    expect(alertSays("BullishNDX")).toBeNull();
    expect(alertSays("unbullish")).toBeNull();
    expect(alertSays("bullishness")).toBeNull();
    expect(alertSays("NDX signal")).toBeNull();
    expect(alertSays("")).toBeNull();
  });

  it("the safety check still refuses the wrong direction in the new spellings", () => {
    const bullHook = { name: "BullishNDX", direction: "bullish" as const, requireDirectionText: true };
    expect(checkAlertText(bullHook, "NDX_bearish")).toMatchObject({ ok: false, code: "alert_text_mismatch" });
    expect(checkAlertText(bullHook, "NDX_bullish")).toEqual({ ok: true });
    expect(checkAlertText(bullHook, "bearish_bullish")).toMatchObject({ ok: false });
    expect(checkAlertText(bullHook, "NDX signal")).toMatchObject({ ok: false, code: "alert_text_missing" });
  });
});
