import { ROUND_MS } from "./config";
import type { Direction, Outcome, RoundResult, RoundWindow, UserStats } from "./types";

export function windowFor(symbol: string, now: number, roundMs = ROUND_MS): RoundWindow {
  const startMs = Math.floor(now / roundMs) * roundMs;
  return { id: `${symbol}-${startMs}`, symbol, startMs, endMs: startMs + roundMs };
}

export function outcomeOf(open: number, close: number): Outcome {
  const diff = close - open;
  if (Math.abs(diff) < 1e-9) return "flat";
  return diff > 0 ? "up" : "down";
}

/** A flat candle counts as a loss for both sides. */
export function isCorrect(guess: Direction, outcome: Outcome) {
  return guess === outcome;
}

function isSameDay(a: number, b: number) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** Results must be sorted newest first. */
export function computeStats(results: RoundResult[], now = Date.now()): UserStats {
  const total = results.length;
  const wins = results.filter((r) => r.correct).length;

  let currentStreak = 0;
  for (const r of results) {
    if (!r.correct) break;
    currentStreak++;
  }

  let longestStreak = 0;
  let run = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    run = results[i].correct ? run + 1 : 0;
    longestStreak = Math.max(longestStreak, run);
  }

  const today = results.filter((r) => isSameDay(r.endMs, now));
  const todayWins = today.filter((r) => r.correct).length;

  return {
    totalPredictions: total,
    wins,
    winRate: total ? wins / total : 0,
    currentStreak,
    longestStreak,
    todayPredictions: today.length,
    todayWins,
    todayAccuracy: today.length ? todayWins / today.length : 0,
  };
}
