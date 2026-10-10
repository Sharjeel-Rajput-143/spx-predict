import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/login/route";
import { proxy } from "@/proxy";
import { checkCredentials, resetFailures, safeNext } from "./credentials";
import { signSession, verifySession } from "./sessionToken";
import { createSession, destroySession, isValidSession, SESSION_COOKIE_NAME } from "@/lib/automation/session";

// The login form's backend and the gate in front of the app. Test values only; nothing is called over the network.

beforeEach(() => {
  vi.stubEnv("APP_LOGIN_EMAIL", "Owner@Example.com");
  vi.stubEnv("APP_LOGIN_PASSWORD", "correct horse");
  vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "");
  vi.stubEnv("AUTOMATION_AUTH_DISABLED", "");
  vi.stubEnv("AUTH_SECRET", "x".repeat(48));
  resetFailures();
});
afterEach(() => vi.unstubAllEnvs());

const post = (body: unknown, ip = "1.1.1.1") =>
  login(new NextRequest("http://localhost/api/login", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "x-forwarded-for": ip } }));
const get = (path: string, cookie?: string) => proxy(new NextRequest(`http://localhost${path}`, { headers: cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {} }));
const cookieOf = (res: Response) => /automation_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

describe("checking the email and password", () => {
  it("accepts the right pair (the email in any letter case) and nothing else", () => {
    expect(checkCredentials("owner@example.com", "correct horse")).toBe(true);
    expect(checkCredentials("  OWNER@example.com ", "correct horse")).toBe(true);
    expect(checkCredentials("owner@example.com", "wrong")).toBe(false);
    expect(checkCredentials("other@example.com", "correct horse")).toBe(false);
    expect(checkCredentials(undefined, "correct horse")).toBe(false);
    expect(checkCredentials("owner@example.com", undefined)).toBe(false);
    expect(checkCredentials("owner@example.com", "")).toBe(false);
  });

  it("with no password set, nobody can sign in", () => {
    vi.stubEnv("APP_LOGIN_PASSWORD", "");
    expect(checkCredentials("owner@example.com", "")).toBe(false);
  });
});

describe("POST /api/login", () => {
  it("signs in with the right pair: a signed HttpOnly cookie, and where to go next", async () => {
    const res = await post({ email: "owner@example.com", password: "correct horse", next: "/automation/bots/ndx_ema_bias" });
    expect(res.status).toBe(200);
    expect((await res.json()).next).toBe("/automation/bots/ndx_ema_bias");
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(isValidSession(cookieOf(res))).toBe(true);
  });

  it("refuses a wrong password or email with the same message, and sets no cookie", async () => {
    for (const body of [{ email: "owner@example.com", password: "nope" }, { email: "x@example.com", password: "correct horse" }, {}]) {
      const res = await post(body, `9.9.9.${Math.random()}`);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("Wrong email or password.");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("locks an address out after five wrong tries, even for the right password", async () => {
    for (let i = 0; i < 5; i++) expect((await post({ email: "owner@example.com", password: "bad" }, "7.7.7.7")).status).toBe(401);
    expect((await post({ email: "owner@example.com", password: "correct horse" }, "7.7.7.7")).status).toBe(429);
    expect((await post({ email: "owner@example.com", password: "correct horse" }, "8.8.8.8")).status).toBe(200);
  });

  it("never sends someone to another site after signing in", async () => {
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example", "/login", "/api/automation/status"]) {
      expect(safeNext(next), next).toBe("/automations");
      const res = await post({ email: "owner@example.com", password: "correct horse", next }, `6.6.6.${Math.random()}`);
      expect((await res.json()).next, next).toBe("/automations");
    }
  });

  it("says so when the server has no login set up", async () => {
    vi.stubEnv("APP_LOGIN_PASSWORD", "");
    expect((await post({ email: "a@b.c", password: "x" })).status).toBe(503);
  });
});

describe("the session cookie", () => {
  it("is signed: a forged, tampered or expired one is refused", () => {
    const token = createSession();
    expect(isValidSession(token)).toBe(true);
    expect(isValidSession("forged")).toBe(false);
    expect(isValidSession(`${token.split(".")[0]}.AAAA`)).toBe(false);
    const key = "k";
    const expired = signSession("a@b.c", 1000, key, Date.now() - 5000);
    expect(verifySession(expired, key)).toBeNull();
    expect(verifySession(signSession("a@b.c", 60_000, key), key)).toBe("a@b.c");
    expect(verifySession(signSession("a@b.c", 60_000, key), "other-key")).toBeNull();
  });

  it("changing the password signs everybody out; signing out ends one", () => {
    const token = createSession();
    destroySession(token);
    expect(isValidSession(token)).toBe(false);
    const other = createSession();
    vi.stubEnv("APP_LOGIN_PASSWORD", "a different one");
    expect(isValidSession(other)).toBe(false);
  });
});

describe("the gate in front of the app", () => {
  it("sends a signed-out page request to /login, remembering where it was going", () => {
    const res = get("/automation/bots/ndx_ema_bias?tab=settings");
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("next")).toBe("/automation/bots/ndx_ema_bias?tab=settings");
  });

  it("answers a signed-out API call with 401", async () => {
    for (const path of ["/api/automation/status", "/api/automation/webhooks", "/api/quote?symbol=SPX", "/api/bars"]) {
      const res = get(path);
      expect(res.status, path).toBe(401);
    }
  });

  it("lets a signed-in request through", () => {
    const token = createSession();
    for (const path of ["/automations", "/settings", "/api/automation/status"]) expect(get(path, token).headers.get("x-middleware-next"), path).toBe("1");
  });

  it("leaves the login page, the webhook URLs TradingView calls, and the session check open", () => {
    for (const path of ["/login", "/api/login", "/hook/abc123", "/api/webhook/hook/abc123", "/api/webhook/tradingview", "/api/cron/sweep", "/api/automation/session"]) {
      expect(get(path).headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it("is off when no login is configured (local development), or switched off on purpose", () => {
    vi.stubEnv("APP_LOGIN_PASSWORD", "");
    expect(get("/automations").headers.get("x-middleware-next")).toBe("1");
    vi.stubEnv("APP_LOGIN_PASSWORD", "pw");
    vi.stubEnv("AUTOMATION_AUTH_DISABLED", "true");
    expect(get("/automations").headers.get("x-middleware-next")).toBe("1");
  });
});

describe("hardening", () => {
  const send = (path: string, init: { method: string; headers?: Record<string, string> }, cookie?: string) =>
    proxy(new NextRequest(`http://localhost${path}`, { method: init.method, headers: { host: "localhost", ...(cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {}), ...init.headers } }));

  it("production refuses to sign anyone in without an AUTH_SECRET, and never signs with the password alone", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "too short");
    expect((await post({ email: "owner@example.com", password: "correct horse" })).status).toBe(503);
    expect(isValidSession(undefined)).toBe(false);
    expect(send("/automations", { method: "GET" }).status).toBe(503);
    expect(send("/api/automation/status", { method: "GET" }).status).toBe(503);
  });

  it("the signing key is not derived from the password once AUTH_SECRET is set", () => {
    const a = createSession();
    vi.stubEnv("APP_LOGIN_PASSWORD", "another password");
    vi.stubEnv("APP_LOGIN_EMAIL", "owner@example.com");
    // same AUTH_SECRET, but a token made for the old login is not valid for the new one
    expect(isValidSession(a)).toBe(false);
    vi.stubEnv("APP_LOGIN_PASSWORD", "correct horse");
    vi.stubEnv("AUTH_SECRET", "y".repeat(48));
    expect(isValidSession(a)).toBe(false);
  });

  it("faking the address header does not dodge the lockout: the whole login locks after 15 wrong tries", async () => {
    for (let i = 0; i < 15; i++) await post({ email: "owner@example.com", password: "bad" }, `50.0.0.${i}`);
    expect((await post({ email: "owner@example.com", password: "correct horse" }, "60.0.0.1")).status).toBe(429);
  });

  it("refuses a huge email or password without trying it", async () => {
    expect(checkCredentials("owner@example.com", "x".repeat(300))).toBe(false);
    expect(checkCredentials("a".repeat(300), "correct horse")).toBe(false);
  });

  it("a cookie is SameSite=Strict and HttpOnly; answers are never cached", async () => {
    const res = await post({ email: "owner@example.com", password: "correct horse" }, "70.0.0.1");
    expect(res.headers.get("set-cookie")).toMatch(/SameSite=strict/i);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a write made from another website is refused, even with a valid cookie; the same site and the webhook are not", () => {
    const token = createSession();
    const evil = { method: "POST", headers: { origin: "https://evil.example" } };
    expect(send("/api/automation/bots/ndx_ema_bias/kill", evil, token).status).toBe(403);
    expect(send("/api/login", evil).status).toBe(403);
    expect(send("/api/automation/bots/x/kill", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }, token).status).toBe(403);
    expect(send("/api/automation/bots/x/kill", { method: "POST", headers: { origin: "http://localhost" } }, token).headers.get("x-middleware-next")).toBe("1");
    expect(send("/hook/abc", { method: "POST", headers: { origin: "https://tradingview.example" } }).headers.get("x-middleware-next")).toBe("1");
  });

  it("the session check before sign-in reveals no server details", async () => {
    const { GET } = await import("@/app/api/automation/session/route");
    const res = await GET(new NextRequest("http://localhost/api/automation/session"));
    expect((await res.json()).storageProblem).toBeNull();
  });
});
