import { NextRequest, NextResponse } from "next/server";
import { guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { webhooksStore } from "@/lib/automation/store";
import { createWebhook, webhookView } from "@/lib/automation/webhooks";

const view = webhookView;

export async function GET(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return NextResponse.json({ webhooks: webhooksStore.all().reverse().sort((a, b) => b.createdAt - a.createdAt).map(view) });
}

export async function POST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const body = await readJson(req);
    const hook = createWebhook({ name: String(body.name ?? ""), botId: typeof body.botId === "string" && body.botId ? body.botId : null, direction: body.direction === "bullish" || body.direction === "bearish" ? body.direction : null });
    return NextResponse.json({ webhook: view(hook) }, { status: 201 });
  });
}
