import type { NextRequest } from "next/server";
import { isLiveSymbol, subscribeTicks } from "@/lib/marketData/tickStore";

/** GET /api/stream?symbol=SPX - Server-Sent Events stream of live ticks. */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";
  if (!isLiveSymbol(symbol)) {
    return new Response("Unsupported symbol for the live feed", { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      unsubscribe = subscribeTicks(symbol, (tick) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(tick)}\n\n`));
      });
      // Keep intermediary proxies from timing out an idle connection.
      const keepAlive = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 15000);
      req.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        unsubscribe?.();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
