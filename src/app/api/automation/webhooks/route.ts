import { NextRequest, NextResponse } from "next/server";
import { botDisplayName } from "@/lib/automation/bots";
import { guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { webhooksStore } from "@/lib/automation/store";
import { createWebhook, webhookUnderlying, webhookUrlPath } from "@/lib/automation/webhooks";
import type { Webhook } from "@/lib/automation/types";

const view = (w: Webhook) => ({ ...w, botName: botDisplayName(w.botId), underlying: webhookUnderlying(w.botId), path: webhookUrlPath(w) });

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
    const hook = createWebhook({ name: String(body.name ?? ""), botId: String(body.botId ?? ""), direction: body.direction as "bullish" | "bearish" });
    return NextResponse.json({ webhook: view(hook) }, { status: 201 });
  });
}
