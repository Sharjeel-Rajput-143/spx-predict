import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as botsRoute } from "@/app/api/automation/bots/route";
import { GET as statusRoute } from "@/app/api/automation/status/route";
import { resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "@/lib/automation/testSupport";
import { accountPill, liveChipTip, ordersFooter, routingNote } from "./executorLabels";
import { AccountsSection, type SettingsData } from "./settings/sections";

// No screen goes on calling the executor "mock" after the app is connected to a broker.

setTestBotEnv();
setNdxTestEnv();

const mock = { venue: "mock" as const };
const paper = { venue: "ibkr" as const, sandbox: true, bridgeSymbols: ["NDX"] };
const live = { venue: "ibkr" as const, sandbox: false, bridgeSymbols: ["NDX"] };

describe("the words", () => {
  it("the account label says what the orders really go to", () => {
    expect(accountPill(mock)).toEqual({ text: "Paper · simulation", tone: "warn" });
    expect(accountPill(paper)).toEqual({ text: "Paper · Interactive Brokers (bridge)", tone: "ok" });
    expect(accountPill(live)).toEqual({ text: "LIVE · Interactive Brokers (bridge)", tone: "error" });
    expect(accountPill({ venue: "tradier", sandbox: true }).text).toBe("Paper · Tradier");
    expect(accountPill({ venue: "tradier", sandbox: false })).toEqual({ text: "LIVE · Tradier", tone: "error" });
    expect(accountPill({ venue: null }).text).toBe("Paper · simulation");
    for (const x of [mock, paper, live]) expect(accountPill(x).text).not.toContain("mock");
  });

  it("the routing note says which bots go to the bridge and that the others are simulated - only with a bridge", () => {
    expect(routingNote(paper)).toMatch(/Orders for NDX go to the bridge/);
    expect(routingNote(paper)).toMatch(/SPX\) runs on the internal simulation/);
    expect(routingNote({ ...paper, bridgeSymbols: ["NDX", "SPX"] })).toMatch(/Orders for NDX, SPX go to the bridge/);
    expect(routingNote(mock)).toBeNull();
    expect(routingNote({ venue: "ibkr", bridgeSymbols: [] })).toBeNull();
  });

  it("the line under the bots list and the Live chip's tip follow the executor", () => {
    expect(ordersFooter(null)).toBe("orders go to the internal simulation");
    expect(ordersFooter(mock)).toBe("orders go to the internal simulation");
    expect(ordersFooter(paper)).toBe("NDX orders go to the Interactive Brokers paper account; other bots use the simulation");
    expect(ordersFooter(live)).toBe("NDX orders go to the Interactive Brokers LIVE account; other bots use the simulation");
    expect(ordersFooter({ venue: "tradier", sandbox: true })).toBe("orders go to the Tradier paper account");
    expect(liveChipTip(null)).toMatch(/internal simulation/);
    expect(liveChipTip(paper)).toBe("Interactive Brokers paper account: no real money is involved");
    expect(liveChipTip(live)).toBe("Interactive Brokers LIVE account: real money");
    for (const t of [ordersFooter(mock), ordersFooter(paper), liveChipTip(null), liveChipTip(paper)]) expect(t).not.toMatch(/Phase 1|mock executor/);
  });
});

const settings = (executor: SettingsData["executor"]): SettingsData => ({
  settings: { tradingWindow: null, emailAlerts: { enabled: false, to: "", onTrade: true, onWarningError: true, includeTest: true }, notifications: { trades: false, warnings: true }, sessionTimeoutMinutes: 60 },
  window: { start: "09:35", end: "15:55", source: "environment", timezone: "America/New_York" },
  email: { enabled: false, to: null, senderWired: false },
  sessionTimeoutChoices: [30, 60],
  signInRequired: true,
  executor,
  accounts: [{ id: "paper-1", bots: ["SPX EMA 9/20 Bias"] }, { id: "paper-ndx", bots: ["NDX Bias Bot"] }],
  webhook: { path: "/api/webhook/tradingview", secretSet: true, bots: [] },
});
const accounts = (x: SettingsData["executor"]) => renderToStaticMarkup(<AccountsSection data={settings(x)} />);

describe("Settings > Trading Accounts", () => {
  it("every account row says what the executor really is, never 'mock executor' once a broker is connected", () => {
    const out = accounts({ kind: "ibkr", venue: "ibkr", error: null, baseUrl: "http://localhost:8787", sandbox: true, priceSource: "broker", bridgeSymbols: ["NDX"], dryRun: false, testMode: false });
    expect((out.match(/Paper · Interactive Brokers \(bridge\)/g) ?? []).length).toBe(2); // paper-1 and paper-ndx
    expect(out).not.toContain("Paper · mock executor");
    expect(out).toContain("Orders for NDX go to the bridge");
    expect(out).toContain("SPX) runs on the internal simulation");
  });

  it("with the internal simulation the rows say simulation", () => {
    const out = accounts({ kind: "mock", venue: "mock", error: null, dryRun: false, testMode: true });
    expect((out.match(/Paper · simulation/g) ?? []).length).toBe(2);
    expect(out).not.toContain("mock executor</");
    expect(out).not.toContain("Orders for NDX go to the bridge");
  });

  it("a real-money account is labelled LIVE on its rows", () => {
    expect(accounts({ kind: "ibkr", venue: "ibkr", error: null, baseUrl: "http://localhost:8787", sandbox: false, bridgeSymbols: ["NDX"], dryRun: false, testMode: false })).toContain("LIVE · Interactive Brokers (bridge)");
  });
});

describe("what the server reports", () => {
  beforeEach(() => resetAutomationStores());
  afterEach(() => vi.unstubAllEnvs());

  it("the bots list and the status say which symbols go to the bridge (default NDX, or BRIDGE_SYMBOLS)", async () => {
    vi.stubEnv("BROKER", "ibkr");
    vi.stubEnv("BRIDGE_URL", "https://bridge.example.test");
    vi.stubEnv("BRIDGE_SECRET", "test-bridge-secret-not-real");
    const bots = await (await botsRoute(new NextRequest("http://localhost/api/automation/bots"))).json();
    expect(bots.executor).toEqual({ venue: "ibkr", sandbox: true, bridgeSymbols: ["NDX"] });
    vi.stubEnv("BRIDGE_SYMBOLS", "ndx, spx");
    const status = await (await statusRoute(new NextRequest("http://localhost/api/automation/status"))).json();
    expect(status.executor).toMatchObject({ venue: "ibkr", bridgeSymbols: ["NDX", "SPX"] });
    expect(JSON.stringify(status)).not.toContain("test-bridge-secret-not-real");
  });

  it("with the simulation there is nothing about a bridge", async () => {
    vi.stubEnv("BROKER", "");
    const bots = await (await botsRoute(new NextRequest("http://localhost/api/automation/bots"))).json();
    expect(bots.executor).toMatchObject({ venue: "mock", sandbox: null });
    expect(bots.executor.bridgeSymbols).toBeUndefined();
  });

  it("a bad BRIDGE_SYMBOLS is an error status, not a silent default", async () => {
    vi.stubEnv("BROKER", "ibkr");
    vi.stubEnv("BRIDGE_URL", "https://bridge.example.test");
    vi.stubEnv("BRIDGE_SECRET", "test-bridge-secret-not-real");
    vi.stubEnv("BRIDGE_SYMBOLS", "NDX;SPX");
    const bots = await (await botsRoute(new NextRequest("http://localhost/api/automation/bots"))).json();
    expect(bots.executor.venue).toBe("ibkr");
    const status = await (await statusRoute(new NextRequest("http://localhost/api/automation/status"))).json();
    expect(status.executor.error).toMatch(/BRIDGE_SYMBOLS/);
  });
});

describe("with Bybit as the broker the labels name BTC, never NDX", () => {
  // Whatever symbols a status carries (BRIDGE_SYMBOLS defaults to NDX for the IBKR bridge), Bybit serves the BTC bot only.
  const bybit = { venue: "bybit" as const, sandbox: true, bridgeSymbols: ["NDX"] };
  it("the line under the bots list", () => {
    expect(ordersFooter(bybit)).toBe("BTC orders go to the Bybit paper account; other bots use the simulation");
    expect(ordersFooter({ venue: "bybit", sandbox: true })).toBe("BTC orders go to the Bybit paper account; other bots use the simulation");
    expect(ordersFooter({ venue: "bybit", sandbox: true, bridgeSymbols: ["BTC"] })).toBe("BTC orders go to the Bybit paper account; other bots use the simulation");
    expect(ordersFooter(bybit)).not.toMatch(/NDX/);
  });
  it("the routing note on the accounts row", () => {
    expect(routingNote(bybit)).toMatch(/^Orders for BTC go to Bybit\./);
    expect(routingNote(bybit)).not.toMatch(/Orders for NDX/);
    expect(routingNote({ venue: "bybit", sandbox: true })).toMatch(/^Orders for BTC go to Bybit\./);
  });
  it("the other brokers still name their own symbols", () => {
    expect(ordersFooter(paper)).toBe("NDX orders go to the Interactive Brokers paper account; other bots use the simulation");
    expect(routingNote(paper)).toMatch(/Orders for NDX go to the bridge/);
  });
});
