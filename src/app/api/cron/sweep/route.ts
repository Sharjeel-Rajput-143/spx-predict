import { NextRequest, NextResponse } from "next/server";
import { cronRefusal } from "@/lib/automation/cronAuth";
import { runDueSweeps } from "@/lib/automation/eodSweep";
import { settleExpiredFromClose } from "@/lib/automation/settleExpired";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * The end-of-day job for a host that doesn't stay running (Vercel): called once a day by the host's scheduler (vercel.json), it does what
 * the always-on server's every-minute clock does after the close - expires whatever each bot still holds (the bot's own sweep mode and
 * time apply) and works out the result of any expired position from that day's closing price.
 *
 * Open to the scheduler but not to anyone else: it must carry `Authorization: Bearer <CRON_SECRET>` (Vercel adds that itself when the
 * CRON_SECRET environment variable is set). With no CRON_SECRET set it refuses everything, so it can't be called by accident.
 */
export const maxDuration = 60;

async function handleGET(req: NextRequest) {
  const refused = cronRefusal(req);
  if (refused) return refused;

  const now = Date.now();
  const swept = await runDueSweeps(now);
  const settled = await settleExpiredFromClose({ now });
  return NextResponse.json({ ok: true, swept, settled });
}

export const GET = withStorage(handleGET);
