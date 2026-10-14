import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusView, type StatusResponse } from "./StatusDashboard";
import { AccountsSection, type SettingsData } from "./settings/sections";

// How the screens describe the IBKR bridge: paper is calm and allows test alerts, real money is red and refuses them, and nothing
// still says "Tradier" about an IBKR account.

const noop = () => undefined;
type Executor = StatusResponse["executor"];
const BRIDGE = "https://bridge.example.test";
const paper: Executor = { kind: "ibkr", venue: "ibkr", error: null, baseUrl: BRIDGE, sandbox: true, priceSource: "feed", dryRun: false, testMode: false };
const live: Executor = { ...paper, sandbox: false };

const status = (executor: Executor): StatusResponse => ({
  now: Date.UTC(2026, 9, 6, 14, 40),
  executor,
  bots: [{ id: "ndx_ema_bias", name: "NDX Bias Bot", underlying: "NDX", enabled: true, needsAttention: false, needsAttentionReason: null, configError: null, missingSettings: null, errorCountToday: 0, errorFailsafeThreshold: 10, newPositionsToday: 0, dailyNewPositionLimit: 10, activePositionCount: 0, closedPositionCount: 0, totalPositionLimit: 1, suggestedPrice: 21_003.7, allocation: null, atRisk: 0, available: null, settings: null }],
  positions: [],
  orders: [],
  signals: [],
  alerts: [],
  alertEmail: { enabled: false, to: null },
});
const dashboard = (executor: Executor, reconcile?: Parameters<typeof StatusView>[0]["reconcile"]) =>
  renderToStaticMarkup(<StatusView data={status(executor)} busyBot={null} results={{}} onToggle={noop} onSend={noop} onReset={noop} reconcile={reconcile} />);

describe("the status banner on IBKR", () => {
  it("paper says Interactive Brokers PAPER and shows the bridge address; no Tradier wording", () => {
    const out = dashboard(paper);
    expect(out).toContain("Interactive Brokers PAPER (paper money)");
    expect(out).toContain(BRIDGE);
    expect(out).not.toContain("Tradier");
    expect(out).not.toContain("LIVE");
    expect(out).not.toContain("Mock executor");
  });

  it("real money is the red LIVE banner", () => {
    const out = dashboard(live);
    expect(out).toContain("LIVE — Interactive Brokers: real money");
    expect(out).toContain("bg-down-soft");
    expect(out).not.toContain("Tradier");
  });

  it("test alerts are offered on paper and refused on real money; Reset test data is for the simulation only", () => {
    expect(dashboard(paper)).not.toContain("Test alerts never run against real money");
    expect(dashboard(live)).toContain("Test alerts never run against real money: they need the mock executor or a paper broker account.");
    expect(dashboard(paper)).not.toContain("Reset test data");
  });

  it("a bridge that isn't set up is shown as an error", () => {
    expect(dashboard({ kind: "ibkr", venue: "ibkr", error: "BROKER=ibkr cannot start - required settings not set: BRIDGE_URL, BRIDGE_SECRET.", dryRun: false, testMode: false })).toContain("signals are refused until this is fixed");
  });

  it("the broker check is offered, and says which account it compares with", () => {
    const out = dashboard(paper, { report: null, busy: false, error: null, onRun: noop });
    expect(out).toContain("Check broker positions");
    expect(out).toContain("the Interactive Brokers account");
    expect(out).toContain("never opens or closes anything");
    expect(dashboard(paper)).not.toContain("Check broker positions"); // only when the page supplies the check
  });
});

const settings = (executor: SettingsData["executor"]): SettingsData => ({
  settings: { tradingWindow: null, emailAlerts: { enabled: false, to: "", onTrade: true, onWarningError: true, includeTest: true }, notifications: { trades: false, warnings: true }, sessionTimeoutMinutes: 60 },
  window: { start: "09:35", end: "15:55", source: "environment", timezone: "America/New_York" },
  email: { enabled: false, to: null, senderWired: false },
  sessionTimeoutChoices: [30, 60, 120],
  signInRequired: true,
  executor,
  accounts: [{ id: "paper-ndx", bots: ["NDX Bias Bot"] }],
  webhook: { path: "/api/webhook/tradingview", secretSet: true, bots: [] },
});

describe("Settings → Accounts on IBKR", () => {
  it("names the paper account, the bridge address and where prices come from", () => {
    const out = renderToStaticMarkup(<AccountsSection data={settings({ ...paper })} />);
    expect(out).toContain("Interactive Brokers paper account, through the bridge");
    expect(out).toContain(BRIDGE);
    expect(out).toContain("From the public feed");
    expect(out).toContain("Live orders");
    expect(out).not.toContain("Tradier");
    expect(out).not.toContain("not connected to any account");
  });

  it("says when prices come from the broker, and calls a real-money account LIVE", () => {
    expect(renderToStaticMarkup(<AccountsSection data={settings({ ...paper, priceSource: "broker" })} />)).toContain("From the broker (the bridge)");
    expect(renderToStaticMarkup(<AccountsSection data={settings({ ...live })} />)).toContain("Interactive Brokers LIVE account, through the bridge");
  });

  it("an unusable bridge is shown as not usable, with the reason", () => {
    const out = renderToStaticMarkup(<AccountsSection data={settings({ kind: "ibkr", venue: "ibkr", error: "BRIDGE_URL must be https (plain http is only allowed for localhost).", dryRun: false, testMode: false })} />);
    expect(out).toContain("Not usable: BRIDGE_URL must be https");
  });

  it("the internal simulation still says nothing is connected", () => {
    const out = renderToStaticMarkup(<AccountsSection data={settings({ kind: "mock", venue: "mock", error: null, dryRun: false, testMode: true })} />);
    expect(out).toContain("Mock - test trades only");
    expect(out).toContain("not connected to any account");
  });
});
