import crypto from "node:crypto";

/**
 * A sign-in is a signed cookie value, `<payload>.<signature>`, with the account and an expiry inside it. Nothing is kept
 * on the server, so the proxy (which runs apart from the pages and routes) and every route agree on who is signed in, and
 * a restart doesn't sign anyone out. The signing key is derived from the login itself: changing the email or the
 * password signs everybody out.
 */

const b64 = (s: string) => Buffer.from(s).toString("base64url");

function sign(payload: string, key: string): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

/**
 * The most a sign-in can last, however active the person is: 24 hours (a day) from the moment they typed the password. A sliding
 * timeout (see renewSessionToken) moves the end of the idle window, never past this.
 */
export const SESSION_HARD_LIMIT_MS = 24 * 60 * 60_000;

/** `issuedAt` is when the password was typed. It stays the same through every renewal, and the hard limit counts from it. */
export function signSession(email: string, ttlMs: number, key: string, now: number = Date.now(), issuedAt: number = now): string {
  const x = Math.min(now + ttlMs, issuedAt + SESSION_HARD_LIMIT_MS);
  const payload = b64(JSON.stringify({ e: email, x, i: issuedAt }));
  return `${payload}.${sign(payload, key)}`;
}

type SessionPayload = { e: string; x: number; i?: number };

/** The contents of a token that is genuine, unexpired and inside the hard limit, or null. */
function readSession(token: string | undefined | null, key: string, now: number): SessionPayload | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = sign(payload, key);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const { e, x, i } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { e?: unknown; x?: unknown; i?: unknown };
    if (typeof e !== "string" || typeof x !== "number" || now > x) return null;
    if (i !== undefined && (typeof i !== "number" || now > i + SESSION_HARD_LIMIT_MS)) return null;
    return { e, x, i };
  } catch {
    return null;
  }
}

/** The account the token was issued to, or null when it is forged, tampered with, expired or past the 24 hour hard limit. */
export function verifySession(token: string | undefined | null, key: string, now: number = Date.now()): string | null {
  return readSession(token, key, now)?.e ?? null;
}

/**
 * A fresh token for someone who is still using the app: the idle window starts again from `now`, but the end can never go
 * past 24 hours after the original sign-in. Null when the token is not valid, is already past the hard limit, or is an
 * older kind of token that doesn't record when it was issued (those simply run out and the person signs in again).
 */
export function renewSessionToken(token: string | undefined | null, key: string, idleMs: number, now: number = Date.now()): { token: string; expiresAt: number } | null {
  const current = readSession(token, key, now);
  if (!current || current.i === undefined) return null;
  const next = signSession(current.e, idleMs, key, now, current.i);
  const expiresAt = Math.min(now + idleMs, current.i + SESSION_HARD_LIMIT_MS);
  return { token: next, expiresAt };
}
