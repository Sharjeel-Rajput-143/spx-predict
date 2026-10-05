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
