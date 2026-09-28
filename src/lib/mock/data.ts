import { ROUND_MS, TICKERS } from "../config";
import { isCorrect, outcomeOf } from "../game";
import type { Direction, LeaderboardEntry, LeaderboardPeriod, RoundResult, UserProfile } from "../types";
import { mockPriceAt } from "./priceModel";

export const MOCK_USER: UserProfile = {
  id: "me",
  username: "you",
  avatarHue: 158,
  joinedAt: Date.UTC(2026, 6, 14),
};

// Tiny seeded PRNG so mock data is stable between reloads.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds a plausible past for the user so History and stats aren't empty. */
export function seedUserHistory(now: number, count = 36): RoundResult[] {
  const rand = mulberry32(42);
  const results: RoundResult[] = [];
  let cursor = Math.floor(now / ROUND_MS) * ROUND_MS - ROUND_MS * 2;

  for (let i = 0; i < count; i++) {
    const symbol = rand() < 0.7 ? "SPX" : TICKERS[1 + Math.floor(rand() * (TICKERS.length - 1))].symbol;
    const startMs = cursor - ROUND_MS;
    const endMs = cursor;
    const openPrice = mockPriceAt(symbol, startMs);
    const closePrice = mockPriceAt(symbol, endMs);
    const outcome = outcomeOf(openPrice, closePrice);
    // Skew toward correct so the demo user looks like a decent trader (~58%).
    const skill = rand() < 0.58;
    const actual: Direction = outcome === "down" ? "down" : "up";
    const guess: Direction = skill ? actual : actual === "up" ? "down" : "up";
    results.push({
      id: `${symbol}-${startMs}`,
      symbol,
      startMs,
      endMs,
      guess,
      openPrice,
      closePrice,
      outcome,
      correct: isCorrect(guess, outcome),
    });
    // Gaps between sessions: mostly consecutive, sometimes hours apart.
    const gap = rand() < 0.8 ? 1 + Math.floor(rand() * 3) : 60 + Math.floor(rand() * 600);
    cursor -= ROUND_MS * gap;
  }
  return results; // newest first
}

const NAMES = [
  "theta_ghost", "gammasqueeze", "odte_oracle", "vwap_viking", "candle_whisperer",
  "bidask_betty", "deltahedge", "spx_sniper", "tape_reader", "ivcrush",
  "limitup_lou", "mean_revert", "fib_fanatic", "orderflow_ollie", "chop_survivor",
  "scalp_sensei", "pinbar_pete", "the_open", "closing_bell", "range_rider",
];

export function mockLeaderboard(
  period: LeaderboardPeriod,
  you: { accuracy: number; predictions: number; streak: number; username: string; avatarHue: number },
): LeaderboardEntry[] {
  const seed = period === "day" ? 11 : period === "week" ? 23 : 97;
  const rand = mulberry32(seed);
  const volume = period === "day" ? [8, 60] : period === "week" ? [40, 320] : [200, 2400];

  const others = NAMES.map((username, i) => {
    const predictions = Math.round(volume[0] + rand() * (volume[1] - volume[0]));
    const spread = period === "day" ? 0.3 : period === "week" ? 0.18 : 0.1;
    const accuracy = Math.min(0.92, Math.max(0.38, 0.54 + (rand() - 0.35) * spread));
    const streak = Math.round(rand() * (period === "day" ? 9 : 16));
    return { userId: `u${i}`, username, avatarHue: Math.floor(rand() * 360), accuracy, predictions, streak };
  });

  const all = [
    ...others,
    { userId: "me", isYou: true, ...you },
  ];

  // Rank by accuracy, streak breaks ties. Users need a minimum sample size to rank highly,
  // which a real backend should enforce too.
  const minSample = period === "day" ? 5 : period === "week" ? 20 : 50;
  all.sort((a, b) => {
    const qa = a.predictions >= minSample ? 1 : 0;
    const qb = b.predictions >= minSample ? 1 : 0;
    if (qa !== qb) return qb - qa;
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    return b.streak - a.streak;
  });

  return all.map((e, i) => ({ ...e, rank: i + 1 }));
}
