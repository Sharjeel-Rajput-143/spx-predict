import crypto from "node:crypto";

/**
 * The one login of this app, for now: an email and a password set in the environment (.env.local on this machine, the
 * host's environment settings on a server). Nothing is stored in the code or the data folder. With no password set there
 * is no sign-in, as before.
 *
 *   APP_LOGIN_EMAIL     the email to sign in with (when blank, any email is accepted and only the password counts)
 *   APP_LOGIN_PASSWORD  the password (AUTOMATION_STATUS_PASSWORD, the older name, still works)
 */

export const loginEmail = (): string => (process.env.APP_LOGIN_EMAIL ?? "").trim().toLowerCase();
export const loginPassword = (): string => process.env.APP_LOGIN_PASSWORD || process.env.AUTOMATION_STATUS_PASSWORD || "";
export const loginConfigured = (): boolean => loginPassword() !== "";

/** Sign-in can be switched off on purpose (a demo); never when real money is in play. */
export const loginSwitchedOff = (): boolean => process.env.AUTOMATION_AUTH_DISABLED === "true" && process.env.TRADIER_ALLOW_PRODUCTION !== "true";

/**
 * The key sessions are signed with: AUTH_SECRET, a long random value that is not the password (a key derived from the
 * password could be guessed offline from a stolen cookie). It must be at least 32 characters. Without it a production
 * server refuses to sign anyone in; only in development is a key derived from the login, so a laptop needs no setup.
 * Changing AUTH_SECRET, the email or the password signs everybody out.
 */
export const MIN_SECRET_LENGTH = 32;
export function sessionKeyOrNull(): string | null {
  const secret = process.env.AUTH_SECRET ?? "";
  if (secret.length >= MIN_SECRET_LENGTH) return crypto.createHash("sha256").update(`spx-session|${secret}|${loginEmail()}|${loginPassword()}`).digest("hex");
  if (process.env.NODE_ENV === "production") return null;
  return crypto.createHash("sha256").update(`spx-session-dev|${loginEmail()}|${loginPassword()}`).digest("hex");
}
export const SECRET_MISSING = "Sign-in is switched off until AUTH_SECRET is set: a random value of at least 32 characters in the server's environment (generate one with: openssl rand -base64 48).";

/** The longest email or password looked at: a longer one is refused without being hashed (no cost to a flood of huge bodies). */
export const MAX_FIELD_LENGTH = 256;

const digest = (s: string) => crypto.createHash("sha256").update(s).digest();
const same = (a: string, b: string) => crypto.timingSafeEqual(digest(a), digest(b));

/** Compares both parts in constant time, so the answer doesn't depend on how much of the guess was right. */
export function checkCredentials(email: unknown, password: unknown): boolean {
  if (!loginConfigured() || typeof password !== "string" || password.length > MAX_FIELD_LENGTH) return false;
  if (typeof email === "string" && email.length > MAX_FIELD_LENGTH) return false;
  const emailOk = loginEmail() === "" || (typeof email === "string" && same(email.trim().toLowerCase(), loginEmail()));
  const passwordOk = same(password, loginPassword());
  return emailOk && passwordOk;
}

// Too many wrong tries are refused for a while. Counted per address AND for the whole login together: a caller can fake
// the address header, so the overall count is the one that can't be dodged (at the price that an attacker can make the
// owner wait 15 minutes, which is the better way to fail). Kept in memory: a restart clears it.
const MAX_FAILURES = 5;
const MAX_FAILURES_OVERALL = 15;
const LOCKOUT_MS = 15 * 60_000;
const ALL = "*all*";
const g = globalThis as typeof globalThis & { __loginFailures?: Map<string, { count: number; since: number }> };
const failures = (g.__loginFailures ??= new Map());

function countFor(who: string, now: number): number {
  const f = failures.get(who);
  if (!f) return 0;
  if (now - f.since > LOCKOUT_MS) {
    failures.delete(who);
    return 0;
  }
  return f.count;
}
export const lockedOut = (who: string, now: number = Date.now()): boolean => countFor(who, now) >= MAX_FAILURES || countFor(ALL, now) >= MAX_FAILURES_OVERALL;

export function recordFailure(who: string, now: number = Date.now()): void {
  for (const key of [who, ALL]) {
    const f = failures.get(key);
    if (!f || now - f.since > LOCKOUT_MS) failures.set(key, { count: 1, since: now });
    else f.count++;
  }
}
/** For tests: forget every wrong try. */
export const resetFailures = (): void => failures.clear();
export const clearFailures = (who: string): void => void failures.delete(who);

/** Where to go after signing in: only a path on this site, never another address. */
export function safeNext(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\") || next.startsWith("/login") || next.startsWith("/api/")) return "/automations";
  return next;
}
