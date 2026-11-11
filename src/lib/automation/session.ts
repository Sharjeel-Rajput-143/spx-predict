import "server-only";
import { getAppSettings } from "./appSettings";
import { isAuthRequired } from "./config";

import { loginEmail, sessionKeyOrNull } from "@/lib/auth/credentials";
import { userIdForEmail } from "@/lib/auth/users";
import { renewSessionToken, signSession, verifySession } from "@/lib/auth/sessionToken";

export const SESSION_COOKIE_NAME = "automation_session";

// A signed-out token is refused even before it expires (kept in memory: a restart forgets it, the expiry still ends it).
const globalForSessions = globalThis as typeof globalThis & { __signedOutSessions?: Set<string> };
const signedOut: Set<string> = (globalForSessions.__signedOutSessions ??= new Set<string>());

/** A signed cookie value for the signed-in person; it expires after the Settings page's session timeout. */
export function createSession(): string {
  const key = sessionKeyOrNull();
  if (!key) throw new Error("AUTH_SECRET is not set.");
  return signSession(loginEmail() || "operator", getAppSettings().sessionTimeoutMinutes * 60_000, key);
}

/**
 * A sliding timeout: for someone who is still using the app, a new cookie value whose idle window (the Settings page's
 * session timeout) starts again now. It never runs past 24 hours after the original sign-in, a signed-out token gets
 * nothing, and the password is never involved. Null = nothing to renew (not signed in, past the hard limit, or sign-in is off).
 */
export function renewSession(token: string | undefined | null, now: number = Date.now()): { token: string; maxAgeSeconds: number } | null {
  if (!isAuthRequired() || !token || signedOut.has(token)) return null;
  const key = sessionKeyOrNull();
  if (!key) return null;
  const next = renewSessionToken(token, key, getAppSettings().sessionTimeoutMinutes * 60_000, now);
  return next ? { token: next.token, maxAgeSeconds: Math.max(1, Math.floor((next.expiresAt - now) / 1000)) } : null;
}

export function isValidSession(token: string | undefined | null): boolean {
  if (!isAuthRequired()) return true;
  if (!token || signedOut.has(token)) return false;
  const key = sessionKeyOrNull();
  return key !== null && verifySession(token, key) !== null;
}

export function destroySession(token: string | undefined | null): void {
  if (token) signedOut.add(token);
}

/** Who a session cookie belongs to (a user id), or null: nobody is signed in, or sign-in is off (then the engine's own, unrestricted view applies). */
export function sessionUserId(token: string | undefined | null): string | null {
  if (!isAuthRequired() || !token || signedOut.has(token)) return null;
  const key = sessionKeyOrNull();
  const email = key ? verifySession(token, key) : null;
  return email ? userIdForEmail(email) : null;
}
