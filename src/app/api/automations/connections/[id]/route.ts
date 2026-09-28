import { NextRequest, NextResponse } from "next/server";
import { connectionsStore, DEMO_USER_ID, rulesStore } from "@/lib/automations/store";
import type { AlertConnection, AlertConnectionView } from "@/lib/automations/types";

function toView(c: AlertConnection): AlertConnectionView {
  const { webhookUrlEncrypted: _omit, ...view } = c;
  return view;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = connectionsStore.get(id);
  if (!existing || existing.userId !== DEMO_USER_ID) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const patch: Partial<AlertConnection> = {};
  if (typeof body.label === "string" && body.label.trim()) patch.label = body.label.trim();
  if (typeof body.active === "boolean") patch.active = body.active;

  const updated = connectionsStore.update(id, patch);
  return NextResponse.json({ connection: updated ? toView(updated) : null });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = connectionsStore.get(id);
  if (!existing || existing.userId !== DEMO_USER_ID) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const inUse = rulesStore.query((r) => r.connectionId === id).length > 0;
  if (inUse) {
    return NextResponse.json({ error: "Delete or reassign the rules using this connection first." }, { status: 409 });
  }
  connectionsStore.remove(id);
  return NextResponse.json({ ok: true });
}
