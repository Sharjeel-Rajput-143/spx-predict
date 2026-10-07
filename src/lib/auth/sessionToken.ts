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

export function signSession(email: string, ttlMs: number, key: string, now: number = Date.now()): string {
  const payload = b64(JSON.stringify({ e: email, x: now + ttlMs }));
  return `${payload}.${sign(payload, key)}`;
}

/** The account the token was issued to, or null when it is forged, tampered with or expired. */
export function verifySession(token: string | undefined | null, key: string, now: number = Date.now()): string | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = sign(payload, key);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { e?: unknown; x?: unknown };
    if (typeof e !== "string" || typeof x !== "number" || now > x) return null;
    return e;
  } catch {
    return null;
  }
}
