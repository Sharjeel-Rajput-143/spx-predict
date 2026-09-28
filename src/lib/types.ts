// Shared domain types. These mirror the shapes a real backend would return,
// so swapping the mock service for an API client needs no UI changes.

export type Direction = "up" | "down";
export type Outcome = Direction | "flat";

export interface PricePoint {
  t: number; // epoch ms
  price: number;
}

export interface Ticker {
  symbol: string;
  name: string;
  basePrice: number;
  /** SPX/NDX are indices and never have volume. SPY/QQQ/ES1! do. */
  hasVolume: boolean;
  exchange: string;
  /** "regular" = standard 9:30-16:00 ET session. "almost24" = near round-the-clock futures. */
  session: "regular" | "almost24";
}

/** A single prediction window (e.g. one 5 minute candle). */
export interface RoundWindow {
  id: string; // `${symbol}-${startMs}`
  symbol: string;
  startMs: number;
  endMs: number;
}

/** A settled round the user took part in. */
export interface RoundResult {
  id: string;
  symbol: string;
  startMs: number;
  endMs: number;
  guess: Direction;
  openPrice: number;
  closePrice: number;
  outcome: Outcome;
  correct: boolean;
}

export interface UserStats {
  totalPredictions: number;
  wins: number;
  winRate: number; // 0..1
  currentStreak: number;
  longestStreak: number;
  todayPredictions: number;
  todayWins: number;
  todayAccuracy: number; // 0..1
}

export interface UserProfile {
  id: string;
  username: string;
  avatarHue: number; // used for generated avatar colour
  joinedAt: number;
}

export type LeaderboardPeriod = "day" | "week" | "all";

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatarHue: number;
  accuracy: number; // 0..1
  predictions: number;
  streak: number;
  isYou?: boolean;
}
