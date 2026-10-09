import { NextRequest, NextResponse } from "next/server";
import { guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { deleteWebhook, updateWebhook } from "@/lib/automation/webhooks";
import { withStorage } from "@/lib/automation/withStorage";

async function handlePATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  return guarded(async () => {
    const body = await readJson(req);
    const w = updateWebhook(id, { name: typeof body.name === "string" ? body.name : undefined, active: typeof body.active === "boolean" ? body.active : undefined, requireDirectionText: typeof body.requireDirectionText === "boolean" ? body.requireDirectionText : undefined });
    return NextResponse.json({ webhook: { id: w.id, name: w.name, active: w.active, requireDirectionText: w.requireDirectionText !== false } });
  });
}

async function handleDELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  return guarded(async () => {
    deleteWebhook(id);
    return NextResponse.json({ ok: true });
  });
}

export const PATCH = withStorage(handlePATCH);
export const DELETE = withStorage(handleDELETE);
