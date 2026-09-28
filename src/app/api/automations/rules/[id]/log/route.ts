import { NextRequest, NextResponse } from "next/server";
import { DEMO_USER_ID, rulesStore, triggerLogStore } from "@/lib/automations/store";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rule = rulesStore.get(id);
  if (!rule || rule.userId !== DEMO_USER_ID) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const log = triggerLogStore
    .query((l) => l.ruleId === id)
    .sort((a, b) => b.firedAt - a.firedAt)
    .slice(0, 50);
  return NextResponse.json({ log });
}
