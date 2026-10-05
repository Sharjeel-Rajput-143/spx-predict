import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BotSummary } from "@/lib/automation/summary";
import type { BotTemplate } from "@/lib/automation/types";
import { NewBotPanel, type NewBotView } from "./NewBotPanel";

const noop = () => undefined;

const bot = (over: Partial<BotSummary> & { id: string; name: string }): BotSummary => ({
  mode: "paper",
  builtIn: false,
  enabled: false,
  archived: false,
  needsAttention: false,
  needsAttentionReason: null,
  configError: null,
  group: null,
  tags: [],
  accountId: "paper-1",
  closedPositions: 0,
  activePositionCount: 0,
  totalPositionLimit: 1,
  newPositionsToday: 0,
  dailyNewPositionLimit: 10,
  errorCountToday: 0,
  errorFailsafeThreshold: 10,
  atRisk: 0,
  allocation: 20000,
  closedPL: null,
  closedPct: null,
  change: null,
  changePct: null,
  ...over,
});

const bots = [bot({ id: "a", name: "SPX Bullish" }), bot({ id: "b", name: "SPX Live", accountId: "U12341854" }), bot({ id: "c", name: "Old one", archived: true })];
const template: BotTemplate = {
  id: "t1",
  name: "Weekly 5-wide",
  createdAt: 0,
  config: { name: "x", accountId: "paper-1", underlying: "SPX", quantity: 3, widthPoints: 5, strikeIncrement: 5, putShortOffset: -20, callShortOffset: 20, allocationLimit: 20000, openingCreditEstimate: 2.2 },
};

const render = (start?: NewBotView | NewBotView[], templates: BotTemplate[] = []) =>
  renderToStaticMarkup(<NewBotPanel bots={bots} templates={templates} accounts={["paper-1", "U12341854"]} start={start} onClose={noop} onCreated={noop} />);

describe("New bot slide-over", () => {
  it("opens on a flat menu - Empty bot, Clone a bot, and a Templates section with My templates - not a wizard", () => {
    const out = render();
    for (const t of ["New bot", "Empty bot", "Start with a blank canvas", "Clone a bot", "Create a duplicate copy of an existing bot", "Templates", "My templates"]) expect(out, t).toContain(t);
    expect(out).not.toContain('aria-label="Back"'); // the root has nowhere to go back to
    expect(out).toContain('role="dialog"');
  });

  it("Clone a bot is a flat list of existing bots (archived ones left out) behind a back arrow", () => {
    const out = render({ name: "clone" });
    expect(out).toContain("Clone a bot");
    expect(out).toContain("SPX Bullish");
    expect(out).toContain("SPX Live");
    expect(out).not.toContain("Old one");
  });

  it("My templates shows the sad-face empty state when nothing is saved", () => {
    const out = render({ name: "templates" });
    expect(out).toContain("My templates");
    expect(out).toContain("You haven&#x27;t saved a template yet.");
  });

  it("My templates lists saved templates", () => {
    const out = render({ name: "templates" }, [template]);
    expect(out).toContain("Weekly 5-wide");
    expect(out).toContain("3x · 5pt wide");
    expect(out).not.toContain("saved a template yet");
  });

  it("the Empty bot form is three fields and one Create bot button: Name, Account defaulting to Paper Trading, Allocation 1000 with its caption", () => {
    const out = render({ name: "form", mode: "empty", initial: { name: "", accountId: "paper-1", allocation: "1000" } });
    expect(out).toContain('aria-label="Name"');
    expect(out).toContain("Paper Trading");
    expect(out).toMatch(/aria-label="Allocation"[^>]*>|value="1000"/);
    expect(out).toContain('value="1000"');
    expect(out).toContain("Max total capital to open positions");
    expect(out).toContain(">Create bot<");
    expect(out.match(/<input/g)).toHaveLength(2); // name + allocation; the account is a picker
    // The honest part: trading inputs still have to be entered, with no defaults.
    expect(out).toContain("have no defaults");
  });

  it("masks a brokerage account number in the account picker", () => {
    const out = render({ name: "form", mode: "clone", sourceId: "b", initial: { name: "SPX Live copy", accountId: "U12341854", allocation: "20000" } });
    expect(out).toContain("U ****1854");
    expect(out).not.toContain("U12341854");
    expect(out).toContain('value="SPX Live copy"');
    expect(out).toContain("Copies the inputs");
  });

  it("a template form is prefilled and says it starts from the template", () => {
    const out = render({ name: "form", mode: "template", templateId: "t1", initial: { name: "", accountId: "paper-1", allocation: "20000" } }, [template]);
    expect(out).toContain('value="20000"');
    expect(out).toContain("Starts from the template");
  });

  it("a sub-view with something behind it shows the back arrow; the root and a bare deep link don't", () => {
    const form: NewBotView = { name: "form", mode: "empty", initial: { name: "", accountId: "paper-1", allocation: "1000" } };
    expect(render([{ name: "menu" }, { name: "templates" }], [template])).toContain('aria-label="Back"');
    expect(render([{ name: "menu" }, form])).toContain('aria-label="Back"');
    expect(render(form)).not.toContain('aria-label="Back"');
    expect(render()).not.toContain('aria-label="Back"');
  });
});
