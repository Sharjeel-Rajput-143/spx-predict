import { NextRequest, NextResponse } from "next/server";
import { isKnownBot, saveTemplate } from "@/lib/automation/bots";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  if (!isKnownBot(id)) return badRequest("Unknown bot.", 404);
  return guarded(async () => {
    const body = await readJson(req);
    return NextResponse.json({ template: saveTemplate(id, String(body.name ?? "")) }, { status: 201 });
  });
}
