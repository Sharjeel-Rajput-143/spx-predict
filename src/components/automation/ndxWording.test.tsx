import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SymbolsPanel } from "./bot/SymbolsPanel";
import { CONDITION_CATALOG, CONDITION_CATEGORIES, VISIBLE_CONDITIONS } from "./builder/model";
import { WebhooksSection, type SettingsData } from "./settings/sections";
import { botDisplayName } from "@/lib/automation/bots";

// The EMA 9/20 setup lives only in TradingView. This platform has no EMA or indicator settings and does no price
// analysis: its only input is the webhook's bullish/bearish call.

const WARNING = "Only the confirmed bullish and bearish alerts should call the webhook. Do not send any other alert, because extra alerts cause duplicate entries.";
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const noop = () => {};

describe("the NDX bot has no EMA wording", () => {
  it("is called NDX Bias Bot (the id stays as a legacy name)", () => {
    expect(botDisplayName("ndx_ema_bias")).toBe("NDX Bias Bot");
    expect(read("src/lib/automation/bots.ts")).toMatch(/LEGACY name/);
    expect(read(".env.example")).toMatch(/`ndx_ema_bias` is a LEGACY id/);
  });

  it("the duplicate-entry warning replaces every 'never the raw EMA cross' line", () => {
    expect(read("docs/ndx-paper-trading-setup.md")).toContain(WARNING);
    expect(read(".env.example")).toContain("Only the confirmed bullish and bearish alerts should call the webhook. Do not send any other alert, because extra alerts cause duplicate entries.");
    expect(read("src/components/automation/settings/WebhookList.tsx")).toContain("extra alerts cause duplicate entries");
    for (const file of ["docs/ndx-paper-trading-setup.md", ".env.example", "src/components/automation/bot/SettingsTab.tsx", "src/components/automation/settings/sections.tsx"]) {
      expect(read(file), file).not.toMatch(/raw EMA/i);
    }
  });

  it("Settings > Webhooks tells the user to send only the two confirmed alerts", () => {
    const data = {
      settings: { tradingWindow: null, emailAlerts: { enabled: false, to: "", onTrade: true, onWarningError: true, includeTest: true }, sessionTimeoutMinutes: 60 },
      window: { start: "09:35", end: "15:55", source: "environment", timezone: "America/New_York" },
      email: { enabled: false, to: null, senderWired: false },
      sessionTimeoutChoices: [60],
      signInRequired: false,
      executor: { kind: "mock", venue: "mock", error: null, dryRun: false, testMode: true },
      accounts: [],
      webhook: { path: "/api/webhook/tradingview", secretSet: true, bots: [{ id: "ndx_ema_bias", name: "NDX Bias Bot", underlying: "NDX" }] },
    } as unknown as SettingsData;
    const out = html(<WebhooksSection data={data} origin="http://localhost:3000" />);
    expect(out).toContain("Only the confirmed bullish and bearish alerts should call the webhook");
    expect(out).toContain("extra alerts cause duplicate entries");
    expect(out).not.toMatch(/EMA/);
  });

  it("the Bot symbols panel has no Indicators rows", () => {
    const out = html(<SymbolsPanel botId="b" underlying="NDX" onSaved={noop} onClose={noop} />);
    expect(out).not.toContain("Indicators");
    expect(out).not.toContain("Add indicator");
    expect(out).not.toMatch(/EMA|SMA|RSI/);
    expect(out).toContain("Excluded symbols"); // the rest of the panel is unchanged
  });

  it("the builder hides the whole Indicators category (RSI and Heikin Ashi bias included) but keeps the code", () => {
    expect(CONDITION_CATEGORIES).not.toContain("Indicators");
    expect(JSON.stringify(VISIBLE_CONDITIONS)).not.toMatch(/EMA|SMA|RSI|Heikin/);
    // Still in the catalog, so a flow saved with one reads back.
    expect(CONDITION_CATALOG.filter((c) => c.category === "Indicators").map((c) => c.id)).toEqual(["ind_compare", "ind_rsi", "ind_bias"]);
  });
});

describe("the NDX pages only show the webhook-driven bot", () => {
  it("the Automation list no longer links to the older Rules feature, and still links to the bot pages and Testing", () => {
    const list = read("src/components/automation/BotsList.tsx");
    expect(list).not.toMatch(/href=["']\/automations\/rules["']/);
    expect(list).toContain('href="/automation/status"'); // Testing
    expect(list).toContain("New Bot");
  });

  it("the older Rules feature is left in the code and its page is still there at its URL", () => {
    expect(read("src/app/automations/rules/page.tsx")).toContain("RulesView");
  });
});

describe("Bot inputs: the strike price source", () => {
  it("labels the live option clearly, and alert price is the default", () => {
    const form = read("src/components/automation/BotForm.tsx");
    expect(form).toContain("Live quote: do not use until a real time quote source is connected");
    expect(form).toContain('strikePriceSource: "alert"'); // the blank form
    expect(form).toContain('c?.strikePriceSource ?? "alert"');
  });
});
