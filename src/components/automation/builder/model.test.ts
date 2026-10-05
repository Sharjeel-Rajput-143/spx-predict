import { describe, expect, it } from "vitest";
import {
  CONDITION_CATALOG,
  cloneStep,
  insertBefore,
  val,
  CONDITION_CATEGORIES,
  STEP_CATALOG,
  appendStep,
  checkFlow,
  conditionMatches,
  conditionTemplate,
  describeCondition,
  describeStep,
  findStep,
  isConditionComplete,
  newCondition,
  newStep,
  normalize,
  previewTrace,
  removeStep,
  updateStep,
} from "./model";

describe("catalog", () => {
  it("has the guide's actions and loops, each with a description", () => {
    const names = (g: string) => STEP_CATALOG.filter((s) => s.group === g).map((s) => s.name);
    expect(names("Actions")).toEqual(["Decision", "Conditional", "Open Position", "Open Trade Idea", "Close Position", "Update Exit Options", "Notification", "Tags"]);
    expect(names("Loops")).toEqual(["Positions", "Symbols", "Bot Symbols"]);
    expect(STEP_CATALOG.every((s) => s.description.length > 10)).toBe(true);
  });

  it("covers the four condition categories with fill-in-the-blank sentences", () => {
    expect(CONDITION_CATEGORIES).toEqual(["Stocks", "Indicators", "Positions", "Bot"]);
    for (const cat of CONDITION_CATEGORIES) expect(CONDITION_CATALOG.some((t) => t.category === cat)).toBe(true);
    // Every template has at least one blank to fill (a select or an input).
    expect(CONDITION_CATALOG.every((t) => t.tokens.some((k) => k.t !== "text"))).toBe(true);
  });
});

describe("conditions", () => {
  it("renders a sentence, with ‹placeholders› for blanks not yet filled", () => {
    const c = newCondition("bot_pl");
    expect(describeCondition(c)).toBe("Bot open P/L is greater than ‹value›");
    expect(isConditionComplete(c)).toBe(false);
    expect(describeCondition({ ...c, values: { ...c.values, value: "500" } })).toBe("Bot open P/L is greater than 500");
    expect(isConditionComplete({ ...c, values: { ...c.values, value: "500" } })).toBe(true);
  });

  it("presets the market-time condition with the engine's window", () => {
    expect(describeCondition(newCondition("bot_time"))).toBe("Current market time is between 9:35am and 3:55pm");
    expect(isConditionComplete(newCondition("bot_time"))).toBe(true);
  });

  it("matches a search against the sentence and the category", () => {
    expect(conditionMatches(conditionTemplate("ind_rsi"), "rsi")).toBe(true);
    expect(conditionMatches(conditionTemplate("ind_rsi"), "indicators")).toBe(true);
    expect(conditionMatches(conditionTemplate("ind_rsi"), "dte")).toBe(false);
    expect(conditionMatches(conditionTemplate("ind_rsi"), "  ")).toBe(true);
  });
});

describe("flow tree", () => {
  it("builds nested flows and updates them by id", () => {
    const decision = newStep("decision", [newCondition("bot_time")]);
    let steps = appendStep([], null, "root", decision);
    const open = newStep("open_position");
    const close = newStep("close_position");
    steps = appendStep(steps, decision.id, "yes", open);
    steps = appendStep(steps, decision.id, "no", close);

    const d = findStep(steps, decision.id)!;
    expect(d.yes?.map((s) => s.kind)).toEqual(["open_position"]);
    expect(d.no?.map((s) => s.kind)).toEqual(["close_position"]);

    steps = updateStep(steps, open.id, (s) => ({ ...s, config: { ...s.config, type: "short_call_spread" } }));
    expect(describeStep(findStep(steps, open.id)!)).toBe("Open SPX Short Call Spread");

    steps = removeStep(steps, close.id);
    expect(findStep(steps, close.id)).toBeUndefined();
    expect(findStep(steps, decision.id)?.no).toEqual([]);
  });

  it("appends into the right nested lane even when the parent is deep", () => {
    const outer = newStep("decision", [newCondition("bot_time")]);
    const inner = newStep("conditional", [newCondition("pos_type")]);
    let steps = appendStep([], null, "root", outer);
    steps = appendStep(steps, outer.id, "yes", inner);
    steps = appendStep(steps, inner.id, "yes", newStep("notification"));
    expect(findStep(steps, inner.id)?.yes?.map((s) => s.kind)).toEqual(["notification"]);
  });

  it("normalize drops lanes the helpers left undefined", () => {
    const steps = appendStep([], null, "root", newStep("open_position"));
    const touched = updateStep(steps, steps[0].id, (s) => s);
    expect(Object.keys(normalize(touched)[0])).not.toContain("yes");
  });
});

describe("checkFlow", () => {
  it("an empty flow has no warnings - just a nudge to add a first step", () => {
    const check = checkFlow([]);
    expect(check.warnings).toEqual([]);
    expect(check.opportunities).toEqual([]);
    expect(check.suggestions[0]).toMatch(/first step/);
  });

  it("warns about an unguarded open and an unfinished condition, and suggests adding a close", () => {
    const check = checkFlow([newStep("open_position"), newStep("decision", [newCondition("bot_pl")])]);
    expect(check.warnings.join(" ")).toMatch(/outside trading hours/);
    expect(check.warnings.join(" ")).toMatch(/missing a value/);
    expect(check.suggestions.join(" ")).toMatch(/Close Position/);
  });

  it("a decision with no conditions is a warning", () => {
    expect(checkFlow([newStep("decision")]).warnings.join(" ")).toMatch(/no condition/);
  });

  it("describes each open step as an opportunity in plain English", () => {
    const guard = newStep("decision", [newCondition("bot_time")]);
    const open = newStep("open_position");
    open.config = { ...open.config, type: "short_call_spread", short_dir: "above", long_dir: "above" };
    const steps = appendStep([guard], guard.id, "yes", open);
    const [opp] = checkFlow(steps).opportunities;
    expect(opp).toMatchObject({ stepId: open.id, title: "Short Call Spread" });
    expect(opp.summary).toBe("SPX, exactly 0d, $0.01 above underlying price, $5.00 above short call leg");
  });

  it("is quiet for a guarded, complete flow with a close and a notification", () => {
    const guard = newStep("decision", [newCondition("bot_time")]);
    let steps = appendStep([], null, "root", guard);
    steps = appendStep(steps, guard.id, "yes", newStep("open_position"));
    steps = appendStep(steps, guard.id, "yes", newStep("close_position"));
    const note = newStep("notification");
    note.config.message = "done";
    steps = appendStep(steps, null, "root", note);
    const check = checkFlow(steps);
    expect(check.warnings).toEqual([]);
    expect(check.suggestions).toEqual([]);
  });

  it("flags unfinished steps", () => {
    const warnings = checkFlow([newStep("notification"), newStep("tags"), newStep("loop_symbols"), newStep("update_exit")]).warnings.join(" ");
    expect(warnings).toMatch(/no message/);
    expect(warnings).toMatch(/no tag name/);
    expect(warnings).toMatch(/no symbols/);
    expect(warnings).toMatch(/neither a profit target nor a stop loss/);
  });
});

describe("previewTrace", () => {
  it("lists both paths of a decision in order and says (nothing) for an empty path", () => {
    const d = newStep("decision", [newCondition("bot_time")]);
    let steps = appendStep([], null, "root", d);
    steps = appendStep(steps, d.id, "yes", newStep("open_position"));
    const lines = previewTrace(steps);
    expect(lines.map((l) => `${"  ".repeat(l.depth)}${l.label} ${l.text}`.trim())).toEqual([
      "Decision: Current market time is between 9:35am and 3:55pm",
      "YES Open Position: Open SPX Short Put Spread",
      "NO (nothing)",
    ]);
  });
});

describe("multiple conditions, captions, bound inputs", () => {
  it("joins stacked conditions with AND", () => {
    const d = newStep("decision", [newCondition("bot_time"), { ...newCondition("bot_pl"), values: { metric: "open P/L", cmp: "less than", value: "0" } }]);
    expect(describeStep(d)).toBe("Current market time is between 9:35am and 3:55pm and Bot open P/L is less than 0");
  });

  it("a caption replaces the automatic description", () => {
    const o = { ...newStep("open_position"), caption: "  Enter the bias trade " };
    expect(describeStep(o)).toBe("Enter the bias trade");
  });

  it("a bound field reads its input's value, and falls back to its own when the input is gone", () => {
    const o = newStep("open_position");
    o.config["in:size"] = "inp1";
    expect(val(o, "size", [{ id: "inp1", name: "Size", value: "9" }])).toBe("9");
    expect(val(o, "size", [])).toBe("3");
  });

  it("closes read as the guide's one-liner", () => {
    const c = newStep("close_position");
    expect(describeStep(c)).toBe("Close Position (SPX, Short Put Spread)");
  });
});

describe("insertBefore and cloneStep", () => {
  it("inserts before a nested step, in its own lane", () => {
    const d = newStep("decision", [newCondition("bot_time")]);
    const a = newStep("close_position");
    let steps = appendStep([], null, "root", d);
    steps = appendStep(steps, d.id, "yes", a);
    const b = newStep("notification");
    steps = insertBefore(steps, a.id, b);
    expect(findStep(steps, d.id)?.yes?.map((s) => s.kind)).toEqual(["notification", "close_position"]);
  });

  it("clones deeply with fresh ids and no shared references", () => {
    const d = newStep("decision", [newCondition("bot_time")]);
    const steps = appendStep([d], d.id, "no", newStep("open_position"));
    const copy = cloneStep(steps[0]);
    expect(copy.id).not.toBe(steps[0].id);
    expect(copy.no?.[0].id).not.toBe(steps[0].no?.[0].id);
    copy.conditions![0].values.from = "10:00am";
    expect(steps[0].conditions![0].values.from).toBe("9:35am");
  });
});
