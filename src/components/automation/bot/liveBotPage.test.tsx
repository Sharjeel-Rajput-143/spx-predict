import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LIVE_BOT_ID } from "@/lib/automation/bybitLiveLimits";
import type { BybitView, HistoryRow } from "@/lib/automation/bybitView";
import { computeStats } from "@/lib/automation/pnl";
import { DEFAULT_ALERTS } from "@/lib/automation/types";
import type { Reply } from "../BybitPanel";
import { BTC_LABEL, BtcTradesBody, BtcTradesView, LIVE_LABEL, bybitReplyUrl } from "../BtcTrades";
import type { BotContext } from "./BotDetail";
import { DashboardTab } from "./DashboardTab";
import { LogTab } from "./LogTab";
import type { BotDetailData } from "./model";
import { PositionsTab } from "./PositionsTab";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LIVE_RUN_REFUSAL, canRunByHand } from "@/lib/automation/liveRunRule";
import { SafeguardsDrawer, SettingsTab, TriggerDrawer } from "./SettingsTab";

/**
 * THE LIVE BOT'S TABS SHOW LIVE DATA ONLY (Dashboard, Positions, Log, Settings). Display only: these render the pages and read the words. The bot's own data is scoped by the bot on the
 * server (liveBotScope.test.ts); here: the Positions tab asks for the LIVE account (never the demo's), says "no live trades yet" when there is nothing, and no tab of the live bot says
 * demo or paper money or points at .env.local for the live limit.
 */

const NOW = Date.UTC(2026, 10, 10, 18, 0);
const T = NOW;
const row = (over: Partial<HistoryRow> = {}): HistoryRow => ({ orderId: "l1", side: "Long", size: 0.001, entryPrice: 74_901.4, exitPrice: 75_112.8, pnl: -0.29, pnlPercent: -0.39, fees: 0.08, openFee: 0.04, closeFee: 0.04, grossPnl: -0.21, leverage: 10, entryValue: 74.9, exitValue: 75.1, openedAt: T - 60_000, closedBy: "stop_loss", byBot: true, manual: false, closedAt: T, ...over });
const view = (history: HistoryRow[] = [row()]): BybitView =>
  ({ symbol: "BTCUSDT", positionSize: 0.001, mode: "24 hours a day, every day", killSwitch: false, open: null, openError: null, mismatch: null, history, historyError: null, closed: [], closedCount: 0, totals: { day: "2026-11-10", dayResult: 0, realizedToday: 0, openLoss: 0, running: 0, limit: 2, room: 2, reached: false, tripped: false }, asOf: NOW }) as unknown as BybitView;

describe("where the Positions tab reads its BTC trades", () => {
  it("the live bot reads the live account's route, the demo bot the demo account's: never crossed", () => {
    expect(bybitReplyUrl(true)).toBe("/api/automation/live/trades");
    expect(bybitReplyUrl(false)).toBe("/api/automation/bybit");
    expect(bybitReplyUrl(true)).not.toBe(bybitReplyUrl(false));
  });
});

describe("the live bot's Positions tab", () => {
  it("with no live key: 'No live trades yet', and nothing about demo or paper money", () => {
    const reply: Reply = { active: false, noKey: true, reason: "no key" };
    const html = renderToStaticMarkup(<BtcTradesBody reply={reply} error={null} live />);
    expect(html).toContain("No live trades yet");
    expect(html).toContain('data-testid="live-no-trades"');
    expect(html).not.toMatch(/demo|paper/i);
    expect(html).not.toContain("btc-trades"); // no trades table at all
  });

  it("with a live key and no trades: the live account, 'No live trades yet', flat", () => {
    const html = renderToStaticMarkup(<BtcTradesBody reply={{ active: true, view: view([]) }} error={null} live />);
    expect(html).toContain(LIVE_LABEL);
    expect(html).toContain("No live trades yet");
    expect(html).toContain("The Bybit live account is flat");
    expect(html).not.toMatch(/demo|paper/i);
  });

  it("with live trades: labelled LIVE and real money, never demo or paper money", () => {
    const html = renderToStaticMarkup(<BtcTradesView v={view()} live />);
    expect(html).toContain(LIVE_LABEL);
    expect(html).toContain("real money");
    expect(html).toContain("Live bot trades");
    expect(html).toContain("74,901.40");
    expect(html).not.toMatch(/demo|paper/i);
    expect(html).not.toContain(BTC_LABEL);
  });

  it("the demo bot's tab is unchanged: demo label, paper money", () => {
    const html = renderToStaticMarkup(<BtcTradesView v={view()} />);
    expect(html).toContain(BTC_LABEL);
    expect(html).toContain("paper money");
    expect(html).not.toContain(LIVE_LABEL);
  });

  it("a read error on the live account is shown as an error, not as demo data", () => {
    const html = renderToStaticMarkup(<BtcTradesBody reply={null} error="Could not read Bybit." live />);
    expect(html).toContain("Could not read Bybit.");
    expect(html).not.toMatch(/demo|paper/i);
  });
});

// The Positions tab hands the live flag to the trades card: only the live bot's page reads the live account.
const seen: boolean[] = [];
vi.mock("../BtcTrades", async (orig) => {
  const real = await orig<typeof import("../BtcTrades")>();
  return {
    ...real,
    BtcTrades: ({ live }: { live?: boolean }) => {
      seen.push(live === true);
      return null;
    },
  };
});

function dataFor(id: string): BotDetailData {
  return {
    now: NOW,
    bot: { id, name: id === LIVE_BOT_ID ? "BTC Bybit Live Bot" : "BTC Bybit Bot", builtIn: true, missingSettings: null, enabled: false, archived: false, needsAttention: false, needsAttentionReason: null, configError: null, draft: null, accountId: id === LIVE_BOT_ID ? "bybit-live" : "bybit-demo", allocation: 2000, group: null, tags: [], notes: "", triggers: { bullish: true, bearish: true }, alerts: { ...DEFAULT_ALERTS }, safeguards: {}, logClearedAt: 0, dailyResetAt: 0 },
    config: { id, name: "BTC", accountId: "x", underlying: "BTC", quantity: 1, widthPoints: 10, strikeIncrement: 5, putShortOffset: -0.01, callShortOffset: 0.01, allocationLimit: 2000, openingCreditEstimate: 3.5 },
    limits: { maxPositionsPerType: 1, dayTradingAllowed: true, totalPositionLimit: 1, dailyNewPositionLimit: 5, dailyLossLimit: 0, brokerDailyLossLimit: id === LIVE_BOT_ID ? 2 : 10, errorFailsafeThreshold: 10, dedupeWindowSeconds: 120, flipCooldownSeconds: 0, orderFillTimeoutSeconds: 120, closeConfirmTimeoutSeconds: 120, hours: { start: "00:00", end: "23:59", timezone: "America/New_York" }, dryRun: false },
    counts: { errorsToday: 0, newPositionsToday: 0, activePositions: 0 },
    dayLoss: { limit: id === LIVE_BOT_ID ? 2 : 10, realized: 0, closedToday: 0, unpriced: 0, lastCheck: null, afterFees: true },
    capital: { allocation: 2000, atRisk: 0, available: 2000, netLiquid: 2000 },
    stats: computeStats([]),
    mockPricing: false,
    options: { accounts: [], groups: [] },
    positions: [],
    orders: [],
    signals: [],
    runs: [],
    decisions: [],
  } as unknown as BotDetailData;
}
const ctxFor = (data: BotDetailData): BotContext => ({ data, reload: () => undefined, notify: () => undefined, patch: async () => true, focusPositionId: null, clearFocusPosition: () => undefined }) as unknown as BotContext;
const text = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the live bot's four tabs", () => {
  it("Positions: the live bot's page asks for the live account; the demo bot's page does not", () => {
    seen.length = 0;
    renderToStaticMarkup(<PositionsTab ctx={ctxFor(dataFor(LIVE_BOT_ID))} />);
    expect(seen).toEqual([true]);
    seen.length = 0;
    renderToStaticMarkup(<PositionsTab ctx={ctxFor(dataFor("btc_bybit"))} />);
    expect(seen).toEqual([false]);
  });

  it("Dashboard and Log with the live bot's own (empty) records say nothing about demo or paper money", () => {
    const d = dataFor(LIVE_BOT_ID);
    for (const html of [renderToStaticMarkup(<DashboardTab ctx={ctxFor(d)} />), renderToStaticMarkup(<LogTab ctx={ctxFor(d)} />)]) {
      // (the Dashboard's generic note about the mock executor says "for demos" about simulated pricing; it is not about the Bybit demo account)
      expect(text(html)).not.toMatch(/bybit demo|demo account|paper money/i);
    }
  });

  it("Settings: the live bot's daily loss limit is the LIVE one, set on the Live page, not 'DAILY_MAX_LOSS_USD in .env.local'", () => {
    const live = text(renderToStaticMarkup(<SettingsTab ctx={ctxFor(dataFor(LIVE_BOT_ID))} />));
    expect(live).toContain("$2.00");
    expect(live).not.toContain("DAILY_MAX_LOSS_USD");
    expect(live).not.toMatch(/bybit demo|demo account|paper money/i);
    const drawer = text(renderToStaticMarkup(<SafeguardsDrawer ctx={ctxFor(dataFor(LIVE_BOT_ID))} onClose={() => undefined} />));
    expect(drawer).toContain("live daily loss limit");
    expect(drawer).toContain("Live page");
    expect(drawer).not.toContain("DAILY_MAX_LOSS_USD");
  });

  it("Settings: the demo bot still points at DAILY_MAX_LOSS_USD (unchanged)", () => {
    const demo = text(renderToStaticMarkup(<SafeguardsDrawer ctx={ctxFor(dataFor("btc_bybit"))} onClose={() => undefined} />));
    expect(demo).toContain("DAILY_MAX_LOSS_USD");
  });
});

describe("the Run buttons: hidden for the live bot everywhere, unchanged for the demo bot", () => {
  const withRun = (id: string) => ({ ...ctxFor(dataFor(id)), openRun: () => undefined }) as BotContext;
  it("the rule: only the live bot is excluded", () => {
    expect(canRunByHand(LIVE_BOT_ID)).toBe(false);
    for (const id of ["btc_bybit", "ndx_ema_bias", "spx_ema_bias", "anything_else"]) expect(canRunByHand(id), id).toBe(true);
    expect(LIVE_RUN_REFUSAL).toMatch(/cannot be run by hand/);
  });
  it("Settings: the live bot's Automations card has no Run button; the demo bot's still has it", () => {
    const live = text(renderToStaticMarkup(<SettingsTab ctx={withRun(LIVE_BOT_ID)} />));
    const demo = text(renderToStaticMarkup(<SettingsTab ctx={withRun("btc_bybit")} />));
    expect(live).toContain("Add automation");
    expect(live).not.toMatch(/\bRun\b/);
    expect(demo).toMatch(/\bRun\b/);
  });
  it("the trigger drawer: no 'Run this trigger now' for the live bot, still there for the demo bot", () => {
    for (const dir of ["bullish", "bearish"] as const) {
      expect(text(renderToStaticMarkup(<TriggerDrawer dir={dir} ctx={withRun(LIVE_BOT_ID)} onClose={() => undefined} />))).not.toContain("Run this trigger now");
      expect(text(renderToStaticMarkup(<TriggerDrawer dir={dir} ctx={withRun("btc_bybit")} onClose={() => undefined} />))).toContain("Run this trigger now");
    }
  });
  it("every place that can start a run is behind the rule: the trigger menu, the Automations card, the trigger drawer, the bot menu and the page's own openRun", () => {
    const settings = readFileSync(path.join(__dirname, "SettingsTab.tsx"), "utf8");
    const detail = readFileSync(path.join(__dirname, "BotDetail.tsx"), "utf8");
    expect(settings).toContain("{canRunByHand(data.bot.id) && <MenuItem onClick={() => { close(); openRun(dir); }}>Run now...</MenuItem>}");
    expect(settings.match(/canRunByHand\(data\.bot\.id\)/g)).toHaveLength(3);
    expect(settings.match(/openRun\(/g)).toHaveLength(3); // the three guarded call sites, and no other
    expect(detail).toContain("{canRunByHand(bot.id) && <MenuItem onClick={() => { close(); setRun({}); }}>Run automation</MenuItem>}");
    expect(detail).toContain("if (canRunByHand(bot.id)) setRun({ signal });");
    expect(detail.match(/setRun\(/g)).toHaveLength(3); // the declaration's setter use in the bot menu and openRun, plus the modal's close
  });
});

describe("the pullback exit card on the demo bot's Settings tab", () => {
  const pullback = { enabled: true, fallUsd: 0.03, minPeakUsd: 0.12, chainEnabled: false, chainStopUsd: 0.03, chainMax: 10 };
  const demoData = (pb: typeof pullback) => ({ ...dataFor("btc_bybit"), bot: { ...dataFor("btc_bybit").bot, pullback: pb } }) as BotDetailData;
  it("shows the minimum peak that is in force ($0.12 by default), in a box that can be changed and saved", () => {
    const html = renderToStaticMarkup(<SettingsTab ctx={ctxFor(demoData(pullback))} />);
    expect(html).toMatch(/aria-label="Minimum peak in dollars"[^>]*value="0.12"|value="0.12"[^>]*aria-label="Minimum peak in dollars"/);
    expect(text(html)).toContain("Minimum peak ($)");
  });
  it("shows a saved value as saved (0 = no minimum stays 0)", () => {
    const html = renderToStaticMarkup(<SettingsTab ctx={ctxFor(demoData({ ...pullback, minPeakUsd: 0 }))} />);
    expect(html).toMatch(/aria-label="Minimum peak in dollars"[^>]*value="0"|value="0"[^>]*aria-label="Minimum peak in dollars"/);
  });
  it("the live bot's Settings tab has no pullback card", () => {
    expect(renderToStaticMarkup(<SettingsTab ctx={ctxFor(dataFor(LIVE_BOT_ID))} />)).not.toContain("pullback-card");
  });
});

describe("the Settings tab of each Bybit bot (release 9)", () => {
  const pb = { enabled: true, fallUsd: 0.03, minPeakUsd: 0.12, chainEnabled: false, chainStopUsd: 0.03, chainMax: 10 };
  const withPb = (id: string, over: Partial<typeof pb> = {}) => ({ ...dataFor(id), bot: { ...dataFor(id).bot, pullback: { ...pb, ...over } } }) as BotDetailData;
  it("the live bot has the Pullback exit card, marked as the LIVE bot's, with its own value; the demo bot's card is not marked", () => {
    const live = renderToStaticMarkup(<SettingsTab ctx={ctxFor(withPb(LIVE_BOT_ID, { minPeakUsd: 0.4 }))} />);
    const demo = renderToStaticMarkup(<SettingsTab ctx={ctxFor(withPb("btc_bybit"))} />);
    expect(live).toContain('data-testid="pullback-card"');
    expect(live).toContain("pullback-live-chip");
    expect(live).toMatch(/value="0.4"/);
    expect(demo).toContain('data-testid="pullback-card"');
    expect(demo).not.toContain("pullback-live-chip");
    expect(demo).toMatch(/value="0.12"/);
  });
  it("a bot with no pullback data (any other bot) has no card", () => {
    expect(renderToStaticMarkup(<SettingsTab ctx={ctxFor(dataFor("ndx_ema_bias"))} />)).not.toContain("pullback-card");
  });
  it("the daily 'reset' is gone for the live bot (it says the count restarts by itself) and still there for the demo bot", () => {
    const live = renderToStaticMarkup(<SettingsTab ctx={ctxFor(dataFor(LIVE_BOT_ID))} />).replace(/<!-- -->/g, "");
    const demo = renderToStaticMarkup(<SettingsTab ctx={ctxFor(dataFor("btc_bybit"))} />).replace(/<!-- -->/g, "");
    expect(live).toContain('data-testid="no-live-reset"');
    expect(live).toMatch(/restarts by itself on the next New York day \(it cannot be reset\)/);
    expect(text(live)).not.toMatch(/today · reset/);
    expect(demo).not.toContain("no-live-reset");
    expect(text(demo)).toMatch(/today · reset/);
  });
});
