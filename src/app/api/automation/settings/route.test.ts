import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NDX_BOT_ID, TEST_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "@/lib/automation/testSupport";
import { GET, PATCH } from "./route";

setTestBotEnv();
setNdxTestEnv();

const patch = (body: unknown) => PATCH(new NextRequest("http://localhost/api/automation/settings", { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
const get = () => GET(new NextRequest("http://localhost/api/automation/settings"));

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/automation/settings", () => {
  it("gives everything the page shows: settings, window, accounts, executor, webhook details", async () => {
    vi.stubEnv("WEBHOOK_SECRET", "super-secret-value-123");
    const body = await (await get()).json();
    expect(body.window).toEqual({ start: "09:35", end: "15:55", source: "environment", timezone: "America/New_York" });
    expect(body.settings.sessionTimeoutMinutes).toBe(60);
    expect(body.sessionTimeoutChoices).toEqual([30, 60, 120, 240, 480]);
    expect(body.executor).toMatchObject({ kind: "mock", venue: "mock", error: null });
    expect(body.email).toEqual({ enabled: false, to: null, senderWired: false });
    expect(body.webhook).toMatchObject({ path: "/api/webhook/tradingview", secretSet: true });
    expect(body.webhook.bots.map((b: { id: string; underlying: string }) => [b.id, b.underlying])).toEqual([[TEST_BOT_ID, "SPX"], [NDX_BOT_ID, "NDX"]]);
    expect(body.accounts.find((a: { id: string }) => a.id === "paper-ndx").bots).toEqual(["NDX EMA 9/20 Bias"]);
  });

  it("never includes the webhook secret, only whether it is set", async () => {
    vi.stubEnv("WEBHOOK_SECRET", "super-secret-value-123");
    expect(JSON.stringify(await (await get()).json())).not.toContain("super-secret-value-123");
    vi.stubEnv("WEBHOOK_SECRET", "");
    expect((await (await get()).json()).webhook.secretSet).toBe(false);
  });

  it("lists a bot that isn't set up yet without failing", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_STRIKE_INCREMENT", "");
    const body = await (await get()).json();
    expect(body.webhook.bots.find((b: { id: string }) => b.id === NDX_BOT_ID)).toMatchObject({ name: "NDX EMA 9/20 Bias", underlying: null });
  });
});

describe("PATCH /api/automation/settings", () => {
  it("saves a window and reflects it straight away", async () => {
    const res = await patch({ tradingWindow: { start: "10:00", end: "15:30" } });
    expect(res.status).toBe(200);
    expect((await res.json()).window).toMatchObject({ start: "10:00", end: "15:30", source: "settings" });
    expect((await (await get()).json()).window.start).toBe("10:00");
  });

  it("refuses bad values with a message, and saves nothing", async () => {
    const res = await patch({ tradingWindow: { start: "16:00", end: "09:30" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/start before it ends/);
    expect((await (await get()).json()).window.source).toBe("environment");
    expect((await patch({ emailAlerts: { enabled: true } })).status).toBe(400);
    expect((await patch({ sessionTimeoutMinutes: 7 })).status).toBe(400);
  });

  it("email: saved with an address, and reported as queued-only because no sender is wired", async () => {
    const body = await (await patch({ emailAlerts: { enabled: true, to: "owner@example.invalid" } })).json();
    expect(body.email).toEqual({ enabled: true, to: "owner@example.invalid", senderWired: false });
  });
});
