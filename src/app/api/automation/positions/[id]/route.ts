import { NextRequest, NextResponse } from "next/server";
import { updatePositionMeta } from "@/lib/automation/positionsAdmin";
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

export const PATCH = withStorage(handlePATCH);
