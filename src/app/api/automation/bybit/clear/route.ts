import { NextRequest, NextResponse } from "next/server";
import { clearBybitHistory, bybitBotId } from "@/lib/automation/bybitView";
import { guarded, unauthorized } from "@/lib/automation/routeAuth";
import { bybitExecutor } from "@/lib/automation/sharedExecutor";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * Clears the trade history on the Bybit page: the list is hidden and "total since cleared" restarts. Nothing is deleted at Bybit or in the bot's records, and the daily
 * loss limit is not touched (it is counted on the bot's own records, whatever was cleared). Needs a signed-in session.
 */
async function handlePOST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const bybit = bybitExecutor();
    const botId = bybit ? bybitBotId(bybit) : null;
    if (!bybit || !botId) return NextResponse.json({ error: "Bybit is not the broker right now." }, { status: 409 });
    clearBybitHistory(botId);
    return NextResponse.json({ ok: true });
  });
}

export const POST = withStorage(handlePOST);
