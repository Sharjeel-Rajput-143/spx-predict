import { NextRequest, NextResponse } from "next/server";
import { LIVE_BOT_ID } from "@/lib/automation/bybitLiveLimits";
import { openByHand } from "@/lib/automation/manualOpen";
import { guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * The Open UP / Open DOWN buttons on the LIVE page. { direction: "up" | "down", confirm: true } opens a REAL-MONEY trade on the live bot only if the Live trading toggle is ON, a live key is
 * present and the account check passes right now, through the same engine and rules as a signal trade. It is never copied to the demo bot. A refusal says why in plain words.
 */
async function handlePOST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const body = await readJson(req);
    const r = await openByHand(LIVE_BOT_ID, body.direction, { confirmed: body.confirm });
    return r.ok ? NextResponse.json({ ok: true, message: r.message }) : NextResponse.json({ error: r.error }, { status: r.status });
  });
}

export const POST = withStorage(handlePOST);
