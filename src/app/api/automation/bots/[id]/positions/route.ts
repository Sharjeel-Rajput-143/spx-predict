import { NextRequest, NextResponse } from "next/server";
import { getBotStaticConfig, isKnownBot } from "@/lib/automation/bots";
import { withBotLock } from "@/lib/automation/botLock";
import { manualOpen } from "@/lib/automation/engine";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { getLastTick } from "@/lib/marketData/tickStore";
import type { PositionType } from "@/lib/automation/types";
import { withStorage } from "@/lib/automation/withStorage";

/** The bot's own underlying (the live quote it records is that symbol's, not always SPX's). */
function botUnderlying(id: string): string {
  try {
    return getBotStaticConfig(id).underlying;
  } catch {
    return "SPX";
  }
}

/** "+ New Position": opens a spread at an explicit short strike, through the
 * same guards as a signal. The long strike comes from the bot's width. */
async function handlePOST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  if (!isKnownBot(id)) return badRequest("Unknown bot.", 404);

  return guarded(async () => {
    const body = await readJson(req);
    const type = body.type as PositionType;
    if (type !== "short_put_spread" && type !== "short_call_spread") return badRequest("type must be short_put_spread or short_call_spread.");
    if (typeof body.shortStrike !== "number" || !Number.isFinite(body.shortStrike)) return badRequest("shortStrike must be a number.");

    const result = await withBotLock(id, () =>
      manualOpen(id, { type, shortStrike: body.shortStrike as number, underlyingPrice: getLastTick(botUnderlying(id))?.price ?? null }, { executor: sharedExecutor }),
    );
    return NextResponse.json({ result }, { status: result.ok ? 201 : 409 });
  });
}

export const POST = withStorage(handlePOST);
