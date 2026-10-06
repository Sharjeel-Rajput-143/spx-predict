import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsView } from "../SettingsView";
import { AccountsSection, ArchiveSection, GeneralSection, OutboundGate, WebhooksSection, alertBody, type SettingsData } from "./sections";

const noop = () => undefined;
const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const data = (over: Partial<SettingsData> = {}): SettingsData => ({
  settings: { tradingWindow: null, emailAlerts: { enabled: false, to: "", onTrade: true, onWarningError: true, includeTest: true }, sessionTimeoutMinutes: 60 },
  window: { start: "09:35", end: "15:55", source: "environment", timezone: "America/New_York" },
  email: { enabled: false, to: null, senderWired: false },
  sessionTimeoutChoices: [30, 60, 120, 240, 480],
  signInRequired: false,
  executor: { kind: "mock", venue: "mock", error: null, dryRun: false, testMode: true },
  accounts: [{ id: "paper-1", bots: ["SPX EMA 9/20 Bias"] }, { id: "paper-ndx", bots: [] }],
  webhook: { path: "/api/webhook/tradingview", secretSet: true, bots: [{ id: "spx_ema_bias", name: "SPX EMA 9/20 Bias", underlying: "SPX" }, { id: "ndx_ema_bias", name: "NDX Bias Bot", underlying: "NDX" }] },
  ...over,
});
const save = async () => null;

describe("General", () => {
  it("has the schedule, expiry behaviour, email, session timeout, text size and sign-in rows", () => {
    const out = html(<GeneralSection data={data()} save={save} />);
    for (const t of ["Bot schedule", "Automations run from", "9:35am", "3:55pm", "Exit options", "held to expiry", "Positions at expiry", "Email notifications", "When a position is opened or closed", "Warnings and errors", "Include test trades", "Session timeout", "1 hour", "Text size", "Two-step authentication", "Not available yet"]) {
      expect(out, t).toContain(t);
    }
  });

  it("says email isn't actually sent, and that sign-in has no effect without a password", () => {
    const out = html(<GeneralSection data={data()} save={save} />);
    expect(out).toContain("only queues each alert - nothing is sent");
    expect(out).toContain("this has no effect yet");
    expect(html(<GeneralSection data={data({ signInRequired: true })} save={save} />)).not.toContain("this has no effect yet");
  });

  it("offers the 5-minute marks, and the reset only when a window is saved", () => {
    const out = html(<GeneralSection data={data()} save={save} />);
    expect(out).toContain(">12:00pm<");
    expect(out).not.toContain("Use the environment default");
    const saved = html(<GeneralSection data={data({ window: { start: "10:00", end: "15:00", source: "settings", timezone: "America/New_York" } })} save={save} />);
    expect(saved).toContain("Use the environment default");
    expect(saved).toContain("saved here: 10:00am - 3:00pm");
  });
});

describe("Trading Accounts", () => {
  it("shows the mock executor, each account with its bots, and Add account disabled", () => {
    const out = html(<AccountsSection data={data()} />);
    expect(out).toContain("Mock - test trades only, nothing reaches a broker");
    expect(out).toContain("paper-1");
    expect(out).toContain("SPX EMA 9/20 Bias");
    expect(out).toContain("No bots use it yet");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Add account<\/button>/);
    expect(out).toContain("not connected to any account");
  });

  it("names the Tradier address when that executor is chosen, and shows a broken one as an error", () => {
    expect(html(<AccountsSection data={data({ executor: { kind: "tradier", venue: "tradier", error: null, baseUrl: "https://sandbox.tradier.com/v1", sandbox: true, dryRun: false, testMode: false } })} />)).toContain("Tradier sandbox (paper money)");
    expect(html(<AccountsSection data={data({ executor: { kind: "tradier", venue: "tradier", error: "needs TRADIER_TOKEN", dryRun: false, testMode: false } })} />)).toContain("Not usable: needs TRADIER_TOKEN");
  });
});

describe("Bot Archive", () => {
  it("is empty by default", () => {
    expect(html(<ArchiveSection bots={[]} onRestore={noop} onDelete={noop} />)).toContain("No bots archived yet.");
  });

  it("lists archived bots with Restore, and Delete only for bots made in the app", () => {
    const out = html(<ArchiveSection bots={[{ id: "ndx_ema_bias", name: "NDX", builtIn: true, group: null }, { id: "mine_1", name: "Mine", builtIn: false, group: "Income" }]} onRestore={noop} onDelete={noop} />);
    expect((out.match(/>Restore</g) ?? []).length).toBe(2);
    expect((out.match(/>Delete</g) ?? []).length).toBe(1);
    expect(out).toContain("Income");
  });
});

describe("Webhooks", () => {
  it("shows the URL, the secret's state, and a ready alert message per bot and direction with a placeholder secret", () => {
    const out = html(<WebhooksSection data={data()} origin="http://localhost:3000" outbound={null} />);
    expect(out).toContain("http://localhost:3000/api/webhook/tradingview");
    expect(out).toContain(">Set<");
    expect(out).toContain('{&quot;secret&quot;:&quot;&lt;SECRET&gt;&quot;,&quot;bot&quot;:&quot;ndx_ema_bias&quot;,&quot;signal&quot;:&quot;bullish&quot;,&quot;symbol&quot;:&quot;NDX&quot;');
    expect((out.match(/Bullish alert message/g) ?? []).length).toBe(2);
    expect((out.match(/Bearish alert message/g) ?? []).length).toBe(2);
    expect(html(<WebhooksSection data={data({ webhook: { ...data().webhook, secretSet: false } })} origin="" outbound={null} />)).toContain("Not set - alerts are refused until WEBHOOK_SECRET is set");
  });

  it("builds the TradingView body from the addendum, field for field", () => {
    expect(alertBody({ id: "ndx_ema_bias", underlying: "NDX" }, "bearish")).toBe('{"secret":"<SECRET>","bot":"ndx_ema_bias","signal":"bearish","symbol":"NDX","price":{{close}},"bar_time":"{{timenow}}","interval":"{{interval}}"}');
    expect(alertBody({ id: "x", underlying: null }, "bullish")).not.toContain("symbol");
  });

  it("keeps the outbound Option Alpha feature behind a button", () => {
    const hidden = html(<OutboundGate shown={false} onShow={noop}><p>OUTBOUND CONTENT</p></OutboundGate>);
    expect(hidden).toContain("Show connections");
    expect(hidden).not.toContain("OUTBOUND CONTENT");
    expect(html(<OutboundGate shown onShow={noop}><p>OUTBOUND CONTENT</p></OutboundGate>)).toContain("OUTBOUND CONTENT");
  });
});

describe("Settings page", () => {
  it("opens on General and doesn't render the outbound feature on load", () => {
    const out = html(<SettingsView />);
    expect(out).toContain("General");
    expect(out).toContain("Trading Accounts");
    expect(out).toContain("Bot Archive");
    expect(out).toContain("Webhooks");
    expect(out).toMatch(/aria-current="page"[^>]*>General</);
    expect(out).not.toContain("Option Alpha connections");
  });
});
