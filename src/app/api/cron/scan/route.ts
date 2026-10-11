import { NextRequest, NextResponse } from "next/server";
import { cronRefusal } from "@/lib/automation/cronAuth";
import { runDueEntryRetries } from "@/lib/automation/entryRetry";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * The once-a-minute look for an open that an alert asked for and that was dropped (see entryRetry.ts), for a host that doesn't stay running
 * (Vercel). Vercel's own scheduler can't run this often on the free plan, so point any outside scheduler (a free cron service) at
 * GET /api/cron/scan every minute, sending `Authorization: Bearer <CRON_SECRET>`. A server that stays up does the same by itself every minute
 * and doesn't need this. Quiet when there is nothing to do.
 */
export const maxDuration = 60;

async function handleGET(req: NextRequest) {
  const refused = cronRefusal(req);
  if (refused) return refused;
  const results = await runDueEntryRetries(Date.now());
  return NextResponse.json({ ok: true, retried: results.filter((r) => r.retried).map((r) => r.botId) });
}

export const GET = withStorage(handleGET);
