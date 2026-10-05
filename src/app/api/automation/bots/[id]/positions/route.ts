import { NextRequest, NextResponse } from "next/server";
import { isKnownBot } from "@/lib/automation/bots";
import { withBotLock } from "@/lib/automation/botLock";
import { manualOpen } from "@/lib/automation/engine";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { getLastTick } from "@/lib/marketData/tickStore";
import type { PositionType } from "@/lib/automation/types";

/** "+ New Position": opens a spread at an explicit short strike, through the
 * same guards as a signal. The long strike comes from the bot's width. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
      manualOpen(id, { type, shortStrike: body.shortStrike as number, underlyingPrice: getLastTick("SPX")?.price ?? null }, { executor: sharedExecutor }),
    );
    return NextResponse.json({ result }, { status: result.ok ? 201 : 409 });
  });
}
