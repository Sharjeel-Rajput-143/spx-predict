import type { Timeframe } from "../config";

/** One OHLCV bar. `t` is the bar's open time in epoch ms, aligned to its timeframe. */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Present only for symbols with volume (see Ticker.hasVolume). */
  v?: number;
}

/**
 * Seam between the chart and whatever produces OHLC bars. `getBars` backfills
 * history; `subscribeBars` streams the in-progress bar (isFinal: false) and
 * then the closed bar exactly once (isFinal: true) at each boundary.
 *
 * This is deliberately separate from GameService: GameService owns guesses,
 * settlement and the leaderboard, while MarketDataFeed only owns chart data.
 * A real implementation (Phase 3) fetches from GET /api/bars and streams
 * GET /api/stream instead of the mock generator.
 */
export interface MarketDataFeed {
  getBars(symbol: string, tf: Timeframe, fromMs: number, toMs: number): Promise<Bar[]>;
  subscribeBars(symbol: string, tf: Timeframe, onBar: (bar: Bar, isFinal: boolean) => void): () => void;
}

/** Symbols the Google Finance live adapter can scrape. ES1! isn't listed
 * there (continuous futures aren't a Google Finance quote page), so it
 * always falls back to the mock feed regardless of NEXT_PUBLIC_DATA_SOURCE. */
export const LIVE_FEED_SYMBOLS = ["SPX", "NDX", "SPY", "QQQ"] as const;
