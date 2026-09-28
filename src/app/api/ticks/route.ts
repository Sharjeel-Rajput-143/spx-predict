import { NextRequest, NextResponse } from "next/server";
import { getTicks, isLiveSymbol } from "@/lib/marketData/tickStore";

/** GET /api/ticks?symbol=SPX&from=&to= - raw ticks (not bucketed into bars). */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const symbol = params.get("symbol") ?? "";
  const now = Date.now();
  const from = Number(params.get("from") ?? now - 60 * 60_000);
  const to = Number(params.get("to") ?? now);

  if (!isLiveSymbol(symbol)) return NextResponse.json({ ticks: [] });
  return NextResponse.json({ ticks: getTicks(symbol, from, to) });
}
