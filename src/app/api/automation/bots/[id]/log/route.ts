import { NextRequest, NextResponse } from "next/server";
import { ensureBotRecord, isKnownBot } from "@/lib/automation/bots";
import { badRequest, unauthorized } from "@/lib/automation/routeAuth";
import { botsStore } from "@/lib/automation/store";
import { withStorage } from "@/lib/automation/withStorage";

/** "Clear Log": hides everything so far from the Log view. Nothing is deleted -
 * the engine's duplicate protection and the export still see every signal. */
async function handleDELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  if (!isKnownBot(id)) return badRequest("Unknown bot.", 404);
  ensureBotRecord(id);
  botsStore.update(id, { logClearedAt: Date.now() });
  return NextResponse.json({ ok: true });
}

export const DELETE = withStorage(handleDELETE);
