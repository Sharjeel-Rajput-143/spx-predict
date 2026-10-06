import { NextRequest, NextResponse } from "next/server";
import { guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { deleteWebhook, updateWebhook } from "@/lib/automation/webhooks";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  return guarded(async () => {
    const body = await readJson(req);
    const w = updateWebhook(id, { name: typeof body.name === "string" ? body.name : undefined, active: typeof body.active === "boolean" ? body.active : undefined });
    return NextResponse.json({ webhook: { id: w.id, name: w.name, active: w.active } });
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  return guarded(async () => {
    deleteWebhook(id);
    return NextResponse.json({ ok: true });
  });
}
