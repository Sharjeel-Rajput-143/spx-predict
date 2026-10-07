/**
 * The automation builder's data model and the pure logic around it (catalog,
 * sentence rendering, flow checks, preview trace). Nothing here talks to the
 * engine: a saved flow is a design that lives in this browser, and the UI says
 * so wherever it can be mistaken for something that runs.
 */

export type StepKind =
  | "decision"
  | "conditional"
  | "open_position"
  | "open_trade_idea"
  | "close_position"
  | "update_exit"
  | "notification"
  | "tags"
  | "loop_positions"
  | "loop_symbols"
  | "loop_bot_symbols";

export interface Condition {
  templateId: string;
  values: Record<string, string>;
}

/** A value shared across an automation's steps (a "bot input"). */
export interface BotInput {
  id: string;
  name: string;
  value: string;
}

export interface Step {
  id: string;
  kind: StepKind;
  /** Plain string settings. `in:<key>` binds <key> to a BotInput by id. */
  config: Record<string, string>;
  /** decision / conditional only. All must hold (AND). */
  conditions?: Condition[];
  /** decision: the Yes path; conditional and loops: the steps inside. */
  yes?: Step[];
  /** decision only: the No path. */
  no?: Step[];
  /** Replaces the auto-generated one-liner on the canvas. */
  caption?: string;
  notes?: string;
  /** Canvas only: hide this step's branches. */
  collapsed?: boolean;
}

export interface AutomationDraft {
  id: string;
  name: string;
  folder: string;
  steps: Step[];
  inputs?: BotInput[];
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Step catalog (the "Add Step" panel)
// ---------------------------------------------------------------------------

export interface StepInfo {
  kind: StepKind;
  name: string;
  description: string;
  group: "Actions" | "Loops";
  /** Tailwind classes for the little colored icon tile. */
  tile: string;
  glyph: string;
}

export const STEP_CATALOG: StepInfo[] = [
  { kind: "decision", name: "Decision", description: "Split the flow into a Yes path and a No path using a condition.", group: "Actions", tile: "rounded-full bg-amber-500/20 text-amber-500", glyph: "?" },
  { kind: "conditional", name: "Conditional", description: "Run the steps inside only if a condition is true, then carry on.", group: "Actions", tile: "bg-amber-500/15 text-amber-500", glyph: "↳" },
  { kind: "open_position", name: "Open Position", description: "Open a new position on this bot.", group: "Actions", tile: "bg-up-soft text-up", glyph: "+" },
  { kind: "open_trade_idea", name: "Open Trade Idea", description: "Propose a trade for you to review instead of placing it.", group: "Actions", tile: "bg-up-soft text-up", glyph: "✦" },
  { kind: "close_position", name: "Close Position", description: "Close one or more of this bot's positions.", group: "Actions", tile: "bg-down-soft text-down", glyph: "−" },
  { kind: "update_exit", name: "Update Exit Options", description: "Set a profit target and stop loss on positions.", group: "Actions", tile: "bg-accent/15 text-accent", glyph: "⚑" },
  { kind: "notification", name: "Notification", description: "Send yourself a message when this step runs.", group: "Actions", tile: "bg-accent/15 text-accent", glyph: "✉" },
  { kind: "tags", name: "Tags", description: "Add or remove a tag on this bot.", group: "Actions", tile: "bg-surface-2 text-muted", glyph: "#" },
  { kind: "loop_positions", name: "Positions", description: "Repeat the steps inside for each of the bot's positions.", group: "Loops", tile: "bg-accent/15 text-accent", glyph: "↻" },
  { kind: "loop_symbols", name: "Symbols", description: "Repeat the steps inside for each symbol in a list.", group: "Loops", tile: "bg-accent/15 text-accent", glyph: "↻" },
  { kind: "loop_bot_symbols", name: "Bot Symbols", description: "Repeat the steps inside for each of the bot's own symbols.", group: "Loops", tile: "bg-accent/15 text-accent", glyph: "↻" },
];

export const stepInfo = (kind: StepKind): StepInfo => STEP_CATALOG.find((s) => s.kind === kind)!;

export const isBranching = (kind: StepKind) => kind === "decision";
export const hasBody = (kind: StepKind) => kind === "conditional" || kind.startsWith("loop_");
export const needsCondition = (kind: StepKind) => kind === "decision" || kind === "conditional";

export const POSITION_TYPES: Record<string, string> = {
  short_put_spread: "Short Put Spread",
  short_call_spread: "Short Call Spread",
};

/** What a freshly added step starts with. */
export function defaultConfig(kind: StepKind): Record<string, string> {
  switch (kind) {
    case "open_position":
      return { type: "short_put_spread", symbol: "SPX", exp_op: "exactly", exp_days: "0", short_off: "0.01", short_dir: "below", long_off: "5.00", long_dir: "below", size: "3", price: "100% of bid/ask", exit: "None", tags: "" };
    case "open_trade_idea":
      return { symbol: "SPX" };
    case "close_position":
      return { type: "short_put_spread", price: "100% of bid/ask", qty: "100% of position", memo: "", tags: "", discard: "" };
    case "update_exit":
      return { profit: "", stop: "" };
    case "notification":
      return { message: "", channel: "In-app" };
    case "tags":
      return { action: "Add tag", tag: "" };
    case "loop_positions":
      return { over: "Open positions" };
    case "loop_symbols":
      return { symbols: "" };
    default:
      return {};
  }
}

/** The effective value of a setting: the bound input's value if it is bound, else its own. */
export function val(s: Step, key: string, inputs: BotInput[] = []): string {
  const bound = s.config[`in:${key}`];
  return (bound ? inputs.find((i) => i.id === bound)?.value : undefined) ?? s.config[key] ?? "";
}

// ---------------------------------------------------------------------------
// Conditions: fill-in-the-blank sentences
// ---------------------------------------------------------------------------

export type Token =
  | { t: "text"; v: string }
  | { t: "select"; k: string; options: string[] }
  | { t: "input"; k: string; placeholder: string; value?: string };

export type ConditionCategory = "Stocks" | "Indicators" | "Positions" | "Bot";

export interface ConditionTemplate {
  id: string;
  category: ConditionCategory;
  tokens: Token[];
}

const CMP = ["greater than", "less than", "equal to"];
const SYMBOLS = ["SPX", "SPY", "QQQ", "VIX"];

export const CONDITION_CATALOG: ConditionTemplate[] = [
  { id: "stock_price", category: "Stocks", tokens: [{ t: "select", k: "symbol", options: SYMBOLS }, { t: "text", v: " price is " }, { t: "select", k: "cmp", options: ["above", "below"] }, { t: "text", v: " " }, { t: "input", k: "level", placeholder: "level" }] },
  { id: "stock_change", category: "Stocks", tokens: [{ t: "select", k: "symbol", options: SYMBOLS }, { t: "text", v: " is " }, { t: "select", k: "dir", options: ["up", "down"] }, { t: "text", v: " more than " }, { t: "input", k: "pct", placeholder: "%" }, { t: "text", v: "% today" }] },
  { id: "stock_range", category: "Stocks", tokens: [{ t: "select", k: "symbol", options: SYMBOLS }, { t: "text", v: " is trading between " }, { t: "input", k: "low", placeholder: "low" }, { t: "text", v: " and " }, { t: "input", k: "high", placeholder: "high" }] },
  // The Indicators conditions stay in the code (a flow saved with one still has to read back) but are not offered:
  // this platform does not analyse price (see HIDDEN_CONDITION_CATEGORIES).
  { id: "ind_compare", category: "Indicators", tokens: [{ t: "select", k: "a", options: ["EMA(9)", "EMA(20)", "SMA(50)"] }, { t: "text", v: " is " }, { t: "select", k: "rel", options: ["above", "below", "crossing above", "crossing below"] }, { t: "text", v: " " }, { t: "select", k: "b", options: ["EMA(20)", "EMA(9)", "SMA(50)"] }] },
  { id: "ind_rsi", category: "Indicators", tokens: [{ t: "select", k: "ind", options: ["RSI(14)", "RSI(7)"] }, { t: "text", v: " is " }, { t: "select", k: "cmp", options: ["above", "below"] }, { t: "text", v: " " }, { t: "input", k: "value", placeholder: "value" }] },
  { id: "ind_bias", category: "Indicators", tokens: [{ t: "text", v: "Confirmed 5m Heikin Ashi bias is " }, { t: "select", k: "bias", options: ["bullish", "bearish"] }] },
  { id: "pos_type", category: "Positions", tokens: [{ t: "text", v: "Position is a " }, { t: "select", k: "type", options: ["short put spread", "short call spread"] }] },
  { id: "pos_pl", category: "Positions", tokens: [{ t: "text", v: "Position P/L is " }, { t: "select", k: "cmp", options: CMP }, { t: "text", v: " " }, { t: "input", k: "value", placeholder: "value" }, { t: "text", v: "% of risk" }] },
  { id: "pos_dte", category: "Positions", tokens: [{ t: "text", v: "Position days to expiry is " }, { t: "select", k: "cmp", options: CMP }, { t: "text", v: " " }, { t: "input", k: "days", placeholder: "days" }] },
  { id: "bot_time", category: "Bot", tokens: [{ t: "text", v: "Current market time is between " }, { t: "input", k: "from", placeholder: "start", value: "9:35am" }, { t: "text", v: " and " }, { t: "input", k: "to", placeholder: "end", value: "3:55pm" }] },
  { id: "bot_has_type", category: "Bot", tokens: [{ t: "text", v: "Bot has " }, { t: "select", k: "op", options: ["exactly or more than", "less than"] }, { t: "text", v: " " }, { t: "select", k: "count", options: ["1 position", "2 positions", "3 positions"] }, { t: "text", v: " with " }, { t: "select", k: "type", options: ["Short put spread", "Short call spread"] }, { t: "text", v: " type and any status" }] },
  { id: "bot_latest_signal", category: "Bot", tokens: [{ t: "text", v: "The latest confirmed signal is " }, { t: "select", k: "signal", options: ["bullish", "bearish"] }] },
  { id: "bot_pl", category: "Bot", tokens: [{ t: "text", v: "Bot " }, { t: "select", k: "metric", options: ["open P/L", "closed P/L today"] }, { t: "text", v: " is " }, { t: "select", k: "cmp", options: CMP }, { t: "text", v: " " }, { t: "input", k: "value", placeholder: "value" }] },
  { id: "bot_has", category: "Bot", tokens: [{ t: "text", v: "Bot has " }, { t: "select", k: "op", options: ["exactly", "at least", "at most"] }, { t: "text", v: " " }, { t: "select", k: "count", options: ["1 position", "2 positions", "3 positions"] }, { t: "text", v: " with " }, { t: "select", k: "by", options: ["symbol", "type"] }, { t: "text", v: " and expiration (" }, { t: "select", k: "exp", options: ["0 days", "7 days", "30 days"] }, { t: "text", v: ")" }] },
];

/** Categories kept in the code but not shown in the picker: the platform has no indicators and does no price
 * analysis - the only input to a bot is the TradingView webhook's bullish or bearish call. */
export const HIDDEN_CONDITION_CATEGORIES: ConditionCategory[] = ["Indicators"];

/** The categories the condition picker offers. */
export const CONDITION_CATEGORIES: ConditionCategory[] = (["Stocks", "Indicators", "Positions", "Bot"] as ConditionCategory[]).filter((c) => !HIDDEN_CONDITION_CATEGORIES.includes(c));

/** The conditions a person can actually pick. */
export const VISIBLE_CONDITIONS: ConditionTemplate[] = CONDITION_CATALOG.filter((t) => CONDITION_CATEGORIES.includes(t.category));

export const conditionTemplate = (id: string): ConditionTemplate => CONDITION_CATALOG.find((t) => t.id === id)!;

/** A new condition: selects start on their first option, inputs on their preset (or empty). */
export function newCondition(templateId: string): Condition {
  const values: Record<string, string> = {};
  for (const tok of conditionTemplate(templateId).tokens) {
    if (tok.t === "select") values[tok.k] = tok.options[0];
    if (tok.t === "input") values[tok.k] = tok.value ?? "";
  }
  return { templateId, values };
}

export function describeCondition(c: Condition): string {
  return conditionTemplate(c.templateId)
    .tokens.map((tok) => (tok.t === "text" ? tok.v : c.values[tok.k] || `‹${tok.t === "input" ? tok.placeholder : tok.k}›`))
    .join("");
}

export function isConditionComplete(c: Condition): boolean {
  return conditionTemplate(c.templateId).tokens.every((tok) => tok.t === "text" || !!c.values[tok.k]?.trim());
}

/** Does a condition (or its sentence) match a search query? */
export function conditionMatches(t: ConditionTemplate, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const sentence = describeCondition(newCondition(t.id)).toLowerCase();
  return sentence.includes(needle) || t.category.toLowerCase().includes(needle);
}

// ---------------------------------------------------------------------------
// Step summaries, flow checks, preview trace
// ---------------------------------------------------------------------------

const sideWord = (type: string) => (type === "short_call_spread" ? "call" : "put");

/** "SPX, exactly 0d, $0.01 above underlying price, $5.00 above short call leg" */
export function openSummary(s: Step, inputs: BotInput[] = []): string {
  const v = (k: string) => val(s, k, inputs);
  const side = sideWord(v("type"));
  return [
    v("symbol") || "symbol?",
    `${v("exp_op")} ${v("exp_days")}d`,
    `$${v("short_off")} ${v("short_dir")} underlying price`,
    `$${v("long_off")} ${v("long_dir")} short ${side} leg`,
  ].join(", ");
}

export function describeStep(s: Step, inputs: BotInput[] = []): string {
  if (s.caption?.trim()) return s.caption.trim();
  const c = s.config;
  const v = (k: string) => val(s, k, inputs);
  switch (s.kind) {
    case "decision":
    case "conditional":
      return s.conditions && s.conditions.length > 0 ? s.conditions.map(describeCondition).join(" and ") : "Choose a condition";
    case "open_position":
      return `Open ${v("symbol") || "?"} ${POSITION_TYPES[v("type")] ?? "position"}`;
    case "open_trade_idea":
      return `Open trade idea (${c.symbol || "symbol?"})`;
    case "close_position":
      const symbol = c.symbol || "SPX";
      return `Close Position (${c.type === "any" ? `${symbol}, any spread` : `${symbol}, ${POSITION_TYPES[c.type] ?? "position"}`})`;
    case "update_exit":
      return `Exit options: profit ${c.profit ? `${c.profit}%` : "—"}, stop ${c.stop ? `${c.stop}%` : "—"}`;
    case "notification":
      return c.message ? `Notify: “${c.message}”` : "Send a notification";
    case "tags":
      return `${c.action || "Add tag"}${c.tag ? `: ${c.tag}` : ""}`;
    case "loop_positions":
      return `For each of ${(c.over || "positions").toLowerCase()}`;
    case "loop_symbols":
      return c.symbols ? `For each symbol in ${c.symbols}` : "For each symbol in a list";
    case "loop_bot_symbols":
      return "For each of the bot's symbols";
  }
}

/** Every child lane of a step, in display order. */
export function lanes(s: Step): { label: string; steps: Step[] }[] {
  if (s.kind === "decision") return [{ label: "YES", steps: s.yes ?? [] }, { label: "NO", steps: s.no ?? [] }];
  if (hasBody(s.kind)) return [{ label: s.kind === "conditional" ? "THEN" : "EACH", steps: s.yes ?? [] }];
  return [];
}

/** Depth-first walk; `ancestors` are the decision/conditional steps above. */
export function walk(steps: Step[], visit: (s: Step, ancestors: Step[]) => void, ancestors: Step[] = []): void {
  for (const s of steps) {
    visit(s, ancestors);
    for (const lane of lanes(s)) walk(lane.steps, visit, [...ancestors, s]);
  }
}

export interface Opportunity {
  stepId: string;
  title: string;
  summary: string;
}

export interface FlowCheck {
  warnings: string[];
  /** Nice-to-haves: shown with the warnings but never counted as one. */
  suggestions: string[];
  /** One per open step: the trades this flow could make. */
  opportunities: Opportunity[];
}

/** What's wrong (warnings), what could be better (suggestions), and the trades
 * the flow can open (opportunities, in plain English). */
export function checkFlow(steps: Step[], inputs: BotInput[] = []): FlowCheck {
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const opportunities: Opportunity[] = [];
  const kinds = new Set<StepKind>();

  // An empty flow isn't a warning (a new automation starts with none) - just a nudge.
  if (steps.length === 0) suggestions.push("Add a first step with the + button to get started.");

  walk(steps, (s, ancestors) => {
    kinds.add(s.kind);
    if (needsCondition(s.kind)) {
      if (!s.conditions || s.conditions.length === 0) warnings.push(`${stepInfo(s.kind).name} has no condition.`);
      else
        for (const c of s.conditions)
          if (!isConditionComplete(c)) warnings.push(`A condition is missing a value: “${describeCondition(c)}”.`);
    }
    if (s.kind === "notification" && !s.config.message?.trim()) warnings.push("A notification has no message.");
    if (s.kind === "tags" && !s.config.tag?.trim()) warnings.push("A tag step has no tag name.");
    if (s.kind === "loop_symbols" && !s.config.symbols?.trim()) warnings.push("A symbols loop has no symbols.");
    if (s.kind === "update_exit" && !s.config.profit?.trim() && !s.config.stop?.trim()) warnings.push("Exit options set neither a profit target nor a stop loss.");

    if (s.kind === "open_position") {
      opportunities.push({ stepId: s.id, title: POSITION_TYPES[val(s, "type", inputs)] ?? "Position", summary: openSummary(s, inputs) });
    }
    if (s.kind === "open_position" || s.kind === "open_trade_idea") {
      const guardedByTime = ancestors.some((a) => a.conditions?.some((c) => c.templateId === "bot_time"));
      if (!guardedByTime) warnings.push("An open step isn't inside a market-time check, so it could run outside trading hours.");
    }
  });

  if ((kinds.has("open_position") || kinds.has("open_trade_idea")) && !kinds.has("close_position")) suggestions.push("Add a Close Position step so the flow can exit what it opens.");
  if (steps.length > 0 && !kinds.has("notification")) suggestions.push("Add a Notification so you know when this flow runs.");
  if (steps.length > 0 && !kinds.has("decision") && !kinds.has("conditional")) suggestions.push("Add a Decision to guard the flow with a condition.");

  return { warnings: [...new Set(warnings)], suggestions, opportunities };
}

export interface TraceLine {
  depth: number;
  label: string;
  text: string;
}

/** The steps in the order they'd run, with both paths of every decision listed.
 * It evaluates nothing - it's a read-through of the design. */
export function previewTrace(steps: Step[], inputs: BotInput[] = []): TraceLine[] {
  const out: TraceLine[] = [];
  const visit = (list: Step[], depth: number, label: string) => {
    list.forEach((s, i) => {
      out.push({ depth, label: i === 0 ? label : "", text: `${stepInfo(s.kind).name}: ${describeStep(s, inputs)}` });
      for (const lane of lanes(s)) {
        if (lane.steps.length === 0) out.push({ depth: depth + 1, label: lane.label, text: "(nothing)" });
        else visit(lane.steps, depth + 1, lane.label);
      }
    });
  };
  visit(steps, 0, "");
  return out;
}

// ---------------------------------------------------------------------------
// Tree helpers (immutable updates by step id)
// ---------------------------------------------------------------------------

export type LaneKey = "root" | "yes" | "no";

let counter = 0;
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function newStep(kind: StepKind, conditions?: Condition[]): Step {
  return {
    id: newId("step"),
    kind,
    config: defaultConfig(kind),
    ...(needsCondition(kind) ? { conditions: conditions ?? [] } : {}),
    ...(isBranching(kind) ? { yes: [], no: [] } : hasBody(kind) ? { yes: [] } : {}),
  };
}

/** Deep copy with fresh ids - used by "Copy Action". */
export function cloneStep(s: Step): Step {
  return {
    ...s,
    id: newId("step"),
    config: { ...s.config },
    conditions: s.conditions?.map((c) => ({ ...c, values: { ...c.values } })),
    yes: s.yes?.map(cloneStep),
    no: s.no?.map(cloneStep),
  };
}

/** Inserts `step` immediately before the step with `beforeId`, wherever it sits. */
export function insertBefore(steps: Step[], beforeId: string, step: Step): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    if (s.id === beforeId) out.push(step);
    out.push({ ...s, yes: s.yes && insertBefore(s.yes, beforeId, step), no: s.no && insertBefore(s.no, beforeId, step) });
  }
  return out;
}

/** Appends `step` to the lane (`parentId` + `lane`), or to the root when parentId is null. */
export function appendStep(steps: Step[], parentId: string | null, lane: LaneKey, step: Step): Step[] {
  if (parentId === null) return [...steps, step];
  return steps.map((s) => {
    if (s.id === parentId) return lane === "no" ? { ...s, no: [...(s.no ?? []), step] } : { ...s, yes: [...(s.yes ?? []), step] };
    return { ...s, yes: s.yes && appendStep(s.yes, parentId, lane, step), no: s.no && appendStep(s.no, parentId, lane, step) };
  });
}

export function updateStep(steps: Step[], id: string, patch: (s: Step) => Step): Step[] {
  return steps.map((s) => {
    if (s.id === id) return patch(s);
    return { ...s, yes: s.yes && updateStep(s.yes, id, patch), no: s.no && updateStep(s.no, id, patch) };
  });
}

export function removeStep(steps: Step[], id: string): Step[] {
  return steps
    .filter((s) => s.id !== id)
    .map((s) => ({ ...s, yes: s.yes && removeStep(s.yes, id), no: s.no && removeStep(s.no, id) }));
}

export function findStep(steps: Step[], id: string): Step | undefined {
  let found: Step | undefined;
  walk(steps, (s) => {
    if (s.id === id) found = s;
  });
  return found;
}

/** Strips the undefined lanes that the recursive helpers can leave behind. */
export function normalize(steps: Step[]): Step[] {
  return steps.map((s) => {
    const { yes, no, ...rest } = s;
    return { ...rest, ...(yes ? { yes: normalize(yes) } : {}), ...(no ? { no: normalize(no) } : {}) };
  });
}
