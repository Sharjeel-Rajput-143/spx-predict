/**
 * Live GameService: guesses/leaderboard stay mock-backed (there's no real
 * accounts backend here), but price history, live ticks and - critically -
 * settlement all go through the server's Google-Finance-derived tick store,
 * so what the user watches on the chart is exactly what they settle against.
 * Falls back to the mock implementation per-symbol for anything the live
 * feed doesn't cover (currently ES1!).
 */
import { LIVE_FEED_SYMBOLS } from "../marketData/types";
import { isCorrect, outcomeOf } from "../game";
import { mockGameService, type GameService } from "./gameService";
import type { Direction, PricePoint, RoundResult, RoundWindow } from "../types";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isLive(symbol: string): boolean {
  return (LIVE_FEED_SYMBOLS as readonly string[]).includes(symbol);
}

async function fetchSettle(symbol: string, startMs: number, endMs: number) {
  const params = new URLSearchParams({ symbol, startMs: String(startMs), endMs: String(endMs) });
  const res = await fetch(`/api/settle?${params}`);
  if (!res.ok) return { openPrice: null as number | null, closePrice: null as number | null };
  return (await res.json()) as { openPrice: number | null; closePrice: number | null };
}

export const liveGameService: GameService = {
  async getPriceHistory(symbol, fromMs, toMs) {
    if (!isLive(symbol)) return mockGameService.getPriceHistory(symbol, fromMs, toMs);
    const params = new URLSearchParams({ symbol, from: String(fromMs), to: String(toMs) });
    const res = await fetch(`/api/ticks?${params}`);
    if (!res.ok) return [];
    const { ticks } = (await res.json()) as { ticks: PricePoint[] };
    return ticks;
  },

  subscribePrice(symbol, onTick) {
    if (!isLive(symbol)) return mockGameService.subscribePrice(symbol, onTick);
    const es = new EventSource(`/api/stream?symbol=${encodeURIComponent(symbol)}`);
    es.onmessage = (ev) => onTick(JSON.parse(ev.data) as PricePoint);
    return () => es.close();
  },

  async submitGuess(window, guess) {
    if (!isLive(window.symbol)) return mockGameService.submitGuess(window, guess);
    await delay(60);
  },

  async settleRound(window, guess): Promise<RoundResult> {
    if (!isLive(window.symbol)) return mockGameService.settleRound(window, guess);

    // The tick poller runs on a ~3s cadence; give it a few tries to catch up
    // to the window boundary rather than failing settlement outright.
    let openPrice: number | null = null;
    let closePrice: number | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await fetchSettle(window.symbol, window.startMs, window.endMs);
      openPrice = result.openPrice;
      closePrice = result.closePrice;
      if (openPrice != null && closePrice != null) break;
      await delay(1000);
    }

    if (openPrice == null || closePrice == null) {
      // Feed gap at settlement time - resolve as a push (flat) rather than
      // silently guessing, since we have no authoritative price to judge by.
      return {
        id: window.id,
        symbol: window.symbol,
        startMs: window.startMs,
        endMs: window.endMs,
        guess,
        openPrice: openPrice ?? closePrice ?? 0,
        closePrice: closePrice ?? openPrice ?? 0,
        outcome: "flat",
        correct: false,
      };
    }

    const outcome = outcomeOf(openPrice, closePrice);
    return {
      id: window.id,
      symbol: window.symbol,
      startMs: window.startMs,
      endMs: window.endMs,
      guess,
      openPrice,
      closePrice,
      outcome,
      correct: isCorrect(guess, outcome),
    };
  },

  getLeaderboard: mockGameService.getLeaderboard,
};
