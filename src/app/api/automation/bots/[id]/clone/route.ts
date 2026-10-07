import { NextRequest, NextResponse } from "next/server";
import { cloneBot, isKnownBot } from "@/lib/automation/bots";
import { badRequest, guarded, unauthorized } from "@/lib/automation/routeAuth";
import { withStorage } from "@/lib/automation/withStorage";

async function handlePOST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  if (!isKnownBot(id)) return badRequest("Unknown bot.", 404);
  return guarded(async () => NextResponse.json({ bot: { id: cloneBot(id).id } }, { status: 201 }));
}

export const POST = withStorage(handlePOST);
