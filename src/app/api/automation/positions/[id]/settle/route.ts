import { NextRequest, NextResponse } from "next/server";
import { withBotLock } from "@/lib/automation/botLock";
import { enterPositionPL } from "@/lib/automation/positionsAdmin";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { positionsStore } from "@/lib/automation/store";

/** "Enter P/L": a person types in the result of a position that expired without a fill to price it by. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  const position = positionsStore.get(id);
  if (!position) return badRequest("Position not found.", 404);

  return guarded(async () => {
    const body = await readJson(req);
    const updated = await withBotLock(position.botId, async () => enterPositionPL(id, body.pl));
    return NextResponse.json({ position: updated });
  });
}
