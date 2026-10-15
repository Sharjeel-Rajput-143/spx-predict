import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_COOKIE_NAME } from "@/lib/automation/session";
import { decisionsStore, runsStore, signalsStore } from "@/lib/automation/store";
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv } from "@/lib/automation/testSupport";
import { GET } from "./route";

setNdxTestEnv();

const get = (qs: string, cookie?: string) => GET(new NextRequest(`http://localhost/api/automation/test/run${qs}`, { headers: cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {} }));

beforeEach(() => {
  vi.stubEnv("APP_LOGIN_EMAIL", "owner@example.com");
  resetAutomationStores();
  setNdxTestEnv();
  signalsStore.insert({ id: "sig-1", botId: NDX_BOT_ID, signal: "bullish", barTime: "t", price: 1, interval: "5", receivedAt: BASE_NOW, status: "accepted", raw: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("how a test alert is getting on", () => {
  it("not finished while only some decisions are in, finished once its run has been written", async () => {
    decisionsStore.insert({ id: "d1", signalId: "sig-1", botId: NDX_BOT_ID, outcome: "webhook_attached", reason: "x", detail: {}, createdAt: BASE_NOW });
    expect(await (await get("?signalId=sig-1")).json()).toEqual({ finished: false, decisions: [{ outcome: "webhook_attached", reason: "x" }] });
    runsStore.insert({ id: "r1", botId: NDX_BOT_ID, signalId: "sig-1", source: "webhook", automation: "Bullish signal", trigger: "Webhook", startedAt: BASE_NOW, nodes: [] } as never);
    decisionsStore.insert({ id: "d2", signalId: "sig-1", botId: NDX_BOT_ID, outcome: "opened", reason: "Opened.", detail: {}, createdAt: BASE_NOW + 5 });
    const done = await (await get("?signalId=sig-1")).json();
    expect(done.finished).toBe(true);
    expect(done.decisions.map((d: { outcome: string }) => d.outcome)).toEqual(["webhook_attached", "opened"]); // in the order they happened
  });

  it("asks for a signal id, knows only real ones, and needs a sign-in when sign-in is on", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get(`?signalId=${"x".repeat(300)}`)).status).toBe(400);
    expect((await get("?signalId=nope")).status).toBe(404);
    vi.stubEnv("APP_LOGIN_PASSWORD", "correct horse");
    vi.stubEnv("AUTH_SECRET", "x".repeat(48));
    expect((await get("?signalId=sig-1")).status).toBe(401);
    expect((await get("?signalId=sig-1", createSession())).status).toBe(200);
  });
});
