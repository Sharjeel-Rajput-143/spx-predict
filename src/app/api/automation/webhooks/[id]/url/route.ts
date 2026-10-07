import { NextRequest, NextResponse } from "next/server";
import { badRequest, unauthorized } from "@/lib/automation/routeAuth";
import { webhooksStore } from "@/lib/automation/store";
import { webhookUrlPath } from "@/lib/automation/webhooks";

/** The full webhook URL path, with its secret. Everywhere else the URL is masked; a person asks for this one on
 * purpose (Reveal, or Copy for TradingView). Signed-in only, and never cached. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  const hook = webhooksStore.get(id);
  if (!hook) return badRequest("Webhook not found.", 404);
  return NextResponse.json({ path: webhookUrlPath(hook) }, { headers: { "Cache-Control": "no-store" } });
}
