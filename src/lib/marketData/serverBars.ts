import "server-only";
import { TF_MS, type Timeframe } from "../config";
import { aggregateTicksToBars } from "./aggregateTicks";
import { mockBars } from "./mockFeed";
import { getTicks, isLiveSymbol } from "./tickStore";
import type { Bar } from "./types";

/**
 * Server-side "give me the last N *finalized* bars" - used by the
 * automations scheduler, which runs outside React and can't use the
 * useBars hook. Reuses exactly the same bar sources the chart uses
 * (mockBars / tickStore + aggregateTicksToBars), so a rule's indicator
 * values match what the user sees on their own chart.
 *
 * Both bar sources can hand back a bucket for the period that's still in
 * progress (sampled only up to "now", not a real close) - automations must
 * only ever evaluate a bar that has actually closed (spec 3.2), so that
 * trailing still-forming bucket is dropped here.
 */
export function getServerBars(symbol: string, tf: Timeframe, count: number): Bar[] {
  const tfMs = TF_MS[tf];
  const now = Date.now();
  const from = now - tfMs * (count + 5);

  // isLiveSymbol() only says Google Finance *can* serve this symbol - it
  // isn't the mock/live switch. Match the same NEXT_PUBLIC_DATA_SOURCE check
  // the client-side getMarketDataFeed() factory uses, or this would poll
  // Google Finance for symbols like SPX even while the app is in mock mode.
  const useLive = process.env.NEXT_PUBLIC_DATA_SOURCE === "live" && isLiveSymbol(symbol);
  const bars = useLive ? aggregateTicksToBars(getTicks(symbol, from, now), tfMs) : mockBars(symbol, tf, from, now);
  const finalized = bars.filter((b) => b.t + tfMs <= now);

  return finalized.slice(-count);
}
