import { NextRequest, NextResponse } from "next/server";
import { unauthorized } from "@/lib/automation/routeAuth";
import { templatesStore } from "@/lib/automation/store";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  return templatesStore.remove(id) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Template not found." }, { status: 404 });
}
