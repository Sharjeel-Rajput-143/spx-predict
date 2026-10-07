import "server-only";
import { getAppSettings } from "./appSettings";
import { isAuthRequired } from "./config";

import { loginEmail, sessionKeyOrNull } from "@/lib/auth/credentials";
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
