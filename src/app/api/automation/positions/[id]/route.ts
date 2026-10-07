import { NextRequest, NextResponse } from "next/server";
import { withBotLock } from "@/lib/automation/botLock";
import { deletePosition, updatePositionMeta } from "@/lib/automation/positionsAdmin";
import { positionsStore } from "@/lib/automation/store";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { withStorage } from "@/lib/automation/withStorage";

/** Edit a position's tags and notes. */
async function handlePATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  return guarded(async () => {
    const body = await readJson(req);
    if (body.tags === undefined && body.notes === undefined) return badRequest("Nothing to update.");
    return NextResponse.json({ position: updatePositionMeta(id, { tags: body.tags as string[] | undefined, notes: body.notes as string | undefined }) });
  });
}

/** Remove a finished position (and its orders) from the records. An open or closing one is refused. */
async function handleDELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  const position = positionsStore.get(id);
  if (!position) return badRequest("Position not found.", 404);
  try {
    await withBotLock(position.botId, async () => deletePosition(id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err), 409);
  }
}

export const PATCH = withStorage(handlePATCH);
export const DELETE = withStorage(handleDELETE);
