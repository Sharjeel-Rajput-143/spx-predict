import { NextRequest, NextResponse } from "next/server";
import { ensureBotRecord, isKnownBot } from "@/lib/automation/bots";
import { badRequest, unauthorized } from "@/lib/automation/routeAuth";
import { botsStore } from "@/lib/automation/store";

/** Resets today's "positions opened" counter against the daily limit. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  if (!isKnownBot(id)) return badRequest("Unknown bot.", 404);
  ensureBotRecord(id);
  botsStore.update(id, { dailyResetAt: Date.now() });
  return NextResponse.json({ ok: true });
}
