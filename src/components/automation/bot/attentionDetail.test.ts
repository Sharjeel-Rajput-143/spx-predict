import { describe, expect, it } from "vitest";
import { attentionDetail } from "./model";

describe("the 'Needs attention' banner wording", () => {
  it("gives the reason once, with one full stop, then says how to clear the flag", () => {
    expect(attentionDetail('BearishNDX: The alert says "bullish", but its URL is the Bearish webhook. Nothing was done. Check which webhook URL is on that TradingView alert.')).toBe(
      ' — BearishNDX: The alert says "bullish", but its URL is the Bearish webhook. Nothing was done. Check which webhook URL is on that TradingView alert. Switch the bot off and on again to clear this flag.',
    );
  });
  it("never ends the reason with two full stops, however many it already ends with, or trailing spaces", () => {
    for (const reason of ["Close failed.", "Close failed..", "Close failed. ", "Close failed"]) {
      const out = attentionDetail(reason);
      expect(out).not.toContain("..");
      expect(out).toBe(" — Close failed. Switch the bot off and on again to clear this flag.");
    }
  });
  it("with no reason it still reads as a sentence", () => {
    for (const none of [null, undefined, "", "   "]) expect(attentionDetail(none)).toBe(". Switch the bot off and on again to clear this flag.");
  });
  it("tells the person to switch off and on, since the bot is already on when it is flagged by a refused alert", () => {
    expect(attentionDetail("x")).toContain("off and on");
    expect(attentionDetail("x")).not.toContain("Turning the bot back on");
  });
});
