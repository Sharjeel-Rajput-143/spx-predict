// THE LIVE LIMITS. Plain constants and checks, no imports, so every other file (the executor, the settings, the page) reads the same numbers. These are CEILINGS written in code:
// no setting, page or environment variable can raise them. Lowering them is a code change, made and released on purpose.

/** The only real-money host the live executor may talk to. */
export const LIVE_HOST = "api.bybit.com";
export const LIVE_API_BASE = `https://${LIVE_HOST}`;
/** The demo host: the only host the demo executor may talk to. */
export const DEMO_HOST = "api-demo.bybit.com";

export const LIVE_LIMITS = {
  /** The largest order, in BTC. Bybit's own minimum for BTCUSDT is also 0.001, so this is the smallest real position there is. */
  maxQty: 0.001,
  /** The largest daily loss the live bot may be given, in USD. The setting below it can be lower, never higher. */
  dailyLossCeilingUsd: 3,
  /** What the daily loss limit is until you set it. */
  defaultDailyLossUsd: 2,
  /** New live positions per New York day. */
  maxTradesPerDay: 5,
  /** Live positions open at once. */
  maxOpenPositions: 1,
} as const;

/** Stage 1: one account holding only $10 (0.001 BTC needs at least 8x to open at all). Stage 2: up to $35, only after the live gate has passed. */
export type LiveStage = 1 | 2;
export const STAGE_LEVERAGE: Record<LiveStage, number> = { 1: 10, 2: 3 };
/** Bybit's name for isolated margin on a unified account. */
export const ISOLATED_MARGIN = "ISOLATED_MARGIN";

export const LIVE_BOT_ID = "btc_bybit_live";
export const LIVE_ENV = { key: "BYBIT_LIVE_API_KEY", secret: "BYBIT_LIVE_API_SECRET" } as const;
export const DEMO_ENV = { key: "BYBIT_DEMO_API_KEY", secret: "BYBIT_DEMO_API_SECRET" } as const;

/** The daily loss limit actually applied: what was asked for, never above the ceiling, never below a cent, and the default when it is not a usable number. */
export function clampDailyLoss(requested: unknown): number {
  const n = typeof requested === "number" ? requested : Number(requested);
  if (!Number.isFinite(n) || n <= 0) return LIVE_LIMITS.defaultDailyLossUsd;
  return Math.min(Math.max(n, 0.01), LIVE_LIMITS.dailyLossCeilingUsd);
}

export function isLiveStage(v: unknown): v is LiveStage {
  return v === 1 || v === 2;
}

/** The order references of the live executor. Different from the demo ones ("bybit-open-", "bybit-close-") so the two can never be mistaken for each other. */
export const LIVE_ORDER_PREFIX = { open: "bybitlive-open-", close: "bybitlive-close-" } as const;
export const isLiveRef = (ref: string | null | undefined): boolean => typeof ref === "string" && ref.startsWith("bybitlive-");
