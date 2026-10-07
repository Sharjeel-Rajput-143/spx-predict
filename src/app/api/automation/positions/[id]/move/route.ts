import { NextRequest, NextResponse } from "next/server";
import { withBotLock } from "@/lib/automation/botLock";
import { movePosition } from "@/lib/automation/positionsAdmin";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { positionsStore } from "@/lib/automation/store";
import { withStorage } from "@/lib/automation/withStorage";

/** "Move": reassign an open position to another bot on the same account. */
async function handlePOST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  const position = positionsStore.get(id);
  if (!position) return badRequest("Position not found.", 404);

  return guarded(async () => {
    const body = await readJson(req);
    const target = String(body.botId ?? "");
    if (!target) return badRequest("botId is required.");
    // Checked before locking: taking the same bot's lock twice would wait on itself forever.
    if (target === position.botId) return badRequest("It's already on that bot.");
    // Both bots' locks, always in the same order, so neither can act on the position mid-move.
    const [first, second] = [position.botId, target].sort();
    const moved = await withBotLock(first, () => withBotLock(second, async () => movePosition(id, target)));
    return NextResponse.json({ position: moved });
  });
}

export const POST = withStorage(handlePOST);
