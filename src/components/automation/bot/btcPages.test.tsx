import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BTC_BOT_ID } from "@/lib/automation/bots";
import { computeStats } from "@/lib/automation/pnl";
import { buildPosition } from "@/lib/automation/testSupport";
import { DEFAULT_ALERTS, type Decision, type Position } from "@/lib/automation/types";
import type { BotContext } from "./BotDetail";
import { DashboardTab } from "./DashboardTab";
import { LogTab } from "./LogTab";
import { SafeguardsDrawer, SettingsTab } from "./SettingsTab";
import { btcActivity, btcSide, btcToastSuffix, howClosed, systemEntryLabel } from "./btcWording";
import type { BotDetailData } from "./model";

/**
 * The BTC Bybit Bot's pages speak plainly: a trade is a long or a short (never a spread), the Log names what the bot did on its own by how it happened, the Dashboard shows
 * cents, and the Safeguards card shows the real Bybit daily loss limit. Display only: these tests render the pages and read the words; nothing here trades.
 */

const NOW = Date.UTC(2026, 10, 9, 18, 0);
const MIN = 60_000;

/** A Bybit trade as the engine stores it: a long is a "short put spread", a short a "short call spread". */
const trade = (id: string, side: "long" | "short", over: Partial<Position> = {}): Position =>
  buildPosition({
    id,
    botId: BTC_BOT_ID,
    underlying: "BTC",
    venue: "bybit",
    type: side === "long" ? "short_put_spread" : "short_call_spread",
    status: "closed",
    requestedQuantity: 1,
    filledQuantity: 1,
    credit: 0.75,
    closePrice: 0.75,
    openedAt: NOW - 60 * MIN,
    closedAt: NOW - 30 * MIN,
    ...over,
  });

const decision = (over: Partial<Decision> & { id: string; outcome: Decision["outcome"] }): Decision => ({
  signalId: null,
  botId: BTC_BOT_ID,
  reason: "because",
  detail: {},
  createdAt: NOW - 5 * MIN,
  ...over,
});

const paid = (pl: number) => ({ settlement: { kind: "broker" as const, pl, at: NOW } });

function btcFixture(over: Partial<BotDetailData> = {}): BotDetailData {
  const positions = [
    trade("p-open", "short", { status: "open", closedAt: null, closePrice: null, openedAt: NOW - 2 * MIN }),
    trade("p-tp", "short", { closeReason: "take_profit", ...paid(0.72) }),
    trade("p-sl", "long", { closeReason: "stop_loss", ...paid(-0.34) }),
    trade("p-be", "long", { status: "open", closedAt: null, closePrice: null, breakevenStop: { price: 75_000, at: NOW - 10 * MIN } }),
    trade("p-flip", "short", { closeReason: "signal_flip", ...paid(-0.03) }),
  ];
  return {
    now: NOW,
    bot: {
      id: BTC_BOT_ID,
      name: "BTC Bybit Bot",
      builtIn: true,
      missingSettings: null,
      enabled: true,
      archived: false,
      needsAttention: false,
      needsAttentionReason: null,
      configError: null,
      draft: null,
      accountId: "bybit-demo",
      allocation: 2000,
      group: null,
      tags: [],
      notes: "",
      triggers: { bullish: true, bearish: true },
      alerts: { ...DEFAULT_ALERTS },
      safeguards: {},
      logClearedAt: 0,
      dailyResetAt: 0,
    },
    config: {
      id: BTC_BOT_ID,
      name: "BTC Bybit Bot",
      accountId: "bybit-demo",
      underlying: "BTC",
      quantity: 1,
      widthPoints: 10,
      strikeIncrement: 5,
      putShortOffset: -0.01,
      callShortOffset: 0.01,
      allocationLimit: 2000,
      openingCreditEstimate: 3.5,
    },
    limits: {
      maxPositionsPerType: 1,
      dayTradingAllowed: true,
      totalPositionLimit: 1,
      dailyNewPositionLimit: 10,
      dailyLossLimit: 0, // the engine's own limit is off for this bot ...
      brokerDailyLossLimit: 10, // ... the real one is Bybit's
      errorFailsafeThreshold: 10,
      dedupeWindowSeconds: 120,
      flipCooldownSeconds: 0,
      orderFillTimeoutSeconds: 120,
      closeConfirmTimeoutSeconds: 120,
      hours: { start: "00:00", end: "23:59", timezone: "America/New_York" },
      dryRun: false,
    },
    counts: { errorsToday: 0, newPositionsToday: 3, activePositions: 1 },
    dayLoss: { limit: 10, realized: 0.37, closedToday: 3, unpriced: 0, lastCheck: null, afterFees: true },
    capital: { allocation: 2000, atRisk: 0, available: 2000, netLiquid: 2000.35 },
    stats: computeStats(positions),
    mockPricing: false,
    options: { accounts: [], groups: [] },
    positions,
    orders: [],
    signals: [],
    runs: [],
    decisions: [],
    ...over,
  };
}

function ctxFor(data: BotDetailData): BotContext {
  return { data, reload: vi.fn(), notify: vi.fn(), patch: vi.fn(async () => true), navigate: vi.fn(), openRun: vi.fn(), viewPosition: vi.fn(), focusPositionId: null, clearFocusPosition: vi.fn() };
}

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const text = (out: string) => out.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 1. Activity feed
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("Activity feed: plain BTC wording", () => {
  const feed = (decisions: Decision[]) => text(html(<DashboardTab ctx={ctxFor(btcFixture({ decisions }))} />));

  it("an open is 'Opened short' / 'Opened long', a close says how it ended, a breakeven move is 'Breakeven stop'", () => {
    const out = feed([
      decision({ id: "d6", outcome: "closed", signalId: "sig-9", detail: { positionId: "p-flip" }, createdAt: NOW - 1 * MIN }),
      decision({ id: "d5", outcome: "breakeven_stop", reason: "The stop loss was moved to 75,000.", detail: { positionId: "p-be" }, createdAt: NOW - 2 * MIN }),
      decision({ id: "d4", outcome: "closed", detail: { positionId: "p-sl", sync: true, closeReason: "stop_loss" }, createdAt: NOW - 3 * MIN }),
      decision({ id: "d3", outcome: "closed", detail: { positionId: "p-tp", sync: true, closeReason: "take_profit" }, createdAt: NOW - 4 * MIN }),
      decision({ id: "d2", outcome: "opened", signalId: "sig-8", detail: { positionId: "p-open" }, createdAt: NOW - 5 * MIN }),
      decision({ id: "d1", outcome: "opened", signalId: "sig-7", detail: { positionId: "p-be" }, createdAt: NOW - 6 * MIN }),
    ]);
    for (const line of ["Opened short", "Opened long", "Closed short, take profit", "Closed long, stop loss", "Closed short, signal flip", "Breakeven stop"]) {
      expect(out, line).toContain(line);
    }
  });

  it("never calls a BTC trade a spread, and shows no strikes", () => {
    const out = feed([
      decision({ id: "d2", outcome: "opened", signalId: "sig-8", detail: { positionId: "p-open" } }),
      decision({ id: "d1", outcome: "closed", detail: { positionId: "p-tp", closeReason: "take_profit" }, createdAt: NOW - 6 * MIN }),
    ]);
    expect(out).not.toMatch(/spread/i);
    expect(out).not.toMatch(/Short (call|put)/);
  });

  it("a long and a short are told apart (the stored 'put spread' is a long, the 'call spread' a short)", () => {
    expect(btcSide("short_put_spread")).toBe("long");
    expect(btcSide("short_call_spread")).toBe("short");
  });

  it("a refusal about a BTC trade keeps its own label and reason, with the side", () => {
    const out = feed([decision({ id: "d1", outcome: "close_rejected", reason: "Bybit would not take the order.", detail: { positionId: "p-open" } })]);
    expect(out).toContain("Close rejected: short");
    expect(out).toContain("Bybit would not take the order.");
  });

  it("the option bots are unchanged: a spread is still named with its strikes", () => {
    const spread = buildPosition({ id: "p-opt", botId: "ndx_ema_bias", underlying: "NDX", type: "short_put_spread", status: "open", shortStrike: 19_000, longStrike: 18_995 });
    const d = btcFixture({ positions: [spread], decisions: [decision({ id: "d1", outcome: "opened", signalId: "s", detail: { positionId: "p-opt" } })], config: { ...btcFixture().config!, underlying: "NDX" } });
    const out = text(html(<DashboardTab ctx={ctxFor(d)} />));
    expect(out).toContain("Opened position: Short put spread 19000/18995");
  });

  it("the unit helpers: close wording by how it ended, and the pop-up suffix", () => {
    const short = { type: "short_call_spread" as const, closeReason: "take_profit" as const };
    expect(btcActivity({ outcome: "opened", reason: "x" }, short, "Opened position").title).toBe("Opened short");
    expect(btcActivity({ outcome: "closed", reason: "x" }, short, "Closed position").title).toBe("Closed short, take profit");
    expect(btcActivity({ outcome: "closed", reason: "x" }, { type: "short_put_spread" }, "Closed position").title).toBe("Closed long");
    expect(btcToastSuffix({ outcome: "opened" }, short)).toBe(" - short");
    expect(btcToastSuffix({ outcome: "breakeven_stop" }, short)).toBe("");
    expect(howClosed("not_a_known_code")).toBe("Not a known code");
    expect(howClosed(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 2. Log tab
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("Log tab: what the bot did on its own is named by how it happened", () => {
  const names = (decisions: Decision[]) => html(<LogTab ctx={ctxFor(btcFixture({ decisions }))} />);

  it("Take profit, Stop loss, Breakeven stop and Signal flip, not 'Manual close' or 'Manual position'", () => {
    const out = names([
      decision({ id: "a", outcome: "closed", reason: "Closed at Bybit by its take profit at 75,262.70.", detail: { positionId: "p-tp", sync: true, closeReason: "take_profit" }, createdAt: NOW - 1 * MIN }),
      decision({ id: "b", outcome: "closed", reason: "Closed at Bybit by its stop loss at 74,600.", detail: { positionId: "p-sl", sync: true, closeReason: "stop_loss" }, createdAt: NOW - 2 * MIN }),
      decision({ id: "c", outcome: "breakeven_stop", reason: "The stop loss was moved to 75,000.", detail: { positionId: "p-be", from: 74_700, to: 75_000 }, createdAt: NOW - 3 * MIN }),
      decision({ id: "d", outcome: "closed", reason: "Closed at Bybit by a signal flip.", detail: { positionId: "p-flip", repaired: true, closeReason: "signal_flip" }, createdAt: NOW - 4 * MIN }),
    ]);
    for (const name of ["Take profit", "Stop loss", "Breakeven stop", "Signal flip"]) expect(out, name).toContain(`>${name}<`);
    expect(out).not.toContain("Manual close");
    expect(out).not.toContain("Manual position");
  });

  it("the bot's own entries count as System, not Manual, and the detail says they were automatic", () => {
    const out = names([decision({ id: "a", outcome: "closed", detail: { positionId: "p-tp", sync: true, closeReason: "take_profit" } })]);
    expect(out).toContain(">System</option>");
    expect(systemEntryLabel(decision({ id: "a", outcome: "closed", detail: { closeReason: "take_profit" } }))).toBe("Take profit");
  });

  it("the daily loss limit, kill switch and breakeven close the risk monitor makes are named for what they are too", () => {
    expect(systemEntryLabel(decision({ id: "a", outcome: "closed", detail: { risk: "daily_limit", positionId: "p" } }))).toBe("Daily loss limit");
    expect(systemEntryLabel(decision({ id: "b", outcome: "daily_loss_limit_reached", detail: { risk: "daily_limit" } }))).toBe("Daily loss limit");
    expect(systemEntryLabel(decision({ id: "c", outcome: "kill_switch", detail: { risk: "kill_switch" } }))).toBe("Kill switch");
    expect(systemEntryLabel(decision({ id: "d", outcome: "closed", detail: { risk: "breakeven_close" } }))).toBe("Breakeven close");
  });

  it("a failed check of Bybit's positions is 'Broker check', not a manual position", () => {
    expect(systemEntryLabel(decision({ id: "a", outcome: "executor_error", detail: { sync: true } }))).toBe("Broker check");
    const out = names([decision({ id: "a", outcome: "executor_error", reason: "Could not check the broker for trades it closed by itself: fetch failed", detail: { sync: true } })]);
    expect(out).toContain(">Broker check<");
    expect(out).not.toContain("Manual position");
  });

  it("a close a person pressed on the site is still 'Manual close', and a position placed by hand 'Manual position'", () => {
    expect(systemEntryLabel(decision({ id: "a", outcome: "closed", detail: { manual: true, positionId: "p", closeReason: "manual" } }))).toBeNull();
    const out = names([
      decision({ id: "a", outcome: "closed", reason: "Close order filled.", detail: { manual: true, positionId: "p-tp" }, createdAt: NOW - 1 * MIN }),
      decision({ id: "b", outcome: "opened", reason: "Opened new position.", detail: { manual: true, positionId: "p-open" }, createdAt: NOW - 2 * MIN }),
    ]);
    expect(out).toContain(">Manual close<");
    expect(out).toContain(">Manual position<");
  });

  it("an entry that is not the bot's own keeps its old name (nothing else changed)", () => {
    expect(systemEntryLabel(decision({ id: "a", outcome: "invalid_strikes" }))).toBeNull();
    expect(systemEntryLabel(decision({ id: "b", outcome: "executor_error", detail: { reconcile: [] } }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 3. Dashboard figures in cents
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("Dashboard: the BTC bot's figures show cents", () => {
  const out = () => text(html(<DashboardTab ctx={ctxFor(btcFixture())} />));

  it("closed P/L, average P/L, average win and average loss are not rounded to whole dollars", () => {
    const stats = computeStats(btcFixture().positions);
    // Wins +0.72, losses -0.34 and -0.03: the closed P/L is +0.35 and the average win +0.72.
    expect(stats.closedPL).toBeCloseTo(0.35, 2);
    expect(stats.avgWin).toBeCloseTo(0.72, 2);
    const page = out();
    expect(page).toContain("+$0.35"); // Closed P/L
    expect(page).toContain("+$0.72"); // Avg win
    expect(page).toContain("-$0.19"); // Avg loss: (-0.34 - 0.03) / 2 = -0.185
    expect(page).toContain("+$0.12"); // Avg P/L: 0.35 / 3
    expect(page).not.toMatch(/\+\$1\b/);
  });

  it("the max drawdown and the capital rows show cents too", () => {
    const page = out();
    expect(page).toContain("$0.37"); // drawdown: 0.72 down to 0.38 then 0.35 = 0.37
    expect(page).toContain("$2,000.35"); // Net liquid
    expect(page).toContain("$2,000.00"); // Allocation
  });

  it("the option bots keep whole dollars", () => {
    const d = btcFixture({ config: { ...btcFixture().config!, underlying: "NDX" } });
    const page = text(html(<DashboardTab ctx={ctxFor(d)} />));
    expect(page).toContain("+$0");
    expect(page).not.toContain("+$0.72");
    expect(page).toContain("$2,000");
    expect(page).not.toContain("$2,000.00");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 4. Settings, Safeguards
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("Settings > Safeguards: the real Bybit daily loss limit", () => {
  it("shows $10.00, not 'Off', and today's result after fees", () => {
    const page = text(html(<SettingsTab ctx={ctxFor(btcFixture())} />));
    expect(page).toMatch(/Daily loss limit\s*\$10\.00/);
    expect(page).not.toMatch(/Daily loss limit\s*Off/);
    expect(page).toContain("Today: realized +$0.37 after fees (3 closed or expired)");
  });

  it("explains where the limit is set, and tells the editor not to fill the engine's field", () => {
    const d = btcFixture();
    const drawer = text(html(<SafeguardsDrawer ctx={ctxFor(d)} onClose={() => undefined} />));
    expect(drawer).toContain("Bybit's own limit, $10.00 (DAILY_MAX_LOSS_USD");
    expect(drawer).toContain("Leave this blank");
  });

  it("a bot with no Bybit limit still shows its own: Off when unset, and the engine's wording in the editor", () => {
    const d = btcFixture({ limits: { ...btcFixture().limits, brokerDailyLossLimit: null }, dayLoss: { limit: 0, realized: 0, closedToday: 0, unpriced: 0, lastCheck: null } });
    const page = text(html(<SettingsTab ctx={ctxFor(d)} />));
    expect(page).toMatch(/Daily loss limit\s*Off/);
    expect(page).not.toContain("after fees");
    expect(text(html(<SafeguardsDrawer ctx={ctxFor(d)} onClose={() => undefined} />))).toContain("Blank uses the DAILY_LOSS_LIMIT setting");
  });

  it("the Daily positions help says what really happens at the limit (a flip is one, the bot switches itself off)", () => {
    const page = html(<SettingsTab ctx={ctxFor(btcFixture())} />);
    const tip = /Each new open counts once: a flip is one[^"]*switches itself off until you switch it back on/;
    expect(page).toMatch(tip);
  });

  it("a Bybit limit of $25 is shown as $25.00 (it follows the setting, it is not fixed at $10)", () => {
    const d = btcFixture({ limits: { ...btcFixture().limits, brokerDailyLossLimit: 25 }, dayLoss: { ...btcFixture().dayLoss, limit: 25 } });
    expect(text(html(<SettingsTab ctx={ctxFor(d)} />))).toMatch(/Daily loss limit\s*\$25\.00/);
  });
});
