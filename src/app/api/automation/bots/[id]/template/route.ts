import { NextRequest, NextResponse } from "next/server";
import { isKnownBot, saveTemplate } from "@/lib/automation/bots";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { withStorage } from "@/lib/automation/withStorage";

async function handlePOST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  if (!isKnownBot(id)) return badRequest("Unknown bot.", 404);
  return guarded(async () => {
    const body = await readJson(req);
    return NextResponse.json({ template: saveTemplate(id, String(body.name ?? "")) }, { status: 201 });
  });
}

export const POST = withStorage(handlePOST);
