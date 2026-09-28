import { liveMarketDataFeed } from "./liveFeed";
import { mockMarketDataFeed } from "./mockFeed";
import { LIVE_FEED_SYMBOLS, type MarketDataFeed } from "./types";

/**
 * NEXT_PUBLIC_DATA_SOURCE=mock|live. "live" scrapes Google Finance quote
 * pages through the server-side /api/bars, /api/stream and /api/settle
 * routes (see src/lib/marketData/googleFinance.ts for why it's a scrape,
 * not an API, and the caveats that come with that). Falls back to mock for
 * any symbol the live feed doesn't cover (currently ES1!), so the app never
 * breaks outright even in live mode.
 */
export function getMarketDataFeed(symbol: string): MarketDataFeed {
  const live = process.env.NEXT_PUBLIC_DATA_SOURCE === "live";
  const supported = (LIVE_FEED_SYMBOLS as readonly string[]).includes(symbol);
  return live && supported ? liveMarketDataFeed : mockMarketDataFeed;
}

export type { Bar, MarketDataFeed } from "./types";
export { LIVE_FEED_SYMBOLS } from "./types";
