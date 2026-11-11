import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as keepalive } from "@/app/api/automation/keepalive/route";
import { POST as login } from "@/app/api/login/route";
import { createKeepalive } from "@/components/sessionKeepalive";
import { updateAppSettings } from "@/lib/automation/appSettings";
import { resetAutomationStores } from "@/lib/automation/testSupport";
import { SESSION_COOKIE_NAME, createSession, destroySession, isValidSession, renewSession } from "@/lib/automation/session";
import { proxy } from "@/proxy";
import { resetFailures, sessionKeyOrNull } from "./credentials";
import { SESSION_HARD_LIMIT_MS, renewSessionToken, signSession, verifySession } from "./sessionToken";

// A sliding sign-in: 60 minutes of inactivity ends it, but every real use of the page starts the 60 minutes again, and nothing
// lasts past 24 hours (a day) since the password was typed. Test values only; nothing is called over the network.

const MIN = 60_000;
const HOUR = 60 * MIN;
const LIMIT = SESSION_HARD_LIMIT_MS;
const KEY = "test-key-for-tokens";

beforeEach(() => {
  vi.stubEnv("APP_LOGIN_EMAIL", "owner@example.com");
  vi.stubEnv("APP_LOGIN_PASSWORD", "correct horse");
  vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "");
  vi.stubEnv("AUTOMATION_AUTH_DISABLED", "");
  vi.stubEnv("AUTH_SECRET", "x".repeat(48));
  resetFailures();
  // The tests below that talk about "60 idle minutes" say so explicitly; the default (a day) has its own tests at the end.
  resetAutomationStores();
  updateAppSettings({ sessionTimeoutMinutes: 60 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const cookieHeader = (token: string) => ({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
const ping = (token?: string, extra: Record<string, string> = {}) =>
  keepalive(new NextRequest("http://localhost/api/automation/keepalive", { method: "POST", headers: { ...(token ? cookieHeader(token) : {}), ...extra } }));
const cookieOf = (res: Response) => /automation_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
const maxAgeOf = (res: Response) => Number(/Max-Age=(\d+)/i.exec(res.headers.get("set-cookie") ?? "")?.[1]);

describe("the token", () => {
  it("records when the password was typed, and the first token lasts the idle time", () => {
    const t0 = 1_000_000_000_000;
    const token = signSession("a@b.c", HOUR, KEY, t0);
    expect(verifySession(token, KEY, t0 + HOUR - 1)).toBe("a@b.c");
    expect(verifySession(token, KEY, t0 + HOUR + 1)).toBeNull();
  });

  it("renewing starts the idle time again from now", () => {
    const t0 = 1_000_000_000_000;
    const token = signSession("a@b.c", HOUR, KEY, t0);
    const next = renewSessionToken(token, KEY, HOUR, t0 + 50 * MIN)!;
    expect(next.expiresAt).toBe(t0 + 110 * MIN);
    expect(verifySession(next.token, KEY, t0 + 109 * MIN)).toBe("a@b.c");
    expect(verifySession(next.token, KEY, t0 + 111 * MIN)).toBeNull();
  });

  it("an active person stays signed in for the whole 24 hours, and not a minute longer", () => {
    const t0 = 1_000_000_000_000;
    let token = signSession("a@b.c", HOUR, KEY, t0);
    // Something happens every 30 minutes for the whole 24 hours.
    for (let at = 30 * MIN; at <= LIMIT; at += 30 * MIN) {
      const next = renewSessionToken(token, KEY, HOUR, t0 + at);
      if (at < LIMIT) {
        expect(next, `renewal at ${at / MIN} minutes`).not.toBeNull();
        token = next!.token;
      }
    }
    expect(verifySession(token, KEY, t0 + LIMIT - 1)).toBe("a@b.c");
    expect(verifySession(token, KEY, t0 + LIMIT + 1)).toBeNull();
  });

  it("the last renewal is cut short by the 24 hour limit", () => {
    const t0 = 1_000_000_000_000;
    let token = signSession("a@b.c", HOUR, KEY, t0);
    for (let at = 30 * MIN; at <= LIMIT - 30 * MIN; at += 30 * MIN) token = renewSessionToken(token, KEY, HOUR, t0 + at)!.token;
    const next = renewSessionToken(token, KEY, HOUR, t0 + LIMIT - 10 * MIN)!;
    expect(next.expiresAt).toBe(t0 + SESSION_HARD_LIMIT_MS);
    expect(verifySession(next.token, KEY, t0 + SESSION_HARD_LIMIT_MS + 1)).toBeNull();
  });

  it("nothing renews once the 24 hours are over, even a token that is otherwise still inside its idle window", () => {
    const t0 = 1_000_000_000_000;
    // Forge the timing the other way round: issued 13 hours ago but with a far-off expiry, signed with the real key.
    const payload = Buffer.from(JSON.stringify({ e: "a@b.c", x: t0 + HOUR, i: t0 - (LIMIT + HOUR) })).toString("base64url");
    const token = `${payload}.${crypto.createHmac("sha256", KEY).update(payload).digest("base64url")}`;
    expect(verifySession(token, KEY, t0)).toBeNull();
    expect(renewSessionToken(token, KEY, HOUR, t0)).toBeNull();
  });

  it("a sign-in that sat idle for more than the idle time cannot be revived", () => {
    const t0 = 1_000_000_000_000;
    const token = signSession("a@b.c", HOUR, KEY, t0);
    expect(renewSessionToken(token, KEY, HOUR, t0 + HOUR + 1)).toBeNull();
  });

  it("forged, tampered and signed-with-another-key tokens are never renewed", () => {
    const token = signSession("a@b.c", HOUR, KEY);
    expect(renewSessionToken("garbage", KEY, HOUR)).toBeNull();
    expect(renewSessionToken(undefined, KEY, HOUR)).toBeNull();
    expect(renewSessionToken(token, "another-key", HOUR)).toBeNull();
    const [payload, sig] = token.split(".");
    const edited = Buffer.from(JSON.stringify({ e: "a@b.c", x: Date.now() + 99 * HOUR, i: Date.now() })).toString("base64url");
    expect(renewSessionToken(`${edited}.${sig}`, KEY, HOUR)).toBeNull();
    expect(payload).toBeTruthy();
  });

  it("an older token without a sign-in time still works until it runs out, but is not extended", () => {
    const payload = Buffer.from(JSON.stringify({ e: "a@b.c", x: Date.now() + HOUR })).toString("base64url");
    const old = `${payload}.${crypto.createHmac("sha256", KEY).update(payload).digest("base64url")}`;
    expect(verifySession(old, KEY)).toBe("a@b.c");
    expect(renewSessionToken(old, KEY, HOUR)).toBeNull();
  });

  it("the idle time cannot push the end past the 24 hours even when it is set longer", () => {
    const t0 = 1_000_000_000_000;
    const token = signSession("a@b.c", 30 * HOUR, KEY, t0);
    expect(verifySession(token, KEY, t0 + LIMIT + 1)).toBeNull();
  });
});

describe("renewSession (the signed-in person)", () => {
  it("gives a new cookie whose life is the Settings idle time, for a real session", () => {
    const token = createSession();
    const renewed = renewSession(token)!;
    expect(isValidSession(renewed.token)).toBe(true);
    expect(renewed.maxAgeSeconds).toBeGreaterThan(59 * 60 - 5);
    expect(renewed.maxAgeSeconds).toBeLessThanOrEqual(60 * 60);
  });

  it("gives nothing to a signed-out, forged or missing token, or when sign-in is off", () => {
    const token = createSession();
    destroySession(token);
    expect(renewSession(token)).toBeNull();
    expect(renewSession("forged")).toBeNull();
    expect(renewSession(undefined)).toBeNull();
    vi.stubEnv("APP_LOGIN_PASSWORD", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(renewSession(token)).toBeNull(); // sign-in is off: there is nothing to extend
  });

  it("does not need, read or change the password", () => {
    const token = createSession();
    vi.stubEnv("APP_LOGIN_PASSWORD", "a different password now"); // changing the login signs everybody out
    expect(renewSession(token)).toBeNull();
    expect(sessionKeyOrNull()).not.toBeNull();
  });
});

describe("POST /api/automation/keepalive", () => {
  it("refuses someone who isn't signed in, at the gate and in the route", async () => {
    const gate = proxy(new NextRequest("http://localhost/api/automation/keepalive", { method: "POST" }));
    expect(gate.status).toBe(401);
    expect((await ping()).status).toBe(401);
    expect((await ping("forged")).status).toBe(401);
  });

  it("the gate lets a signed-in person through", () => {
    const res = proxy(new NextRequest("http://localhost/api/automation/keepalive", { method: "POST", headers: cookieHeader(createSession()) }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("a request from another website is refused", () => {
    const res = proxy(new NextRequest("http://localhost/api/automation/keepalive", { method: "POST", headers: { ...cookieHeader(createSession()), origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
  });

  it("extends the sign-in: a new, working cookie that is HttpOnly and same-site strict", async () => {
    const token = createSession();
    const res = await ping(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, renewed: true });
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=strict/i);
    expect(header).toMatch(/Path=\//);
    expect(maxAgeOf(res)).toBeGreaterThan(59 * 60 - 5);
    expect(isValidSession(cookieOf(res))).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a signed-out cookie gets nothing", async () => {
    const token = createSession();
    destroySession(token);
    expect((await ping(token)).status).toBe(401);
  });

  it("sliding in real time: still signed in after 3 hours of use, signed out after 60 idle minutes, never past 24 hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T09:00:00Z"));
    const res = await login(
      new NextRequest("http://localhost/api/login", { method: "POST", body: JSON.stringify({ email: "owner@example.com", password: "correct horse" }), headers: { "Content-Type": "application/json", "x-forwarded-for": "9.9.9.9" } }),
    );
    expect(res.status).toBe(200);
    expect(maxAgeOf(res)).toBe(3600);
    let token = cookieOf(res)!;

    // Use the page every 20 minutes for 3 hours.
    for (let k = 1; k <= 9; k++) {
      vi.advanceTimersByTime(20 * MIN);
      expect(isValidSession(token)).toBe(true);
      token = cookieOf(await ping(token))!;
    }
    // Walk away for 61 minutes: signed out.
    vi.advanceTimersByTime(61 * MIN);
    expect(isValidSession(token)).toBe(false);
    expect((await ping(token)).status).toBe(401);
  });

  it("the 24 hour limit holds in real time, and the last cookie is only as long as what is left", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T09:00:00Z"));
    let token = createSession();
    for (let k = 0; k < 46; k++) {
      vi.advanceTimersByTime(30 * MIN);
      token = cookieOf(await ping(token))!;
    }
    // 23 hours in: a ping at 23h50 can give at most 10 more minutes.
    vi.advanceTimersByTime(50 * MIN);
    const last = await ping(token);
    expect(last.status).toBe(200);
    expect(maxAgeOf(last)).toBeLessThanOrEqual(10 * 60);
    token = cookieOf(last)!;
    vi.advanceTimersByTime(11 * MIN);
    expect(isValidSession(token)).toBe(false);
    expect((await ping(token)).status).toBe(401);
  });

  it("the sign-in cookie itself is unchanged: 60 minutes from the password", async () => {
    const res = await login(
      new NextRequest("http://localhost/api/login", { method: "POST", body: JSON.stringify({ email: "owner@example.com", password: "correct horse" }), headers: { "Content-Type": "application/json", "x-forwarded-for": "8.8.8.8" } }),
    );
    expect(maxAgeOf(res)).toBe(3600);
    const wrong = await login(
      new NextRequest("http://localhost/api/login", { method: "POST", body: JSON.stringify({ email: "owner@example.com", password: "nope" }), headers: { "Content-Type": "application/json", "x-forwarded-for": "7.7.7.7" } }),
    );
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });
});

describe("the page only pings when the person does something", () => {
  it("sends at most one request a minute and none while idle", () => {
    let now = 0;
    const ping = vi.fn(() => Promise.resolve());
    const onActivity = createKeepalive({ ping, now: () => now });
    expect(onActivity()).toBe(true);
    now += 10_000;
    expect(onActivity()).toBe(false);
    now += 49_000;
    expect(onActivity()).toBe(false);
    now += 2_000;
    expect(onActivity()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(2);
    now += 3 * HOUR; // idle for hours: nothing is called, because nothing calls it
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("a failed request is swallowed, not thrown into the page", () => {
    const onActivity = createKeepalive({ ping: () => Promise.reject(new Error("fetch failed")), now: () => 0 });
    expect(() => onActivity()).not.toThrow();
  });
});

describe("the default is a day", () => {
  const loginReq = (ip: string) => login(new NextRequest("http://localhost/api/login", { method: "POST", body: JSON.stringify({ email: "owner@example.com", password: "correct horse" }), headers: { "Content-Type": "application/json", "x-forwarded-for": ip } }));

  it("a day is one of the choices, and the hard limit is a day", async () => {
    const { SESSION_TIMEOUT_CHOICES, DEFAULT_APP_SETTINGS } = await import("@/lib/automation/appSettings");
    expect(SESSION_TIMEOUT_CHOICES).toContain(1440);
    expect(DEFAULT_APP_SETTINGS.sessionTimeoutMinutes).toBe(1440);
    expect(LIMIT).toBe(24 * HOUR);
  });

  it("with nothing saved, a sign-in cookie lasts a day, and every renewal gives a day (until the day since the password is over)", async () => {
    resetAutomationStores(); // nothing saved: the default applies
    const res = await loginReq("5.5.5.5");
    expect(maxAgeOf(res)).toBe(24 * 3600);
    const renewed = renewSession(cookieOf(res))!;
    expect(renewed.maxAgeSeconds).toBeGreaterThan(24 * 3600 - 5);
    expect(renewed.maxAgeSeconds).toBeLessThanOrEqual(24 * 3600);
  });

  it("a day of use keeps you signed in; a day of doing nothing, or 24 hours since the password, ends it", async () => {
    resetAutomationStores();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T09:00:00Z"));
    let token = createSession();
    // Used every 3 hours: signed in the whole time.
    for (let k = 0; k < 7; k++) {
      vi.advanceTimersByTime(3 * HOUR);
      expect(isValidSession(token)).toBe(true);
      token = cookieOf(await ping(token))!;
    }
    // 21 hours in. Another 2h50 of use is still fine, and the last cookie is only as long as the day has left.
    vi.advanceTimersByTime(2 * HOUR + 50 * MIN);
    const last = await ping(token);
    expect(last.status).toBe(200);
    expect(maxAgeOf(last)).toBeLessThanOrEqual(10 * 60);
    token = cookieOf(last)!;
    vi.advanceTimersByTime(11 * MIN);
    expect(isValidSession(token)).toBe(false);
  });

  it("untouched for a day, a sign-in is over (before the day since the password, when the idle time is the shorter)", async () => {
    resetAutomationStores();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T09:00:00Z"));
    const token = createSession();
    vi.advanceTimersByTime(23 * HOUR + 59 * MIN);
    expect(isValidSession(token)).toBe(true);
    vi.advanceTimersByTime(2 * MIN);
    expect(isValidSession(token)).toBe(false);
  });

  it("the old choices still work, and a value that is not a choice is still refused", () => {
    updateAppSettings({ sessionTimeoutMinutes: 480 });
    expect(() => updateAppSettings({ sessionTimeoutMinutes: 1000 })).toThrow(/30, 60, 120, 240, 480, 1440/);
  });
});
