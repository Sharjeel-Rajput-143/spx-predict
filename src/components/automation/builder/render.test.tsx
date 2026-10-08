import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SymbolsPanel } from "../bot/SymbolsPanel";
import { AddAutomationDrawer } from "./AddAutomationDrawer";
import { AddStepDrawer } from "./AddStepDrawer";
import { AutomationBuilder } from "./AutomationBuilder";
import { ClosePositionDrawer } from "./ClosePositionDrawer";
import { ConditionPicker } from "./ConditionPicker";
import { DecisionDrawer } from "./DecisionDrawer";
import { OpenPositionDrawer } from "./OpenPositionDrawer";
import { RunTestDrawer } from "./RunTestDrawer";
import { builtInFlow } from "./builtin";
import { appendStep, newCondition, newStep, type AutomationDraft } from "./model";
import { blankDraft } from "./store";

// Server-render smoke tests: no browser, no server, no network. They pin the
// content the guide describes for each panel and catch a panel crashing.
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const noop = () => undefined;

describe("Add Automation slide-over", () => {
  it("has the grouped Automation field with New, the Schedule select, and a Save that starts disabled", () => {
    const out = html(<AddAutomationDrawer botId="b" builtIns={["Bullish signal", "Bearish signal"]} onNew={noop} onAttached={noop} onClose={noop} />);
    expect(out).toContain("Add automation");
    expect(out).toContain('aria-label="Automation"');
    expect(out).toContain(">New<");
    expect(out).toContain('aria-label="Schedule"');
    expect(out).toContain("Select a schedule");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Save<\/button>/);
    expect(out).toContain("Preview");
  });
});

describe("Add Step panel", () => {
  it("lists Actions then Loops, each with a name and a one-line description", () => {
    const out = html(<AddStepDrawer onPick={noop} onClose={noop} />);
    for (const t of ["Actions", "Decision", "Conditional", "Open Position", "Open Trade Idea", "Close Position", "Update Exit Options", "Notification", "Tags", "Loops", "Positions", "Symbols", "Bot Symbols", "Split the flow into a Yes path"]) {
      expect(out, t).toContain(t);
    }
    expect(out.indexOf("Actions")).toBeLessThan(out.indexOf("Loops"));
    expect(out).not.toContain("Paste copied action");
  });

  it("offers to paste a copied step when there is one", () => {
    expect(html(<AddStepDrawer onPick={noop} onPaste={noop} pasteLabel="Close Position (SPX, Short Put Spread)" onClose={noop} />)).toContain("Paste copied action");
  });
});

describe("Condition picker", () => {
  it("has search, the three visible categories (no Indicators), and sentences with inline blanks (Bot open by default)", () => {
    const out = html(<ConditionPicker onPick={noop} onClose={noop} />);
    for (const t of ["Search conditions", "Stocks", "Positions", "Bot", "Current market time is between", "open P/L"]) expect(out, t).toContain(t);
    expect(out).toContain("<select");
    expect(out).toContain("<input");
    for (const hidden of ["Indicators", "RSI", "EMA", "SMA", "Heikin"]) expect(out, hidden).not.toContain(hidden);
    // Bot is expanded, Stocks is collapsed.
    expect(out).toContain("Bot has");
    expect(out).not.toContain("price is");
  });
});

describe("Decision slide-over", () => {
  it("shows the Yes-path heading, each condition as a chip with AND between, a + and Save", () => {
    const out = html(
      <DecisionDrawer title="Decision" heading="Follow the “Yes” path if…" initial={[newCondition("bot_time"), newCondition("bot_has_type")]} onSave={noop} onClose={noop} />,
    );
    expect(out).toContain("Follow the “Yes” path if…");
    expect(out).toContain("Current market time is between 9:35am - 3:55pm");
    expect(out).toContain("Bot has exactly or more than 1 position with Short put spread type and any status");
    expect(out).toContain("AND");
    expect(out).toContain('aria-label="Add condition"');
    expect(out).toContain(">Save<");
  });

  it("can't be saved empty, and a read-only view has no add or save", () => {
    expect(html(<DecisionDrawer title="Decision" heading="h" initial={[]} onSave={noop} onClose={noop} />)).toMatch(/<button[^>]*disabled[^>]*>Save<\/button>/);
    const ro = html(<DecisionDrawer title="Decision" heading="h" initial={[newCondition("bot_time")]} readOnly onSave={noop} onClose={noop} />);
    expect(ro).not.toContain('aria-label="Add condition"');
    expect(ro).not.toContain(">Save<");
  });
});

describe("Open Position slide-over", () => {
  const open = newStep("open_position");
  const render = (readOnly = false) =>
    html(<OpenPositionDrawer step={{ ...open, config: { ...open.config, type: "short_call_spread", short_dir: "above", long_dir: "above" } }} inputs={[]} readOnly={readOnly} onCreateInput={() => "i"} onUpdateInput={noop} onSave={noop} onClose={noop} />);

  it("has Position Details with each field, a chevron and a link-to-input control, and ends in Save", () => {
    const out = render();
    expect(out).toContain("Open Short Call Spread");
    for (const t of ["Position details", "Symbol", "Expiration", "exactly 0 days", "Short call", "$0.01 above underlying price", "Long call", "$5.00 above short call leg", "Position size", "3 contracts", "Price", "100% of bid/ask", "Exit options", "Tags"]) {
      expect(out, t).toContain(t);
    }
    expect(out).toContain("Convert Expiration to a bot input");
    expect(out).toContain(">Save<");
  });

  it("keeps Entry criteria and Position criteria collapsed, both with 0 on", () => {
    const out = render();
    expect(out).toContain("Entry criteria");
    expect(out).toContain("Position criteria");
    expect(out.match(/0 on/g)).toHaveLength(2);
    expect(out).not.toContain("Bot has enough available capital");
    expect(out).not.toContain("Probability of max loss less than");
  });

  it("a read-only view disables every field and offers only Close", () => {
    const out = render(true);
    expect(out).toContain("<fieldset");
    expect(out).toMatch(/<fieldset[^>]*disabled/);
    expect(out).not.toContain(">Save<");
  });
});

describe("Close Position slide-over", () => {
  it("is the short flat form: position chip, price, quantity, memo, tags, one option", () => {
    const out = html(<ClosePositionDrawer step={newStep("close_position")} onSave={noop} onClose={noop} />);
    for (const t of ["Position (SPX, Short Put Spread)", "Price", "100% of bid/ask", "Quantity", "100% of position", "Memo", "Added immediately after the trade is filled", "Tags", "Options", "Discard expiring OTM long leg(s) with no bid price", ">Save<"]) {
      expect(out, t).toContain(t);
    }
  });
});

describe("Run test panel", () => {
  it("has the bot select, the safety checkbox checked by default with its explanation, and Start test", () => {
    const out = html(<RunTestDrawer steps={[]} currentBotId="b" currentBotName="SPX EMA 9/20 Bias" onClose={noop} />);
    expect(out).toContain("Bot to run test");
    expect(out).toContain("SPX EMA 9/20 Bias");
    expect(out).toContain("Prevent automation from modifying bot");
    expect(out).toMatch(/type="checkbox"[^>]*checked/);
    expect(out).toContain("Your bot (positions, tags, etc) will not be modified during this test.");
    expect(out).toContain("Start test");
  });
});

describe("Automation builder (full page)", () => {
  const render = (draft: AutomationDraft, extra: Partial<React.ComponentProps<typeof AutomationBuilder>> = {}) =>
    html(<AutomationBuilder draft={draft} botId="b" botName="SPX EMA 9/20 Bias" onSaved={noop} onClose={noop} {...extra} />);

  it("a new automation starts empty: title, folder, Run test / Save / Close, a 3-way rail, START AUTOMATION and one +", () => {
    const out = render(blankDraft());
    for (const t of ['value="New Automation"', "My Automations", "Run test", ">Save<", ">Close<", "Inputs", "Opportunities", "Warnings", "start automation", 'aria-label="Add step"']) {
      expect(out.toLowerCase(), t).toContain(t.toLowerCase());
    }
    expect(out.match(/aria-label="Add step"/g)).toHaveLength(1);
    expect(out).toContain("Preview");
    // A brand-new flow reads Opportunities 0 and Warnings 0 (Inputs has no count, as in Option Alpha).
    expect(out.match(/<span class="[^"]*">0<\/span>/g)).toHaveLength(2);
  });

  it("draws a flow as pill nodes with YES/NO badges, node menus and live counts", () => {
    const guard = newStep("decision", [newCondition("bot_time")]);
    let steps = appendStep([], null, "root", guard);
    steps = appendStep(steps, guard.id, "yes", newStep("open_position"));
    const out = render({ ...blankDraft(), steps });
    expect(out).toContain("Current market time is between 9:35am - 3:55pm");
    expect(out).toContain("Open SPX Short Put Spread");
    expect(out).toContain(">YES<");
    expect(out).toContain(">NO<");
    expect(out).toContain("Decision actions");
    expect(out).toContain("Collapse branches");
    expect(out).toMatch(/Opportunities<\/span><span[^>]*>1</); // one open step
  });

  it("opens a built-in trigger as a read-only reference with no add buttons, no Save, and the explanation", () => {
    const draft: AutomationDraft = { ...blankDraft(), id: "builtin-bullish", name: "Bullish signal", folder: "Built-in", steps: builtInFlow("bullish", null) };
    const out = render(draft, { readOnly: true, note: "Reference view of what the engine does." });
    expect(out).not.toContain("Built-in");
    expect(out).toContain("Reference view of what the engine does.");
    expect(out).not.toContain('aria-label="Add step"');
    expect(out).not.toContain(">Save<");
    expect(out).toContain("Close Position (SPX, Short Call Spread)");
  });
});

describe("Bot symbols panel", () => {
  it("has every control from the guide: watchlist, sort, two filters, limit, excluded symbols with Recents", () => {
    const out = html(<SymbolsPanel botId="b" onSaved={noop} onClose={noop} />);
    for (const t of [
      "Bot symbols",
      "Your bot will sort and filter the selected watchlist before every scan to produce a list of symbols.",
      "Watchlist",
      "Select a watchlist...",
      "Sort",
      "Filters",
      "Bot has",
      "positions with symbol",
      "Earnings or ex-div in the next",
      "Limit",
      "10 symbols",
      "Excluded symbols",
      "Enter up to 50 symbols separated by space",
      "Recents",
      "(optional)",
      ">Save<",
    ]) {
      expect(out, t).toContain(t);
    }
  });

  it("says plainly that it's a saved preview the engine doesn't read yet", () => {
    expect(html(<SymbolsPanel botId="b" onSaved={noop} onClose={noop} />)).toContain("doesn&#x27;t scan");
  });
});
