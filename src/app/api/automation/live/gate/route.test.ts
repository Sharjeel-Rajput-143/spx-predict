import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetLedger, readLedger } from "@/lib/automation/ledger";
import { __resetLiveSettings, readLiveSettings } from "@/lib/automation/liveSettings";
import { resetAutomationStores, setNdxTestEnv } from "@/lib/automation/testSupport";
import { GET } from "./route";

setNdxTestEnv();
const req = () => new NextRequest("http://localhost/api/automation/live/gate", { method: "GET" });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  __resetLiveSettings();
  __resetLedger();
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/automation/live/gate", () => {
  it("gives the gate as numbers: failure tests on the real demo account X of 6, the fake partial fill yes or no, clean counted trades X of 5, and why not", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, tests: { passed: 0, total: 6 }, partialFill: { id: 7, source: "fake", passed: false }, trades: { clean: 0, needed: 5 }, ledger: { ok: true, events: 0, pending: 0 } });
    expect(body.tests.items).toHaveLength(6);
    expect(body.why).toMatch(/failure tests on the real demo account 0 of 6/);
    expect(body.why).toMatch(/partial fill proven on the fake exchange: no/);
    expect(body.why).toMatch(/clean counted trades 0 of 5/);
  });

  it("is signed-in only", async () => {
    vi.stubEnv("APP_LOGIN_PASSWORD", "x-not-a-real-password");
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("is read only: it turns nothing on and writes nothing to the ledger", async () => {
    await GET(req());
    await GET(req());
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false });
    expect(readLedger().events).toHaveLength(0);
  });
});
