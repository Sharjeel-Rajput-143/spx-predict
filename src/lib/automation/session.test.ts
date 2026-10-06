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

  it("fails closed in production when no password is configured", () => {
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(isValidSession(undefined)).toBe(false);
    expect(isValidSession("forged")).toBe(false);
  });
});

describe("switching sign-in off on purpose", () => {
  it("AUTOMATION_AUTH_DISABLED=true opens every page, even in a production build with no password", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "");
    expect(isValidSession(undefined)).toBe(false); // fail-closed by default
    vi.stubEnv("AUTOMATION_AUTH_DISABLED", "true");
    expect(isValidSession(undefined)).toBe(true);
    expect(isValidSession("forged")).toBe(true);
  });

  it("only the exact value true counts, and a password alone doesn't switch it on", () => {
    vi.stubEnv("NODE_ENV", "production");
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

  it("the session answer says so, so the app can warn", async () => {
    const { GET } = await import("../../app/api/automation/session/route");
    const { NextRequest } = await import("next/server");
    vi.stubEnv("AUTOMATION_AUTH_DISABLED", "true");
    const body = await (await GET(new NextRequest("http://localhost/api/automation/session"))).json();
    expect(body).toMatchObject({ authDisabled: true, authRequired: false });
    vi.stubEnv("AUTOMATION_AUTH_DISABLED", "");
    expect((await (await GET(new NextRequest("http://localhost/api/automation/session"))).json()).authDisabled).toBe(false);
  });
});
