import "server-only";
import { getAppSettings } from "./appSettings";
import { isAuthRequired } from "./config";

import { loginEmail, sessionKeyOrNull } from "@/lib/auth/credentials";
import { userIdForEmail } from "@/lib/auth/users";
import { signSession, verifySession } from "@/lib/auth/sessionToken";

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
