import { NextRequest, NextResponse } from "next/server";
import { describeRule } from "@/lib/automations/describe";
import { DEMO_USER_ID, rulesStore } from "@/lib/automations/store";
import type { AlertRule } from "@/lib/automations/types";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = rulesStore.get(id);
  if (!existing || existing.userId !== DEMO_USER_ID) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const patch: Partial<AlertRule> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.message === "string") patch.message = body.message.trim() || undefined;

  const updated = rulesStore.update(id, patch);
  return NextResponse.json({ rule: updated ? { ...updated, description: describeRule(updated) } : null });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = rulesStore.get(id);
  if (!existing || existing.userId !== DEMO_USER_ID) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  rulesStore.remove(id);
  return NextResponse.json({ ok: true });
}
