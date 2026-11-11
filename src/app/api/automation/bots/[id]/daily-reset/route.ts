import { NextRequest, NextResponse } from "next/server";
import { ensureBotRecord, isKnownBot } from "@/lib/automation/bots";
import { LIVE_BOT_ID } from "@/lib/automation/bybitLiveLimits";
import { badRequest, unauthorized } from "@/lib/automation/routeAuth";
import { botsStore } from "@/lib/automation/store";
import { withStorage } from "@/lib/automation/withStorage";

/** Resets today's "positions opened" counter against the daily limit (the demo and other bots; never the live bot). */
async function handlePOST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  if (!isKnownBot(id)) return badRequest("Unknown bot.", 404);
  // The live bot's trades-a-day count cannot be restarted from a page (the ceiling is written in the code); the count ignores any reset anyway (safeguards.ts).
  if (id === LIVE_BOT_ID) return badRequest("The live bot's trades-a-day count cannot be reset. It restarts by itself on the next New York day.", 409);
  ensureBotRecord(id);
  botsStore.update(id, { dailyResetAt: Date.now() });
  return NextResponse.json({ ok: true });
}

export const POST = withStorage(handlePOST);
