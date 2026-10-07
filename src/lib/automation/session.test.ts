import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, isValidSession } from "./session";

afterEach(() => vi.unstubAllEnvs());

describe("isValidSession", () => {
  it("is open when no password is configured (local dev)", () => {
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(isValidSession(undefined)).toBe(true);
  });

  it("requires a real session token once a password is configured", () => {
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "pw");
    expect(isValidSession(undefined)).toBe(false);
    expect(isValidSession("forged")).toBe(false);
    expect(isValidSession(createSession())).toBe(true);
  });

  it("fails closed in production once a real broker is configured and no password is set", () => {
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EXECUTOR", "tradier");
    expect(isValidSession(undefined)).toBe(false);
    expect(isValidSession("forged")).toBe(false);
  });

  it("is open in production with the mock executor and no password (a demo with nothing real behind it)", () => {
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EXECUTOR", "");
    expect(isValidSession(undefined)).toBe(true);
  });

  it("a password always turns sign-in on, with either executor", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "s".repeat(48));
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "pw");
    vi.stubEnv("EXECUTOR", "");
    expect(isValidSession(undefined)).toBe(false);
    expect(isValidSession(createSession())).toBe(true);
  });
});

describe("switching sign-in off on purpose", () => {
  it("AUTOMATION_AUTH_DISABLED=true opens every page even with a broker configured and no password", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "");
    vi.stubEnv("EXECUTOR", "tradier");
    expect(isValidSession(undefined)).toBe(false);
    vi.stubEnv("AUTOMATION_AUTH_DISABLED", "true");
    expect(isValidSession(undefined)).toBe(true);
    expect(isValidSession("forged")).toBe(true);
  });

  it("only the exact value true counts", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EXECUTOR", "tradier");
    for (const v of ["", "1", "yes", "TRUE", "false"]) {
      vi.stubEnv("AUTOMATION_AUTH_DISABLED", v);
      expect(isValidSession(undefined), v).toBe(false);
    }
  });

  it("is ignored when real money is in play - Tradier production keeps sign-in on", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTOMATION_AUTH_DISABLED", "true");
    vi.stubEnv("EXECUTOR", "tradier");
    vi.stubEnv("TRADIER_ALLOW_PRODUCTION", "true");
    expect(isValidSession(undefined)).toBe(false);
    vi.stubEnv("TRADIER_ALLOW_PRODUCTION", "");
    expect(isValidSession(undefined)).toBe(true); // the sandbox is paper money
  });

  it("the session answer says when sign-in is off in a production build, so the app can warn - and never in local development", async () => {
    const { GET } = await import("../../app/api/automation/session/route");
    const { NextRequest } = await import("next/server");
    const ask = async () => (await (await GET(new NextRequest("http://localhost/api/automation/session"))).json()) as { authDisabled: boolean; authRequired: boolean };
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "");
    vi.stubEnv("EXECUTOR", "");
    expect(await ask()).toMatchObject({ authDisabled: true, authRequired: false }); // the demo case: warn
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "pw");
    expect(await ask()).toMatchObject({ authDisabled: false, authRequired: true });
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "");
    expect(await ask()).toMatchObject({ authDisabled: false, authRequired: false }); // local: open, no warning
  });
});

describe("a demo deployment (serverless host, mock executor only)", () => {
  it("is a demo only on Vercel with no broker", async () => {
    const { isDemoHost, isTestMode, getWebhookSecret } = await import("./config");
    vi.stubEnv("VERCEL", "");
    expect(isDemoHost()).toBe(false);
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("EXECUTOR", "");
    expect(isDemoHost()).toBe(true);
    vi.stubEnv("EXECUTOR", "tradier");
    expect(isDemoHost()).toBe(false);

    // Test alerts may run any time on the mock, and never default on with a broker.
    vi.stubEnv("AUTOMATION_TEST_MODE", "");
    vi.stubEnv("EXECUTOR", "");
    expect(isTestMode()).toBe(true);
    vi.stubEnv("EXECUTOR", "tradier");
    expect(isTestMode()).toBe(false);
    vi.stubEnv("AUTOMATION_TEST_MODE", "false");
    vi.stubEnv("EXECUTOR", "");
    expect(isTestMode()).toBe(false);

    // A throwaway webhook secret on the demo host, none anywhere else.
    vi.stubEnv("WEBHOOK_SECRET", "");
    vi.stubEnv("VERCEL", "1");
    const secret = getWebhookSecret();
    expect(secret).toMatch(/^demo-/);
    expect(getWebhookSecret()).toBe(secret);
    vi.stubEnv("VERCEL", "");
    expect(() => getWebhookSecret()).toThrow(/WEBHOOK_SECRET/);
  });
});
