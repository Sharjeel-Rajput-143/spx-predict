import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as testRoute } from "@/app/api/automation/webhooks/[id]/test/route";
import { POST as hookRoute } from "@/app/api/webhook/hook/[token]/route";
import { originLabel, signalOrigin, signalWebhookName } from "./origin";
import { attachWebhook, createWebhook } from "./webhooks";
import { runsStore, signalsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";

// Which way a call reached the bot: a real TradingView call, the Test Hook button, or the Run button.

setTestBotEnv();
setNdxTestEnv();

const feed = vi.hoisted(() => ({ tick: { t: 0, price: 21_050.5 } }));
vi.mock("@/lib/marketData/tickStore", () => ({ waitForTick: async () => ({ ...feed.tick, t: Date.now() }), getLastTick: () => null, isLiveSymbol: () => false }));

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
});

const settle = () => new Promise((r) => setTimeout(r, 120));
const signal = (raw: unknown) => ({ raw }) as never;

describe("reading the origin off a signal", () => {
  it("TradingView by default, Test Hook when marked, Manual run for a run from the bot's page", () => {
    expect(signalOrigin(signal({ webhook: "BullishNDX" }))).toBe("tradingview");
    expect(signalOrigin(signal(null))).toBe("tradingview"); // an entry from before this was recorded
    expect(signalOrigin(signal({ test: true, webhook: "BullishNDX" }))).toBe("test_hook");
    expect(signalOrigin(signal({ origin: "test_hook" }))).toBe("test_hook");
    expect(signalOrigin(signal({ source: "manual" }))).toBe("manual");
  });

  it("is labelled with the webhook's name", () => {
    expect(originLabel(signal({ webhook: "BullishNDX" }))).toBe("TradingView: BullishNDX");
    expect(originLabel(signal({ test: true, webhook: "BullishNDX" }))).toBe("Test Hook: BullishNDX");
    expect(originLabel(signal({ test: true }))).toBe("Test alert"); // the status page's test, through no webhook
    expect(originLabel(signal({ source: "manual" }))).toBe("Manual run");
    expect(signalWebhookName(signal({ webhook: "BullishNDX" }))).toBe("BullishNDX");
    expect(signalWebhookName(signal({}))).toBeNull();
  });
});

describe("what the log records", () => {
  it("a real call is recorded as TradingView, a Test Hook as Test Hook, each with the webhook's name, on the signal and on its run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE_NOW); // inside trading hours
    const bull = createWebhook({ name: "BullishNDX", botId: null, direction: null });
    attachWebhook(bull.id, NDX_BOT_ID, "bullish");

    await hookRoute(new NextRequest(`http://localhost/api/webhook/hook/${bull.token}`, { method: "POST", body: "bullish", headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token: bull.token }) });
    await settle();
    const real = signalsStore.all().at(-1)!;
    expect(signalOrigin(real)).toBe("tradingview");
    expect(runsStore.get(real.id)?.trigger).toBe("TradingView: BullishNDX");

    // Test Hook is signed-in only; with no login configured here it is open, as in local development.
    const res = await testRoute(new NextRequest(`http://localhost/api/automation/webhooks/${bull.id}/test`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ id: bull.id }) });
    expect(res.status).toBe(200);
    const tested = signalsStore.all().at(-1)!;
    expect(tested.id).not.toBe(real.id);
    expect(signalOrigin(tested)).toBe("test_hook");
    expect(runsStore.get(tested.id)?.trigger).toBe("Test Hook: BullishNDX");
    // The two are told apart in the same log.
    expect(signalsStore.all().map(signalOrigin)).toEqual(["tradingview", "test_hook"]);
  });
});
