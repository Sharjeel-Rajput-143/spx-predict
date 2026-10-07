import { NextRequest, NextResponse } from "next/server";
import { withBotLock } from "@/lib/automation/botLock";
import { isKnownBot } from "@/lib/automation/bots";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { attachWebhook, detachTrigger, optionsForTrigger, webhookForTrigger, webhookView } from "@/lib/automation/webhooks";
import type { SignalDirection } from "@/lib/automation/types";

type Ctx = { params: Promise<{ id: string; dir: string }> };

async function resolve(ctx: Ctx): Promise<{ botId: string; direction: SignalDirection } | NextResponse> {
  const { id, dir } = await ctx.params;
  if (!isKnownBot(id)) return badRequest("Unknown bot.", 404);
  if (dir !== "bullish" && dir !== "bearish") return badRequest('The trigger must be "bullish" or "bearish".', 404);
  return { botId: id, direction: dir };
}

const state = (botId: string, direction: SignalDirection) => {
  const current = webhookForTrigger(botId, direction);
  return { current: current ? webhookView(current) : null, options: optionsForTrigger(botId, direction) };
};

/** A trigger's webhook: the one attached (URL masked) and every webhook as a dropdown option with its status. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const r = await resolve(ctx);
  if (r instanceof NextResponse) return r;
  return NextResponse.json(state(r.botId, r.direction));
}

/** Attaches (or changes to) the chosen webhook. It stays until a person changes or detaches it. */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const r = await resolve(ctx);
  if (r instanceof NextResponse) return r;
  return guarded(async () => {
    const body = await readJson(req);
    if (typeof body.webhookId !== "string" || !body.webhookId) return badRequest("Pick a webhook.");
    await withBotLock(r.botId, async () => attachWebhook(body.webhookId as string, r.botId, r.direction));
    return NextResponse.json(state(r.botId, r.direction));
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const r = await resolve(ctx);
  if (r instanceof NextResponse) return r;
  return guarded(async () => {
    await withBotLock(r.botId, async () => detachTrigger(r.botId, r.direction));
    return NextResponse.json(state(r.botId, r.direction));
  });
}
