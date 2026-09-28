import "server-only";

/** Simple in-memory fixed-window limiter (spec 5.2) - fine for the single
 * demo user this app has today; a multi-instance deployment would need a
 * shared store (Redis, etc.) instead. */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(userId: string, action: string, limit: number, windowMs: number): boolean {
  const key = `${action}:${userId}`;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}
