import { readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LiveStatus } from "@/lib/automation/liveControl";
import type { BybitView } from "@/lib/automation/bybitView";
import { BybitPanelView } from "./BybitPanel";
import { LIVE_TABS, LivePanelView, nextStep, type LiveTab, type LiveViewProps } from "./LivePanel";

const status = (over: Partial<LiveStatus> = {}): LiveStatus => ({
  host: "api.bybit.com",
  switch: { on: false, typedAt: null, offReason: null, offAt: null },
  mirror: { on: false },
  resumePending: false,
  pullback: { enabled: true, fallUsd: 0.03, minPeakUsd: 0.12, chainEnabled: false, chainStopUsd: 0.03, chainMax: 10 },
  chainRunning: null,
  stage: 1,
  leverage: 10,
  dailyLossUsd: 2,
  limits: { maxQty: 0.001, dailyLossCeilingUsd: 3, maxTradesPerDay: 5, maxOpenPositions: 1 },
  tradesToday: 0,
  key: { present: true, problem: null },
  check: null,
  warnings: [],
  gate: {
    ok: false,
    why: "failure tests on the real demo account 0 of 6 (still to run: 1, 2, 3, 4, 5, 6); partial fill proven on the fake exchange: no; clean counted trades 2 of 5",
    tests: { passed: 0, total: 6, items: [] },
    partialFill: { id: 7, title: "partial fill", source: "fake", passed: false, stale: false, lastRunAt: null, lastRunPassed: null },
    trades: { clean: 2, needed: 5, lastUnprotectedAt: null, lastUnprotectedText: null, counted: 2, excluded: 7 },
    ledger: { ok: true, events: 13, damaged: null, pending: 0 },
    codeHash: "abc",
  },
  bot: { exists: true, enabled: false, killSwitch: false, needsAttention: false, reason: null },
  position: null,
  recent: [],
  now: 0,
  ...over,
});
const liveView = (over: Partial<BybitView> = {}): BybitView => ({
  symbol: "BTCUSDT",
  positionSize: 0.001,
  mode: "24 hours a day, every day",
  killSwitch: false,
  open: null,
  openError: null,
  mismatch: null,
  history: [{ orderId: "l1", side: "Long", size: 0.001, entryPrice: 76_000, exitPrice: 76_100, pnl: 0.07, pnlPercent: 0.09, fees: 0.04, openFee: 0.02, closeFee: 0.02, grossPnl: 0.11, leverage: 10, entryValue: 76, exitValue: 76.1, openedAt: 1, closedBy: "stop_loss", byBot: true, manual: false, closedAt: 2 }],
  historyError: null,
  historyClearedAt: null,
  todayResetAt: null,
  historyTotals: { count: 1, wins: 1, losses: 0, total: 0.07, todayResult: 0.07 },
  closed: [],
  closedCount: 0,
  totals: { day: "2026-11-11", dayResult: 0.07, realizedToday: 0.07, openLoss: 0, running: 0, limit: 2, room: 2, reached: false, tripped: false },
  asOf: 0,
  ...over,
});
const heldTrade = { side: "Long" as const, size: 0.001, entryPrice: 76_000, currentPrice: 76_050, pnl: 0.05, pnlPercent: 0.07, valueUsd: 76.05, stopLoss: 75_772, takeProfit: 76_456, ifStopLoss: -0.23, ifTakeProfit: 0.46, breakeven: null, manual: false };
const ON = { on: true, typedAt: 1, offReason: null, offAt: null };
const passed = { at: 1, ok: true, problems: [], warnings: [], unreadable: null, marginMode: "ISOLATED_MARGIN", leverage: 10 };
const props = (s: LiveStatus, over: Partial<LiveViewProps> = {}): LiveViewProps => ({
  s,
  message: null,
  busy: false,
  confirming: false,
  onAsk: () => {},
  onCancel: () => {},
  daily: "2",
  onDaily: () => {},
  onCheck: () => {},
  onSwitch: () => {},
  onSaveDaily: () => {},
  onStage: () => {},
  ...over,
});
const html = (s: LiveStatus, over: Partial<LiveViewProps> = {}) => renderToStaticMarkup(<LivePanelView {...props(s, over)} />).replace(/<!-- -->/g, "");
/** Every tab's markup joined, for the checks that are about the content and not about which tab shows it. */
const allTabs = (s: LiveStatus, over: Partial<LiveViewProps> = {}) => LIVE_TABS.map((tab) => html(s, { ...over, tab })).join("\n");
const disabled = (markup: string, testid: string): boolean => {
  const tag = markup.match(new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no button ${testid}`);
  return /\sdisabled=""/.test(tag);
};

/** Expands the page into plain elements (the components have no hooks) so a test can find a control by its test id and call the handler the page gave it, with no browser. */
function expand(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ children?: ReactNode }>;
    if (typeof el.type === "function" && (el.type as { name?: string }).name === "PullbackEditor") return void out.push(el); // a component with its own state: its controls are tested in PullbackEditor.test.tsx
    if (typeof el.type === "function") return walk((el.type as (props: unknown) => ReactNode)(el.props));
    out.push(el);
    walk(el.props.children);
  };
  walk(node);
  return out;
}
const control = (s: LiveStatus, tab: LiveTab, testid: string, over: Partial<LiveViewProps> = {}) => {
  const found = expand(LivePanelView(props(s, { ...over, tab }))).find((e) => (e.props as Record<string, unknown>)["data-testid"] === testid);
  if (!found) throw new Error(`no control ${testid} on the ${tab} tab`);
  return found.props as { onClick?: () => void; onChange?: (e: { target: { value: string } }) => void; disabled?: boolean; value?: string };
};
const has = (s: LiveStatus, tab: LiveTab, testid: string, over: Partial<LiveViewProps> = {}) => html(s, { ...over, tab }).includes(`data-testid="${testid}"`);

describe("the Live page: one master toggle", () => {
  it("opens as OFF on the Status tab, and says what each number is", () => {
    const m = allTabs(status());
    expect(m).toContain("LIVE TRADING IS OFF");
    expect(m).toContain("api.bybit.com");
    expect(m).toContain("0.001 BTC at most");
    expect(m).toContain("0 of 5 used today");
    expect(m).toContain("$2.00");
    expect(m).toContain("ceiling $3.00");
    expect(m).toContain("Stage 1: a $10 account, 10x isolated");
    expect(html(status())).toContain('data-testid="live-tabpanel-status"');
  });
  it("has two tabs, Status and Settings: the typed-word tab, Trades and Gate are gone", () => {
    expect(LIVE_TABS).toEqual(["status", "settings"]);
    const m = html(status());
    for (const t of LIVE_TABS) expect(m).toContain(`data-testid="live-tab-${t}"`);
    expect(m).not.toContain("live-tab-on");
    expect(m).not.toContain("live-tab-trades");
    expect(m).not.toContain("live-tab-gate");
    expect(m).not.toContain(">Turn ON<");
  });
  it("has NO typing anywhere: no LIVE box, no mirror box or button, on any tab", () => {
    const m = allTabs(status({ mirror: { on: true } }), { confirming: true });
    expect(m).not.toMatch(/type LIVE|live-typed|mirror-typed|mirror-on|mirror-off|Type LIVE|the word LIVE/i);
    // the only text box left on the whole page is the daily loss limit
    expect([...m.matchAll(/<input[^>]*data-testid="([^"]+)"/g)].map((x) => x[1])).toEqual(["live-daily"]);
    expect(m).not.toMatch(/<input[^>]*placeholder/);
  });
  it("the toggle is on the Status tab only, with the switch role and the current state", () => {
    for (const t of LIVE_TABS) expect(has(status(), t, "live-toggle"), t).toBe(t === "status");
    expect(html(status())).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(html(status({ switch: ON, mirror: { on: true } }))).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(html(status({ switch: ON, mirror: { on: true } }))).toContain("LIVE TRADING IS ON");
  });
});

describe("turning it ON: one toggle press, one 'Are you sure?' click", () => {
  it("pressing the toggle while OFF only opens the question: it sends nothing", () => {
    const onAsk = vi.fn();
    const onSwitch = vi.fn();
    control(status(), "status", "live-toggle", { onAsk, onSwitch }).onClick?.();
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onSwitch).not.toHaveBeenCalled();
  });
  it("the question is hidden until asked, and says in plain words that real money is involved", () => {
    expect(html(status())).not.toContain("live-confirm-box");
    const m = html(status(), { confirming: true });
    expect(m).toContain('data-testid="live-confirm-box"');
    expect(m).toContain("Are you sure?");
    expect(m).toMatch(/REAL money/);
    expect(m).toMatch(/real money can be lost/);
    expect(m).toContain("0.001 BTC at most");
    expect(m).toContain("$2.00");
  });
  it("only the confirm button sends ON; cancel sends nothing", () => {
    const onSwitch = vi.fn();
    const onCancel = vi.fn();
    control(status(), "status", "live-confirm", { confirming: true, onSwitch, onCancel }).onClick?.();
    expect(onSwitch.mock.calls).toEqual([[true]]);
    control(status(), "status", "live-cancel", { confirming: true, onSwitch, onCancel }).onClick?.();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });
  it("the question never shows while it is already ON, and the confirm button is busy-proof", () => {
    expect(html(status({ switch: ON, mirror: { on: true } }), { confirming: true })).not.toContain("live-confirm-box");
    expect(disabled(html(status(), { confirming: true, busy: true }), "live-confirm")).toBe(true);
  });
  it("with no live key the toggle cannot be pressed, and says why", () => {
    const s = status({ key: { present: false, problem: "BYBIT_LIVE_API_KEY, BYBIT_LIVE_API_SECRET are not set" } });
    expect(disabled(html(s), "live-toggle")).toBe(true);
    expect(html(s)).toContain("missing");
    expect(html(s)).toContain("not set");
    expect(nextStep(s)).toMatch(/Add the live key/);
  });
  it("while a resume is waiting after a restart the toggle cannot be pressed, and the page says it is turning itself back on", () => {
    const s = status({ resumePending: true });
    expect(disabled(html(s), "live-toggle")).toBe(true);
    expect(html(s)).toContain('data-testid="live-resume-pending"');
    expect(html(s)).toMatch(/turning itself back on/);
    expect(nextStep(s)).toMatch(/turning itself back on after the restart/);
  });
  it("busy blocks the toggle in either direction", () => {
    expect(disabled(html(status(), { busy: true }), "live-toggle")).toBe(true);
    expect(disabled(html(status({ switch: ON, mirror: { on: true } }), { busy: true }), "live-toggle")).toBe(true);
  });
});

describe("turning it OFF: one click, no confirm", () => {
  it("pressing the toggle while ON sends OFF at once and never opens a question", () => {
    const onSwitch = vi.fn();
    const onAsk = vi.fn();
    control(status({ switch: ON, mirror: { on: true } }), "status", "live-toggle", { onSwitch, onAsk }).onClick?.();
    expect(onSwitch.mock.calls).toEqual([[false]]);
    expect(onAsk).not.toHaveBeenCalled();
  });
  it("the OFF press works with no key and with a failed check, and is never behind a question", () => {
    for (const s of [status({ switch: ON, mirror: { on: true }, key: { present: false, problem: "x" } }), status({ switch: ON, mirror: { on: true }, check: { ...passed, ok: false, problems: ["x"] } })]) {
      expect(disabled(html(s), "live-toggle")).toBe(false);
      const onSwitch = vi.fn();
      control(s, "status", "live-toggle", { onSwitch }).onClick?.();
      expect(onSwitch.mock.calls).toEqual([[false]]);
    }
  });
  it("while OFF with a live position held, the page says the signals still reach the live bot to close it", () => {
    const m = html(status({ mirror: { on: true }, position: { type: "short_call_spread", status: "open", openedAt: 3, entry: 74000 } }));
    expect(m).toMatch(/opposite signal can close it/);
    expect(m).toContain("Closing only: a live position is held");
    expect(html(status())).not.toContain("Closing only");
  });
});

describe("the Status tab is the demo Bybit page's layout, plus a red banner and the big toggle", () => {
  it("starts with the clear red 'LIVE, real money' banner, then the big toggle, then the live Bybit view", () => {
    const m = html(status({ check: passed }), { tradesPanel: <BybitPanelView v={liveView({ open: heldTrade })} live /> });
    expect(m).toContain('data-testid="live-banner"');
    expect(m).toMatch(/bg-down[^>]*data-testid="live-banner"[^>]*>LIVE, real money on api\.bybit\.com</);
    const order = ["live-banner", "live-toggle", "live-trades-panel", "bybit-status", "bybit-totals", "bybit-open", "bybit-history"].map((id) => m.indexOf(`data-testid="${id}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
  it("shows the toggle and state, the key, the last check in one line and one line saying what to do next", () => {
    const m = html(status({ check: passed }));
    expect(m).toContain('data-testid="live-toggle"');
    expect(m).toContain("LIVE TRADING IS OFF");
    expect(m).toContain("present (never shown)");
    expect(m).toMatch(/Last account check[^]*passed at/);
    expect(m).toContain('data-testid="live-next"');
  });
  it("the live view inside it carries the red chip, the four cards, the open trade and the history, with no Clear history and no Reset", () => {
    const m = html(status({ check: passed }), { tradesPanel: <BybitPanelView v={liveView({ open: heldTrade })} live /> });
    expect(m).toContain("Bybit LIVE account (real money)");
    for (const part of ["Open trade profit / loss", "Today", "Total since cleared", "Daily loss limit", "Stop loss (set at Bybit)", "Take profit (set at Bybit)", "How it closed"]) expect(m, part).toContain(part);
    expect(m).toMatch(/left of \$2\.00/);
    expect(m).not.toContain("Clear history");
    expect(m).not.toContain('data-testid="reset-today"');
  });
  it("leaves out the limits, the gate, the check button and the typed forms (they are in Settings, or gone)", () => {
    const m = html(status({ check: passed }));
    for (const gone of ["live-check\"", "live-daily", "live-stage", "The live gate", "Order size", "live-typed", "Mirror"]) expect(m, gone).not.toContain(gone);
  });
  it("shows why it was turned OFF, the kill switch and the attention banner", () => {
    const m = html(status({ switch: { on: false, typedAt: 1, offReason: "STOP LOSS ALARM: the stop is missing", offAt: 5 }, bot: { exists: true, enabled: false, killSwitch: true, needsAttention: true, reason: "LIVE SWITCH TURNED OFF: STOP LOSS ALARM" } }));
    expect(m).toContain("STOP LOSS ALARM: the stop is missing");
    expect(m).toContain("kill switch is on");
    expect(m).toContain("needs attention");
  });
  it("says on the page that both bots get each alert at the same moment", () => {
    expect(html(status({ switch: ON, mirror: { on: true } }))).toMatch(/reaches the demo bot and the live bot at the same moment; neither waits for the other/);
    expect(html(status(), { tab: "settings" })).toMatch(/the demo bot and the live bot get it at the same moment, each on its own/);
  });
});

describe("no demo data on the live page, and no live data on the demo page", () => {
  it("the live page asks only the live trades route, and the shared view has no demo wording on its live twin", () => {
    const live = html(status({ check: passed }), { tradesPanel: <BybitPanelView v={liveView()} live /> });
    expect(live).not.toMatch(/DEMO|paper money|api-demo|btc_bybit(?!_live)/);
    expect(live).toContain("Bybit LIVE account (real money)");
  });
  it("the demo page's view has no live wording", () => {
    const demo = renderToStaticMarkup(<BybitPanelView v={liveView()} />);
    expect(demo).toContain("Bybit DEMO account (paper money)");
    expect(demo).not.toMatch(/LIVE account|real money/);
  });
});

describe("the other tabs stay as they were, minus the typed forms", () => {
  it("each control is on its own tab and only there", () => {
    const where: Record<string, LiveTab[]> = {
      "live-toggle": ["status"],
      "live-check": ["settings"],
      "live-daily": ["settings"],
      "live-daily-save": ["settings"],
      "live-stage-1": ["settings"],
      "live-stage-2": ["settings"],
    };
    for (const [id, tabs] of Object.entries(where)) for (const t of LIVE_TABS) expect(has(status(), t, id), `${id} on ${t}`).toBe(tabs.includes(t));
  });
  it("Setup shows the check result (margin mode, leverage, warnings in plain words) and then the limits", () => {
    const m = html(status({ check: passed, warnings: ["The live key has no IP restriction: anyone who gets the key could use it from anywhere. Add this Mac's IP to the key at Bybit."] }), { tab: "settings" });
    expect(m).toMatch(/Margin mode \(must be isolated\)[^]*ISOLATED_MARGIN/);
    expect(m).toMatch(/Leverage[^]*10x/);
    expect(m).toContain("Warning: The live key has no IP restriction");
    expect(m.indexOf("The account check")).toBeLessThan(m.indexOf("The limits"));
  });
  it("Settings also holds the gate numbers, marked as needed for stage 2 only", () => {
    const m = html(status(), { tab: "settings" });
    expect(m).toContain("Needed for stage 2 only");
    expect(m).toMatch(/>0 of 6</);
    expect(m).toMatch(/>2 of 5</);
    expect(m).toMatch(/Partial fill proven on the fake exchange[^]*no/);
    expect(m).toContain("Not passed:");
  });
  it("stage 2 cannot be chosen until the gate has passed; the check button needs a key", () => {
    expect(disabled(html(status(), { tab: "settings" }), "live-stage-2")).toBe(true);
    const ok = status();
    ok.gate = { ...ok.gate, ok: true };
    expect(disabled(html(ok, { tab: "settings" }), "live-stage-2")).toBe(false);
    expect(disabled(html(status({ key: { present: false, problem: "no key" } }), { tab: "settings" }), "live-check")).toBe(true);
  });
  it("shows a failed check's problems and the IP warning in red words", () => {
    const m = html(status({ check: { ...passed, ok: false, problems: ["The live key has rights that can move money"], marginMode: "REGULAR_MARGIN" }, warnings: ["The live key has no IP restriction"] }), { tab: "settings" });
    expect(m).toContain("did not pass");
    expect(m).toContain("can move money");
    expect(m).toContain("Warning: The live key has no IP restriction");
  });
});

describe("the red banner and the always-visible state", () => {
  it("a failed or unreadable account check shows the red banner on every tab; a passed or missing check shows none", () => {
    const failed = status({ check: { ...passed, ok: false, problems: ["Bybit's position record is not on isolated margin."], leverage: null } });
    for (const t of LIVE_TABS) expect(html(failed, { tab: t }), t).toContain('data-testid="live-check-banner"');
    const unreadable = status({ check: { ...passed, ok: false, unreadable: "timeout", marginMode: null, leverage: null } });
    for (const t of LIVE_TABS) expect(html(unreadable, { tab: t })).toContain("Bybit could not be asked: timeout");
    for (const t of LIVE_TABS) {
      expect(html(status({ check: passed }), { tab: t })).not.toContain("live-check-banner");
      expect(html(status(), { tab: t })).not.toContain("live-check-banner");
    }
  });
  it("the ON or OFF state is visible on every tab, and a server refusal shows on every tab", () => {
    for (const t of LIVE_TABS) {
      expect(html(status(), { tab: t })).toContain("Live trading: OFF");
      expect(html(status({ switch: ON, mirror: { on: true } }), { tab: t })).toContain("Live trading: ON");
      expect(html(status(), { tab: t, message: "Confirm that real money is involved" })).toContain("Confirm that real money is involved");
    }
  });
});

describe("the next-step line", () => {
  it("follows the situation, with no word to type", () => {
    expect(nextStep(status({ key: { present: false, problem: "x" } }))).toMatch(/Add the live key/);
    expect(nextStep(status({ bot: { exists: true, enabled: false, killSwitch: true, needsAttention: false, reason: null } }))).toMatch(/kill switch/);
    expect(nextStep(status())).toMatch(/Open Settings and press Check/);
    expect(nextStep(status({ check: { ...passed, ok: false, problems: ["x"] } }))).toMatch(/Fix what the red box says/);
    expect(nextStep(status({ check: passed }))).toMatch(/switch the Live trading toggle ON and confirm/);
    expect(nextStep(status({ check: passed, switch: ON, mirror: { on: true } }))).toMatch(/signals reach the live bot/);
    expect(nextStep(status({ check: passed, switch: ON, mirror: { on: true } }))).toBe("Live trading is ON, and the signals reach the live bot. Watch the Open trade box and the Trade history on this page. To stop, switch the toggle OFF.");
    // no line of the page points to a tab that does not exist any more
    for (const s of [status(), status({ check: passed }), status({ check: passed, switch: ON, mirror: { on: true } }), status({ check: passed, switch: ON }), status({ resumePending: true })]) expect(nextStep(s)).not.toMatch(/Trades tab|Gate tab|Setup tab|Turn ON tab/);
    expect(nextStep(status({ check: passed, switch: ON }))).toMatch(/do not reach the live bot/);
    for (const s of [status(), status({ check: passed }), status({ check: passed, switch: ON, mirror: { on: true } })]) expect(nextStep(s)).not.toMatch(/LIVE typed|type LIVE|word LIVE/i);
  });
  it("does not ask for an IP restriction at stage 1; at stage 2 it does", () => {
    const warn = ["The live key has no IP restriction"];
    expect(nextStep(status({ check: passed, warnings: warn }))).not.toMatch(/IP/);
    expect(nextStep(status({ check: passed, warnings: warn, stage: 2 }))).toMatch(/IP/);
  });
});

describe("every control still calls what it called before", () => {
  it("each button and box calls its own handler, with the same arguments as before", () => {
    const h = { onCheck: vi.fn(), onSaveDaily: vi.fn(), onStage: vi.fn(), onDaily: vi.fn() };
    const gateOk = status();
    gateOk.gate = { ...gateOk.gate, ok: true };
    const stage2 = status({ stage: 2 });
    control(gateOk, "settings", "live-check", h).onClick?.();
    expect(h.onCheck).toHaveBeenCalledTimes(1);
    control(gateOk, "settings", "live-daily-save", h).onClick?.();
    expect(h.onSaveDaily).toHaveBeenCalledTimes(1);
    control(gateOk, "settings", "live-daily", h).onChange?.({ target: { value: "1.5" } });
    expect(h.onDaily).toHaveBeenCalledWith("1.5");
    control(stage2, "settings", "live-stage-1", h).onClick?.();
    control(gateOk, "settings", "live-stage-2", h).onClick?.();
    expect(h.onStage.mock.calls).toEqual([[1], [2]]);
    const t = vi.fn();
    control(status(), "status", "live-tab-settings", { onTab: t }).onClick?.();
    expect(t).toHaveBeenCalledWith("settings");
  });
  it("busy blocks every button except the tab buttons", () => {
    const s = status();
    s.gate = { ...s.gate, ok: true };
    for (const [tab, id] of [["settings", "live-check"], ["settings", "live-daily-save"], ["status", "live-toggle"]] as const) expect(control(s, tab, id, { busy: true }).disabled, id).toBe(true);
    expect(control(s, "status", "live-tab-settings", { busy: true }).disabled).toBeUndefined();
  });
});

describe("live data only, and the page sends exactly what the server expects", () => {
  const src = readFileSync(path.join(__dirname, "LivePanel.tsx"), "utf8");
  it("asks only the live routes, with confirm:true for ON and on:false for OFF, and no mirror route", () => {
    const routes = [...src.matchAll(/["'`](\/api\/[^"'`]*)["'`]/g)].map((m) => m[1]);
    expect([...new Set(routes)].sort()).toEqual(["/api/automation/live", "/api/automation/live/check", "/api/automation/live/settings", "/api/automation/live/switch"]);
    expect(src).toContain('act("/api/automation/live/check", {})');
    expect(src).toContain('act("/api/automation/live/switch", on ? { on: true, confirm: true } : { on: false })');
    expect(src).toContain('act("/api/automation/live/settings", { dailyLossUsd: Number(daily) })');
    expect(src).toContain('act("/api/automation/live/settings", { stage })');
    expect(src).not.toMatch(/typed(?!At)|btc_bybit|ndx_|spx_|bybitView|\/api\/automation\/bybit|\/api\/automation\/bots|live\/mirror/);
  });
  it("shows only what the live status holds: the word demo appears only in the labelled explanations, never as data", () => {
    const m = allTabs(status({ recent: [{ openedAt: 1, closedAt: 2, type: "short_put_spread", closeReason: "stop_loss", pl: -0.31 }] }));
    const explained = ["Failure tests on the real demo account", "failure tests on the real demo account", "Clean counted demo trades", "reaches the demo bot and the live bot at the same moment", "Then the demo bot and the live bot get it at the same moment", "its values are separate from the demo bot&#x27;s"].reduce((text, phrase) => text.split(phrase).join(""), m);
    expect(explained).not.toMatch(/demo/i);
    expect(m).not.toMatch(/api-demo\.bybit|btc_bybit/);
  });
  it("contains no key, secret or token field", () => {
    expect(allTabs(status())).not.toMatch(/api[_-]?secret|BYBIT_LIVE_API_SECRET=|apiKey/i);
  });
});

describe("the Pullback exit card on the Live page's Settings tab (release 9)", () => {
  it("is there, marked LIVE bot / real money, and shows the live bot's own values; the Status tab does not carry it", () => {
    const m = html(status({ pullback: { enabled: true, fallUsd: 0.05, minPeakUsd: 0.4, chainEnabled: false, chainStopUsd: 0.03, chainMax: 10 } }), { tab: "settings" });
    expect(m).toContain('data-testid="pullback-card"');
    expect(m).toContain("pullback-live-chip");
    expect(m).toMatch(/value="0.4"/);
    expect(m).toMatch(/value="0.05"/);
    expect(html(status(), { tab: "status" })).not.toContain("pullback-card");
  });
  it("shows a running chain and the live limits that apply to it", () => {
    const m = html(status({ chainRunning: { trades: 2 }, pullback: { enabled: true, fallUsd: 0.03, minPeakUsd: 0.12, chainEnabled: true, chainStopUsd: 0.03, chainMax: 10 } }), { tab: "settings" });
    expect(m).toContain("A chain is running: 2 chain trade(s) so far.");
    expect(m).toMatch(/counts in the day&#x27;s 5 trades and obeys the \$2 daily loss limit/);
  });
  it("sends its changes to the live settings route only, in a pullback object", () => {
    const src = readFileSync(path.join(__dirname, "LivePanel.tsx"), "utf8");
    expect(src).toContain('onSavePullback={(body) => void act("/api/automation/live/settings", { pullback: body })}');
    expect(src).not.toMatch(/api\/automation\/bots\//);
  });
});
