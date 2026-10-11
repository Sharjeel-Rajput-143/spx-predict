import "server-only";
import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

const sameSecret = (given: string, secret: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * The scheduler's jobs (/api/cron/...) are open to the scheduler but not to anyone else: they must carry `Authorization: Bearer <CRON_SECRET>`
 * (Vercel adds that itself for its own cron; any other scheduler is told to send it). With no CRON_SECRET set they refuse everything, so
 * they can't be called by accident. Returns the refusal, or null when the call is allowed.
 */
export function cronRefusal(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET isn't set, so the scheduled job is switched off." }, { status: 503 });
  if (!sameSecret(req.headers.get("authorization") ?? "", secret)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  return null;
}
