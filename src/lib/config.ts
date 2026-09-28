/** Working title, change in one place. */
export const APP_NAME = "SPX Predict";

import type { Ticker } from "./types";

/**
 * Length of one prediction window. The product spec is 5 minute candles.
 * Override with NEXT_PUBLIC_ROUND_SECONDS for a faster demo loop (e.g. 60).
 * This is intentionally decoupled from the chart's view timeframe (see
 * Timeframe below) - switching how the chart is viewed never changes what
 * candle you're actually predicting.
 */
export const ROUND_SECONDS = Number(process.env.NEXT_PUBLIC_ROUND_SECONDS ?? 300);
export const ROUND_MS = ROUND_SECONDS * 1000;

/** Lock guesses this many seconds before the window closes. */
export const LOCK_SECONDS = Number(process.env.NEXT_PUBLIC_LOCK_SECONDS ?? 5);
export const LOCK_MS = LOCK_SECONDS * 1000;

/** How often the mock feed emits a tick. */
export const TICK_MS = 1000;

/** How much price history the chart shows. */
export const CHART_WINDOW_MS = Math.max(ROUND_MS * 3, 3 * 60_000);

export const TICKERS: Ticker[] = [
  { symbol: "SPX", name: "S&P 500 Index", basePrice: 6712.4, hasVolume: false, exchange: "CBOE", session: "regular" },
  { symbol: "NDX", name: "Nasdaq 100", basePrice: 24380.15, hasVolume: false, exchange: "NASDAQ", session: "regular" },
  { symbol: "SPY", name: "SPDR S&P 500 ETF", basePrice: 670.21, hasVolume: true, exchange: "ARCA", session: "regular" },
  { symbol: "QQQ", name: "Invesco QQQ", basePrice: 593.82, hasVolume: true, exchange: "NASDAQ", session: "regular" },
  { symbol: "ES1!", name: "E-mini S&P 500 Futures", basePrice: 6725.75, hasVolume: true, exchange: "CME", session: "almost24" },
];

export const DEFAULT_SYMBOL = "SPX";

export function getTicker(symbol: string): Ticker {
  return TICKERS.find((t) => t.symbol === symbol) ?? TICKERS[0];
}

/** Chart view timeframes. Independent of ROUND_MS: viewing 1m or 1D never
 * changes the fixed prediction window length. */
export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1D" | "1W";

export const TIMEFRAMES: { value: Timeframe; label: string; ms: number }[] = [
  { value: "1m", label: "1m", ms: 60_000 },
  { value: "3m", label: "3m", ms: 3 * 60_000 },
  { value: "5m", label: "5m", ms: 5 * 60_000 },
  { value: "15m", label: "15m", ms: 15 * 60_000 },
  { value: "30m", label: "30m", ms: 30 * 60_000 },
  { value: "1h", label: "1h", ms: 60 * 60_000 },
  { value: "4h", label: "4h", ms: 4 * 60 * 60_000 },
  { value: "1D", label: "1D", ms: 24 * 60 * 60_000 },
  { value: "1W", label: "1W", ms: 7 * 24 * 60 * 60_000 },
];

export const TF_MS: Record<Timeframe, number> = Object.fromEntries(
  TIMEFRAMES.map((t) => [t.value, t.ms]),
) as Record<Timeframe, number>;

export const DEFAULT_TIMEFRAME: Timeframe = "5m";

export type ChartType = "candles" | "hollow" | "bars" | "line" | "area";

export const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: "candles", label: "Candles" },
  { value: "hollow", label: "Hollow candles" },
  { value: "bars", label: "Bars" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
];

export const DEFAULT_CHART_TYPE: ChartType = "candles";
