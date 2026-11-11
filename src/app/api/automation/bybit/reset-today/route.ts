import { NextRequest, NextResponse } from "next/server";
import { resetBybitToday, bybitBotId } from "@/lib/automation/bybitView";
import { guarded, unauthorized } from "@/lib/automation/routeAuth";
import { bybitExecutor } from "@/lib/automation/sharedExecutor";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * Restarts the "Today" figure on the Bybit page from now (it counts trades closed after this). Display only: nothing is deleted at Bybit or in the bot's records, and the
 * daily loss limit, which is counted on the bot's own records, is not touched. Needs a signed-in session.
 */
async function handlePOST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const bybit = bybitExecutor();
    const botId = bybit ? bybitBotId(bybit) : null;
    if (!bybit || !botId) return NextResponse.json({ error: "Bybit is not the broker right now." }, { status: 409 });
    resetBybitToday(botId);
    return NextResponse.json({ ok: true });
  });
}

export const POST = withStorage(handlePOST);
