import { describe, expect, it } from "vitest";
import type { BotStaticConfig } from "@/lib/automation/types";
import { builtInFlow } from "./builtin";
import { ENTRY_CRITERIA, POSITION_CRITERIA, critKey, enabledCriteria } from "./criteria";
import { checkFlow, describeStep, previewTrace, walk } from "./model";

const cfg: BotStaticConfig = {
  id: "spx_ema_bias",
  name: "SPX EMA 9/20 Bias",
  accountId: "paper-1",
  underlying: "SPX",
  quantity: 3,
  widthPoints: 5,
  strikeIncrement: 5,
  putShortOffset: -20,
  callShortOffset: 20,
  allocationLimit: 20000,
  openingCreditEstimate: 2.2,
};

describe("built-in flow", () => {
  it("draws the engine's bullish logic: hours -> close the calls if held -> open puts unless held", () => {
    const lines = previewTrace(builtInFlow("bullish", cfg)).map((l) => l.text);
    expect(lines[0]).toBe("Decision: Current market time is between 9:35am and 3:55pm");
    expect(lines).toContain("Decision: Bot has exactly or more than 1 position with Short call spread type and any status");
    expect(lines).toContain("Close Position: Close Position (SPX, Short Call Spread)");
    // The open appears on both paths (opposite held-and-closed, and opposite not held).
    expect(lines.filter((l) => l === "Open Position: Open SPX Short Put Spread")).toHaveLength(2);
  });

  it("mirrors it for bearish", () => {
    const lines = previewTrace(builtInFlow("bearish", cfg)).map((l) => l.text);
    expect(lines).toContain("Close Position: Close Position (SPX, Short Put Spread)");
    expect(lines.filter((l) => l === "Open Position: Open SPX Short Call Spread")).toHaveLength(2);
  });

  it("builds the open step from the bot's real inputs", () => {
    const opens: string[] = [];
    walk(builtInFlow("bullish", cfg), (s) => {
      if (s.kind === "open_position") opens.push(JSON.stringify(s.config));
    });
    const cfgOpen = JSON.parse(opens[0]);
    expect(cfgOpen).toMatchObject({ type: "short_put_spread", short_off: "20.00", short_dir: "below", long_off: "5.00", long_dir: "below", size: "3", price: "Limit credit $2.20" });
    expect(check(cfg).opportunities[0].summary).toBe("SPX, exactly 0d, $20.00 below underlying price, $5.00 below short put leg");
  });

  it("every step has a description, and each open is guarded by the market-time check", () => {
    walk(builtInFlow("bullish", cfg), (s) => expect(describeStep(s).length).toBeGreaterThan(3));
    expect(check(cfg).warnings.join(" ")).not.toMatch(/outside trading hours/);
  });

  it("copes with a bot whose inputs aren't set", () => {
    expect(() => builtInFlow("bullish", null)).not.toThrow();
  });
});

const check = (c: BotStaticConfig) => checkFlow(builtInFlow("bullish", c));

describe("criteria", () => {
  it("has the guide's seven entry and sixteen position filters, with unique ids", () => {
    expect(ENTRY_CRITERIA).toHaveLength(7);
    expect(POSITION_CRITERIA).toHaveLength(16);
    const ids = [...ENTRY_CRITERIA, ...POSITION_CRITERIA].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("starts with every filter off, and counts the ones switched on", () => {
    expect(enabledCriteria({}, ENTRY_CRITERIA)).toEqual([]);
    expect(enabledCriteria({ [critKey("capital")]: "1", [critKey("vix")]: "0" }, ENTRY_CRITERIA).map((c) => c.id)).toEqual(["capital"]);
  });
});
