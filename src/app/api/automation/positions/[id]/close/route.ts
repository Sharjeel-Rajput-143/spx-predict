import { NextRequest, NextResponse } from "next/server";
import { withBotLock } from "@/lib/automation/botLock";
import { manualClose } from "@/lib/automation/engine";
import { badRequest, guarded, unauthorized } from "@/lib/automation/routeAuth";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { positionsStore } from "@/lib/automation/store";
import { getLastTick } from "@/lib/marketData/tickStore";
import { withStorage } from "@/lib/automation/withStorage";

/** "Close Position": sends a close order for one open position now. */
async function handlePOST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  const position = positionsStore.get(id);
  if (!position) return badRequest("Position not found.", 404);

  return guarded(async () => {
    const result = await withBotLock(position.botId, () =>
      manualClose(id, { executor: sharedExecutor, underlyingPrice: getLastTick(position.underlying)?.price ?? null }),
    );
    return NextResponse.json({ result }, { status: result.ok ? 200 : 409 });
  });
}

export const POST = withStorage(handlePOST);
