import { NextRequest, NextResponse } from "next/server";
import { buildBybitView, bybitBotId } from "@/lib/automation/bybitView";
import { guarded, unauthorized } from "@/lib/automation/routeAuth";
import { bybitExecutor } from "@/lib/automation/sharedExecutor";
import { withStorage } from "@/lib/automation/withStorage";

/** The Bybit page's data: the open trade as Bybit reports it right now, Bybit's own list of closed trades, and the totals. Read-only; nothing here can trade. */
async function handleGET(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const bybit = bybitExecutor();
    if (!bybit) return NextResponse.json({ active: false });
    const botId = bybitBotId(bybit);
    if (!botId) return NextResponse.json({ active: true, view: null, error: "No bot trades the underlying that is sent to Bybit." });
    return NextResponse.json({ active: true, botId, view: await buildBybitView(bybit, botId, bybit.symbol, Date.now(), { cacheHistory: true }) });
  });
}

export const GET = withStorage(handleGET);
