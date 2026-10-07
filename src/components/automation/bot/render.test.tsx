import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { computeStats } from "@/lib/automation/pnl";
import { DEFAULT_ALERTS, type Decision, type Position, type Signal } from "@/lib/automation/types";
import { buildPosition } from "@/lib/automation/testSupport";
import type { BotContext } from "./BotDetail";
import { DashboardTab } from "./DashboardTab";
import { LogTab } from "./LogTab";
import { PositionsView } from "./PositionsTab";
import { InputsDrawer, SafeguardsDrawer, SettingsTab } from "./SettingsTab";
import type { BotDetailData } from "./model";

// Server-render smoke tests: no browser, no server, no network. They catch a
// tab crashing on real-shaped data and pin the content the guide asks for.

const NOW = Date.UTC(2026, 9, 6, 18, 0);

const signal = (over: Partial<Signal> & { id: string }): Signal => ({
  botId: "spx_ema_bias",
  signal: "bullish",
  barTime: "2026-10-06T14:40:00Z",
  price: 7720.5,
  interval: "5",
  receivedAt: NOW - 3_600_000,
  status: "accepted",
  raw: {},
  ...over,
});

const decision = (over: Partial<Decision> & { id: string; outcome: Decision["outcome"] }): Decision => ({
  signalId: null,
  botId: "spx_ema_bias",
  reason: "because",
  detail: {},
  createdAt: NOW - 3_600_000,
  ...over,
});

function fixture(over: Partial<BotDetailData> = {}): BotDetailData {
  const closed: Position = buildPosition({
    id: "pos-closed",
    type: "short_put_spread",
    status: "closed",
    credit: 2.2,
    closePrice: 1.7,
    closedAt: NOW - 1_800_000,
    openedAt: NOW - 7_200_000,
    openSignalId: "sig-1",
  });
  const openPos: Position = buildPosition({ id: "pos-open", type: "short_call_spread", status: "open", shortStrike: 7740, longStrike: 7745, openedAt: NOW - 600_000 });
  const positions = [openPos, closed];
  return {
    now: NOW,
    bot: {
      id: "spx_ema_bias",
      name: "SPX EMA 9/20 Bias",
      builtIn: true,
      missingSettings: null,
      enabled: true,
      archived: false,
      needsAttention: false,
      needsAttentionReason: null,
      configError: null,
      draft: null,
      accountId: "paper-1",
      allocation: 20000,
      group: "Income",
      tags: ["0dte"],
      notes: "Watch the opening bias.",
      triggers: { bullish: true, bearish: false },
      alerts: { ...DEFAULT_ALERTS },
      safeguards: {},
      logClearedAt: 0,
      dailyResetAt: 0,
    },
    config: {
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
    },
    limits: {
      maxPositionsPerType: 1,
      dayTradingAllowed: true,
      totalPositionLimit: 1,
      dailyNewPositionLimit: 10,
      errorFailsafeThreshold: 10,
      dedupeWindowSeconds: 120,
      flipCooldownSeconds: 0,
      orderFillTimeoutSeconds: 120,
      closeConfirmTimeoutSeconds: 120,
      hours: { start: "09:35", end: "15:55", timezone: "America/New_York" },
      dryRun: false,
    },
    counts: { errorsToday: 0, newPositionsToday: 2, activePositions: 1 },
    capital: { allocation: 20000, atRisk: 840, available: 19160, netLiquid: 20150 },
    stats: computeStats(positions),
    mockPricing: false,
    options: { accounts: ["paper-1"], groups: ["Income"] },
    positions,
    orders: [],
    signals: [
      signal({ id: "sig-1" }),
      signal({ id: "sig-2", signal: "bearish", receivedAt: NOW - 1_000_000, status: "rejected", rejectReason: "bad_secret" } as Partial<Signal> & { id: string }),
    ],
    runs: [],
    decisions: [
      decision({ id: "d1", signalId: "sig-1", outcome: "opened", detail: { positionId: "pos-closed" } }),
      decision({ id: "d2", signalId: "sig-1", outcome: "closed" }),
      decision({ id: "d3", outcome: "invalid_strikes", reason: "short and long strikes are equal", signalId: null, createdAt: NOW - 500_000 }),
    ],
    ...over,
  };
}

function ctxFor(data: BotDetailData): BotContext {
  return { data, reload: vi.fn(), notify: vi.fn(), patch: vi.fn(async () => true), navigate: vi.fn(), openRun: vi.fn(), viewPosition: vi.fn(), focusPositionId: null, clearFocusPosition: vi.fn() };
}

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("Dashboard", () => {
  it("shows the guide's tiles, stats grid, capital rail and tags", () => {
    const out = html(<DashboardTab ctx={ctxFor(fixture())} />);
    for (const label of ["Closed P/L", "Return", "Change", "Position stats", "Profit factor", "Max drawdown", "Win rate", "Avg win", "Avg loss", "Streak", "Analyze results", "Activity", "Capital", "Net liquid", "At risk", "Available", "Tags", "0dte"]) {
      expect(out, label).toContain(label);
    }
    // The one priced close: (2.20 - 1.70) x 100 x 3 = +$150.
    expect(out).toContain("+$150");
  });

  it("is honest when nothing is priced: dashes, and says why", () => {
    const base = fixture();
    const unpriced = base.positions.map((p) => ({ ...p, closePrice: null }));
    const out = html(<DashboardTab ctx={ctxFor({ ...base, positions: unpriced, stats: computeStats(unpriced) })} />);
    expect(out).toContain("none with a fill price");
    expect(out).not.toContain("+$150");
  });
});

describe("Positions", () => {
  it("renders open and closed tables with leg pills, totals, and a New position button", () => {
    const d = fixture();
    const out = html(
      <PositionsView
        positions={d.positions}
        orders={d.orders}
        signals={d.signals}
        now={d.now}
        estimateFor={() => 2.2}
        newPosition={{ botId: d.bot.id, config: d.config! }}
        onChanged={() => undefined}
        notify={() => undefined}
      />,
    );
    for (const text of ["Open positions", "Closed positions", "New position", "7740", "7700", "Total", "Premium", "Risk", "Trade pr", "Close price", "Price at open / close", "Today"]) {
      expect(out, text).toContain(text);
    }
    expect(out).toContain("+$150");
  });

  it("omits New position on the all-bots page and shows a Bot column instead", () => {
    const d = fixture();
    const out = html(
      <PositionsView positions={d.positions} orders={[]} signals={[]} now={d.now} estimateFor={() => 2.2} botName={() => "SPX EMA 9/20 Bias"} onChanged={() => undefined} notify={() => undefined} />,
    );
    expect(out).not.toContain("New position");
    expect(out).toContain(">Bot<");
  });
});

describe("Log", () => {
  it("lists entries with count pills, rejections and orphan (manual) decisions", () => {
    const out = html(<LogTab ctx={ctxFor(fixture())} />);
    for (const text of ["Clear log", "Errors", "Warnings", "Bullish signal", "1 open position", "1 close position", "2 decisions", "Rejected: bad_secret", "short and long strikes are equal", "Manual position"]) {
      expect(out, text).toContain(text);
    }
  });

  it("says where each call came from (TradingView or Test Hook) and can filter on it", () => {
    const d = fixture();
    const out = html(<LogTab ctx={ctxFor(d)} />);
    expect(out).toContain(">TradingView<");
    for (const option of ["TradingView", "Test Hook"]) expect(out).toContain(`>${option}</option>`);
    const tested = html(
      <LogTab ctx={ctxFor({ ...d, signals: d.signals.map((s) => ({ ...s, raw: { ...(s.raw as object), test: true, origin: "test_hook", webhook: "BullishNDX" } })) })} />,
    );
    expect(tested).toContain(">Test Hook<");
  });

  it("names what the system did on its own by what it is, not as a manual position, and can filter on it", () => {
    const d = fixture();
    const sweep = { id: "dec-sweep", signalId: null, botId: d.bot.id, outcome: "eod_sweep", reason: "End-of-day sweep (estimate) - 1 position expired", detail: {}, createdAt: NOW - 1000 };
    const out = html(<LogTab ctx={ctxFor({ ...d, decisions: [...d.decisions, sweep] as never })} />);
    expect(out).toContain(">End-of-day sweep<");
    expect(out).toContain(">System</option>");
    // The hand-made entry from the fixture keeps its own name.
    expect(out).toContain("Manual position");
  });

  it("hides everything before the cleared time", () => {
    const d = fixture();
    const out = html(<LogTab ctx={ctxFor({ ...d, bot: { ...d.bot, logClearedAt: NOW } })} />);
    expect(out).toContain("Log cleared.");
    expect(out).not.toContain("Bullish signal");
  });
});

describe("Settings", () => {
  it("shows monitors, triggers, inputs, notes, safeguards, timing, symbols and alerts", () => {
    const out = html(<SettingsTab ctx={ctxFor(fixture())} />);
    for (const text of ["Monitors", "Triggers", "Bullish signal", "Bearish signal", "Bot inputs", "Bot inputs are variables shared by your bot", "Notes", "Watch the opening bias.", "Safeguards", "Daily positions", "Symbols", "SPX", "Activity Alerts", "Scan Speeds", "Open position", "Automation error"]) {
      expect(out, text).toContain(text);
    }
  });

  it("both Close Monitors are listed, switched off, and the switches are locked until they are attached to the triggers", () => {
    const out = html(<SettingsTab ctx={ctxFor(fixture())} />);
    for (const name of ["Bullish Close Monitor", "Bearish Close Monitor"]) {
      const m = new RegExp(`<button[^>]*aria-label="${name} on/off \\(off for now\\)"[^>]*>`).exec(out);
      expect(m, name).not.toBeNull();
      expect(m![0]).toContain('aria-checked="false"');
      expect(m![0]).toContain("disabled");
    }
    // The system monitors (end-of-day sweep, stale-position check) still run, but aren't listed: they aren't settings to manage here.
    for (const hidden of ["End-of-day expiry sweep", "Stale-position check", "can&#x27;t be switched off"]) expect(out, hidden).not.toContain(hidden);
  });

  it("flags missing required inputs instead of inventing values", () => {
    const d = fixture();
    const out = html(<SettingsTab ctx={ctxFor({ ...d, config: null, bot: { ...d.bot, configError: "BOT_X_PUT_SHORT_OFFSET is required" } })} />);
    expect(out).toContain("BOT_X_PUT_SHORT_OFFSET is required");
    expect(out).toContain("Set the inputs");
  });
});

describe("Settings slide-over panels", () => {
  it("Bot safeguards: the guide's fields, each with a helper caption, and a single Save", () => {
    const out = html(<SafeguardsDrawer ctx={ctxFor(fixture())} onClose={() => undefined} />);
    for (const text of ["Bot safeguards", "Allocation", "Total capital to open positions.", "Daily positions", "Max positions opened in one day.", "10 per day", "Position limit", "Max open positions at one time.", "1 position", "Day trading", "Allowed", "Not allowed", "Save"]) {
      expect(out, text).toContain(text);
    }
    expect(out).toContain('role="dialog"'); // a slide-over, not a page
    expect(out).toContain('value="20000"');
  });

  it("Bot safeguards: keeps an unusual current value selectable", () => {
    const d = fixture();
    const out = html(<SafeguardsDrawer ctx={ctxFor({ ...d, limits: { ...d.limits, dailyNewPositionLimit: 7 } })} onClose={() => undefined} />);
    expect(out).toContain("7 per day");
  });

  it("an empty bot's Bot inputs keeps the name, account and allocation it was created with, and leaves the strike inputs blank", () => {
    const d = fixture();
    const empty = { ...d, config: null, bot: { ...d.bot, name: "Blank", accountId: "paper-2", allocation: 1500, draft: { name: "Blank", accountId: "paper-2", allocationLimit: 1500 } } };
    const out = html(<InputsDrawer ctx={ctxFor(empty)} onClose={() => undefined} />);
    expect(out).toContain('value="Blank"');
    expect(out).toContain('value="paper-2"');
    expect(out).toContain('value="1500"');
    expect(out.match(/placeholder="required"/g)).toHaveLength(3); // put offset, call offset, expected credit
  });

  it("Bot inputs opens as a slide-over with the required offsets blank when unset", () => {
    const d = fixture();
    const out = html(<InputsDrawer ctx={ctxFor({ ...d, config: null })} onClose={() => undefined} />);
    expect(out).toContain("Bot inputs");
    expect(out).toContain('placeholder="required"');
    expect(out).toContain("Save");
  });


});
