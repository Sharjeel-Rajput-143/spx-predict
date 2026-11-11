import { NextRequest, NextResponse } from "next/server";
import { BTC_BOT_ID } from "@/lib/automation/bots";
import { openByHand } from "@/lib/automation/manualOpen";
import { guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * The Open UP / Open DOWN buttons on the DEMO Bybit page. { direction: "up" | "down" } opens a trade on the demo bot at once (no confirm: it is paper money), through the same engine and
 * rules as a TradingView signal. It is never copied to the live bot. A refusal says why in plain words.
 */
async function handlePOST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const body = await readJson(req);
    const r = await openByHand(BTC_BOT_ID, body.direction);
    return r.ok ? NextResponse.json({ ok: true, message: r.message }) : NextResponse.json({ error: r.error }, { status: r.status });
  });
}

export const POST = withStorage(handlePOST);
