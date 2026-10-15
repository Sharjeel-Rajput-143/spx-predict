import { NextRequest, NextResponse } from "next/server";
import { withBotLock } from "@/lib/automation/botLock";
import { assessPosition, resolvePosition, type ResolveAction } from "@/lib/automation/positionResolve";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { positionsStore } from "@/lib/automation/store";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * Resolve a position stuck in "closing" or "opening" (see positionResolve.ts).
 *   GET   asks the broker (read-only) and says what can safely be done.
 *   POST  { action, confirm: true, price? } does one of the offered actions, if the broker's answer, asked again now, still allows it.
 * Signed-in only. It never lets anyone type a status.
 */
const ACTIONS: readonly ResolveAction[] = ["cancel_orders", "return_to_open", "mark_closed", "mark_open", "mark_rejected"];

async function handleGET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  if (!positionsStore.get(id)) return badRequest("Position not found.", 404);
  return guarded(async () => NextResponse.json({ assessment: await assessPosition(id, sharedExecutor) }));
}

async function handlePOST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  const position = positionsStore.get(id);
  if (!position) return badRequest("Position not found.", 404);
  return guarded(async () => {
    const body = await readJson(req);
    if (typeof body.action !== "string" || !(ACTIONS as readonly string[]).includes(body.action)) return badRequest("Pick one of the offered actions.");
    if (body.price !== undefined && (typeof body.price !== "number" || !Number.isFinite(body.price))) return badRequest("The price has to be a number.");
    const result = await withBotLock(position.botId, async () => {
      const done = await resolvePosition(id, { action: body.action as ResolveAction, confirm: body.confirm === true, price: body.price as number | undefined }, sharedExecutor);
      return { ...done, assessment: await assessPosition(id, sharedExecutor) };
    });
    return NextResponse.json({ result });
  });
}

export const GET = withStorage(handleGET);
export const POST = withStorage(handlePOST);
