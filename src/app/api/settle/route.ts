import { NextRequest, NextResponse } from "next/server";
import { getTicks, isLiveSymbol } from "@/lib/marketData/tickStore";

/**
 * GET /api/settle?symbol=SPX&startMs=&endMs=
 * The authoritative open/close for a prediction window, computed server-side
 * from the same tick history the chart is built from - the client never
 * settles against its own locally-observed price.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const symbol = params.get("symbol") ?? "";
  const startMs = Number(params.get("startMs"));
  const endMs = Number(params.get("endMs"));

  if (!isLiveSymbol(symbol) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return NextResponse.json({ openPrice: null, closePrice: null }, { status: 400 });
  }

  // A window of ticks either side of the boundary, so we can pick the
  // closest-at-or-after-open and closest-at-or-before-close.
  const padMs = 30_000;
  const ticks = getTicks(symbol, startMs - padMs, endMs + padMs);
  const openTick = ticks.find((t) => t.t >= startMs) ?? null;
  const closeTicks = ticks.filter((t) => t.t <= endMs);
  const closeTick = closeTicks[closeTicks.length - 1] ?? null;

  return NextResponse.json({
    openPrice: openTick?.price ?? null,
    closePrice: closeTick?.price ?? null,
  });
}
