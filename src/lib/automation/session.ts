import "server-only";
import crypto from "node:crypto";
import { getAppSettings } from "./appSettings";
import { isAuthRequired } from "./config";

/** In-memory session tokens for the status page's simple password auth -
 * lost on restart, which is fine for a Phase 1 single-process demo. Held on
 * globalThis because Next bundles route handlers and server-rendered pages as
 * separate module graphs: a plain module-level Set would be a different Set in
 * the login route than in the page that checks it. */
const globalForSessions = globalThis as typeof globalThis & { __automationSessions?: Map<string, number> };
// token -> when it was created (a sign-in expires after the Settings page's session timeout).
const sessions: Map<string, number> =
  globalForSessions.__automationSessions instanceof Map ? globalForSessions.__automationSessions : (globalForSessions.__automationSessions = new Map<string, number>());

export const SESSION_COOKIE_NAME = "automation_session";

export function createSession(): string {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now());
  return token;
}

export function isValidSession(token: string | undefined | null): boolean {
  if (!isAuthRequired()) return true;
  if (!token) return false;
  const created = sessions.get(token);
  if (created === undefined) return false;
  if (Date.now() - created > getAppSettings().sessionTimeoutMinutes * 60_000) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token: string | undefined | null): void {
  if (token) sessions.delete(token);
}
