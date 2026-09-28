import { NextRequest, NextResponse } from "next/server";
import { getFeedStatus, getLastTick, isLiveSymbol } from "@/lib/marketData/tickStore";

/** GET /api/quote?symbol=SPX - the latest known tick, plus feed health
 * (which upstream served it, and how many consecutive failures preceded it -
 * see tickStore's Google-then-Yahoo fallback and backoff). */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";
  if (!isLiveSymbol(symbol)) {
    return NextResponse.json({ tick: null, healthy: false, source: null, consecutiveFailures: 0 });
  }
  const status = getFeedStatus(symbol);
  return NextResponse.json({ tick: getLastTick(symbol), ...status });
}
