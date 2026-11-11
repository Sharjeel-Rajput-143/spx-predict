import { NextRequest, NextResponse } from "next/server";
import { LIVE_BOT_ID } from "@/lib/automation/bybitLiveLimits";
import { buildBybitView } from "@/lib/automation/bybitView";
import { guarded, unauthorized } from "@/lib/automation/routeAuth";
import { liveBybitExecutor, liveExecutorProblem } from "@/lib/automation/sharedExecutor";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * The LIVE bot's trades for its own page (Positions tab): the open trade as the LIVE Bybit account reports it, the LIVE account's closed trades, and the totals, all for the live bot only.
 * It never reads the demo account, the demo executor or the demo bot: the demo page has its own route (/api/automation/bybit). Without a live key there is no live account to read, so
 * nothing is asked of Bybit and the page says "no live trades yet". Read-only; nothing here can trade; never returns a key.
 */
async function handleGET(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const live = liveBybitExecutor();
    if (!live) return NextResponse.json({ active: false, noKey: true, reason: liveExecutorProblem() ?? "There is no live key." });
    return NextResponse.json({ active: true, botId: LIVE_BOT_ID, view: await buildBybitView(live, LIVE_BOT_ID, live.symbol, Date.now(), { cacheHistory: true }) });
  });
}

export const GET = withStorage(handleGET);
