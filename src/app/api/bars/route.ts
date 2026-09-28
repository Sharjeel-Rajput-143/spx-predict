import { NextRequest, NextResponse } from "next/server";
import { aggregateTicksToBars } from "@/lib/marketData/aggregateTicks";
import { getTicks, isLiveSymbol } from "@/lib/marketData/tickStore";
import { TF_MS, type Timeframe } from "@/lib/config";

/** GET /api/bars?symbol=SPX&tf=5m&from=<ms>&to=<ms> - historical OHLC bars, aggregated server-side from real ticks. */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const symbol = params.get("symbol") ?? "";
  const tf = (params.get("tf") ?? "5m") as Timeframe;
  const now = Date.now();
  const from = Number(params.get("from") ?? now - 60 * 60_000);
  const to = Number(params.get("to") ?? now);

  const tfMs = TF_MS[tf];
  if (!tfMs || !isLiveSymbol(symbol)) {
    return NextResponse.json({ bars: [] });
  }

  const ticks = getTicks(symbol, from, to);
  const bars = aggregateTicksToBars(ticks, tfMs);
  return NextResponse.json({ bars });
}
