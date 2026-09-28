import { NextRequest, NextResponse } from "next/server";
import { getLastTick, isFeedHealthy, isLiveSymbol } from "@/lib/marketData/tickStore";

/** GET /api/quote?symbol=SPX - the latest known tick, plus feed health. */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";
  if (!isLiveSymbol(symbol)) {
    return NextResponse.json({ tick: null, healthy: false });
  }
  return NextResponse.json({ tick: getLastTick(symbol), healthy: isFeedHealthy(symbol) });
}
