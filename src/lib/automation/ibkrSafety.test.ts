import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as brokerRoute } from "@/app/api/automation/broker/route";
import { POST as reconcileRoute } from "@/app/api/automation/reconcile/route";
import { GET as settingsRoute } from "@/app/api/automation/settings/route";
import { GET as statusRoute } from "@/app/api/automation/status/route";
import { POST as alertRoute } from "@/app/api/automation/test/alert/route";
import { POST as resetRoute } from "@/app/api/automation/test/reset/route";
import { POST as webhookTestRoute } from "@/app/api/automation/webhooks/[id]/test/route";
import { isAuthDisabled, isAuthRequired, isBrokerConfigured, isDemoHost, isTestMode } from "./config";
import { storageProblem, positionsStore, signalsStore } from "./store";
import { NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import { createWebhook } from "./webhooks";
import { ensureBotRecord } from "./bots";

// What the IBKR switch is allowed to do, and what it is never allowed to do. No network: `fetch` is replaced in every test, and the ones
// that must send nothing check that it was never called.

setTestBotEnv();
setNdxTestEnv();

const SECRET = "test-bridge-secret-not-real";
const PAPER_ENV = { BROKER: "ibkr", BRIDGE_URL: "https://bridge.example.test", BRIDGE_SECRET: SECRET };
const LIVE_ENV = { ...PAPER_ENV, IBKR_ALLOW_LIVE: "true", IBKR_MAX_CONTRACTS_PER_ORDER: "1", IBKR_MAX_RISK_PER_ORDER: "1000" };
const useEnv = (env: Record<string, string>) => Object.entries(env).forEach(([k, v]) => vi.stubEnv(k, v));

let fetchSpy: ReturnType<typeof vi.fn>;
const bridgeAnswers = (positions: unknown[] = []) => {
  fetchSpy = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const body = path === "/positions" ? { positions } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  vi.stubGlobal("fetch", fetchSpy);
};
const post = (path: string, body: unknown = {}) => new NextRequest(`http://localhost/api/automation/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  vi.stubEnv("WEBHOOK_SECRET", "test-secret-value");
  bridgeAnswers();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a real broker setting changes the app's safety rules, as Tradier's does", () => {
  it("BROKER=ibkr counts as a broker; the internal simulation does not", () => {
    expect(isBrokerConfigured()).toBe(false);
    vi.stubEnv("BROKER", "internal");
    expect(isBrokerConfigured()).toBe(false);
    vi.stubEnv("BROKER", "ibkr");
    expect(isBrokerConfigured()).toBe(true);
  });

  it("an unreadable broker setting never counts as a broker, but is reported loudly by the status", async () => {
    vi.stubEnv("BROKER", "paper");
    expect(isBrokerConfigured()).toBe(false);
    expect((await (await settingsRoute(new NextRequest("http://localhost/api/automation/settings"))).json()).executor.error).toMatch(/BROKER must be/);
  });

  it("test alerts are not allowed to run any time on a broker, and the demo-host shortcuts are off", () => {
    expect(isTestMode()).toBe(true);
    vi.stubEnv("BROKER", "ibkr");
    expect(isTestMode()).toBe(false);
    vi.stubEnv("VERCEL", "1");
    expect(isDemoHost()).toBe(false);
  });

  it("sign-in is required in production once a broker is set, even with no password configured (access is denied rather than open)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_LOGIN_PASSWORD", "");
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "");
    expect(isAuthRequired()).toBe(false);
    vi.stubEnv("BROKER", "ibkr");
    expect(isAuthRequired()).toBe(true);
  });

  it("switching sign-in off on purpose works for paper, and is ignored when real money is allowed", () => {
    vi.stubEnv("AUTOMATION_AUTH_DISABLED", "true");
    useEnv(PAPER_ENV);
    expect(isAuthDisabled()).toBe(true);
    vi.stubEnv("IBKR_ALLOW_LIVE", "true");
    expect(isAuthDisabled()).toBe(false);
  });

  it("a broker can't be driven from Vercel, whichever way it is named", () => {
    vi.stubEnv("VERCEL", "1");
    expect(storageProblem() ?? "").not.toMatch(/can't be driven from Vercel/);
    vi.stubEnv("BROKER", "ibkr");
    expect(storageProblem()).toMatch(/can't be driven from Vercel/);
    vi.stubEnv("BROKER", "");
    vi.stubEnv("EXECUTOR", "ibkr");
    expect(storageProblem()).toMatch(/can't be driven from Vercel/);
  });

  it("off Vercel, the same setting raises no such problem", () => {
    vi.stubEnv("BROKER", "ibkr");
    expect(storageProblem() ?? "").not.toMatch(/Vercel/);
  });
});

describe("the bridge's secret is never shown", () => {
  it("is in no page or status answer, though the address is", async () => {
    useEnv(PAPER_ENV);
    const settings = await (await settingsRoute(new NextRequest("http://localhost/api/automation/settings"))).json();
    const status = await (await statusRoute(new NextRequest("http://localhost/api/automation/status"))).json();
    for (const body of [settings, status]) {
      expect(body.executor).toMatchObject({ kind: "ibkr", venue: "ibkr", error: null, sandbox: true, baseUrl: "https://bridge.example.test", priceSource: "feed" });
      expect(JSON.stringify(body)).not.toContain(SECRET);
    }
  });

  it("a misconfigured bridge is an error status that names the missing settings, never their values", async () => {
    vi.stubEnv("BROKER", "ibkr");
    vi.stubEnv("BRIDGE_URL", "https://user:hunter2@bridge.example.test");
    vi.stubEnv("BRIDGE_SECRET", SECRET);
    const text = JSON.stringify((await (await settingsRoute(new NextRequest("http://localhost/api/automation/settings"))).json()).executor);
    expect(text).toMatch(/must not contain a user name or password/);
    expect(text).not.toContain("hunter2");
  });

  it("live mode is shown as not paper", async () => {
    useEnv(LIVE_ENV);
    expect((await (await settingsRoute(new NextRequest("http://localhost/api/automation/settings"))).json()).executor).toMatchObject({ venue: "ibkr", sandbox: false, error: null });
  });
});

describe("test alerts and test calls: paper or simulation only, never real money", () => {
  it("a real-money IBKR account refuses a test alert and sends nothing", async () => {
    useEnv(LIVE_ENV);
    const res = await alertRoute(post("test/alert", { bot: NDX_BOT_ID, signal: "bullish", price: 21_003.7 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/never against real money/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(signalsStore.all()).toHaveLength(0);
  });

  it("a paper IBKR account gets past that check (an unknown bot is then what stops it, and nothing is sent)", async () => {
    useEnv(PAPER_ENV);
    const res = await alertRoute(post("test/alert", { bot: "no-such-bot", signal: "bullish", price: 21_003.7 }));
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a misconfigured IBKR is not paper either", async () => {
    vi.stubEnv("BROKER", "ibkr");
    const res = await alertRoute(post("test/alert", { bot: NDX_BOT_ID, signal: "bullish", price: 21_003.7 }));
    expect(res.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a real-money IBKR account refuses a webhook's Test call and sends nothing", async () => {
    useEnv(LIVE_ENV);
    ensureBotRecord(NDX_BOT_ID);
    const hook = createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
    const res = await webhookTestRoute(post(`webhooks/${hook.id}/test`), { params: Promise.resolve({ id: hook.id }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/never against real money/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(signalsStore.all()).toHaveLength(0);
  });

  it("Reset test data stays a simulation-only action: refused on any broker, paper or not", async () => {
    useEnv(PAPER_ENV);
    const res = await resetRoute(post("test/reset", { confirm: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/only available on the mock executor/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the broker check and the account page on IBKR", () => {
  it("the broker check reads the account's positions and reports; it is refused on the simulation", async () => {
    const mock = await reconcileRoute(post("reconcile"));
    expect(mock.status).toBe(409);
    expect((await mock.json()).error).toMatch(/Nothing to check/);

    useEnv(PAPER_ENV);
    bridgeAnswers([]);
    const flat = await reconcileRoute(post("reconcile"));
    expect(flat.status).toBe(200);
    expect((await flat.json()).report).toMatchObject({ ok: true, expectedLegs: 0, brokerLegs: 0 });
    expect(fetchSpy.mock.calls.map((c) => `${(c[1] as { method: string }).method} ${new URL(c[0] as string).pathname}`)).toEqual(["GET /positions"]); // a read, nothing else
  });

  it("a mismatch is reported, and flags the bot, but nothing is sent to the broker beyond the read", async () => {
    useEnv(PAPER_ENV);
    ensureBotRecord(NDX_BOT_ID);
    positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "open", shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 1, filledQuantity: 1 }));
    bridgeAnswers([]);
    const res = await reconcileRoute(post("reconcile"));
    expect((await res.json()).report.problems.map((p: { kind: string }) => p.kind)).toEqual(["missing_at_broker", "missing_at_broker"]);
    expect(fetchSpy.mock.calls.every((c) => (c[1] as { method: string }).method === "GET")).toBe(true);
  });

  it("a misconfigured bridge stops the broker check with the reason instead of failing halfway", async () => {
    vi.stubEnv("BROKER", "ibkr");
    const res = await reconcileRoute(post("reconcile"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/BRIDGE_URL, BRIDGE_SECRET/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the account page has no balances for IBKR yet and says so with nothing sent", async () => {
    useEnv(PAPER_ENV);
    const res = await brokerRoute(new NextRequest("http://localhost/api/automation/broker"));
    expect(await res.json()).toEqual({ venue: "ibkr", sandbox: true, error: null, balances: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
