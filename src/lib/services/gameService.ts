/**
 * GameService is the seam between the UI and data.
 *
 * Today it's backed by the deterministic mock price model. Later, a real
 * implementation can:
 *  - stream ticks from a websocket / SSE endpoint in subscribePrice
 *  - POST guesses to the API in submitGuess
 *  - resolve settleRound from the backend once the webhook with the
 *    official candle close arrives
 * The UI only talks to this interface via useGameService().
 */
import { isCorrect, outcomeOf } from "../game";
import { mockLeaderboard } from "../mock/data";
import { mockPriceAt, mockSeries } from "../mock/priceModel";
import { TICK_MS } from "../config";
import type {
  Direction,
  LeaderboardEntry,
  LeaderboardPeriod,
  PricePoint,
  RoundResult,
  RoundWindow,
} from "../types";

export interface LeaderboardSelf {
  username: string;
  avatarHue: number;
  accuracy: number;
  predictions: number;
  streak: number;
}

export interface GameService {
  getPriceHistory(symbol: string, fromMs: number, toMs: number): Promise<PricePoint[]>;
  subscribePrice(symbol: string, onTick: (p: PricePoint) => void): () => void;
  submitGuess(window: RoundWindow, guess: Direction): Promise<void>;
  settleRound(window: RoundWindow, guess: Direction): Promise<RoundResult>;
  getLeaderboard(period: LeaderboardPeriod, self: LeaderboardSelf): Promise<LeaderboardEntry[]>;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const mockGameService: GameService = {
  async getPriceHistory(symbol, fromMs, toMs) {
    return mockSeries(symbol, fromMs, toMs, TICK_MS * 2);
  },

  subscribePrice(symbol, onTick) {
    const emit = () => {
      const t = Date.now();
      onTick({ t, price: mockPriceAt(symbol, t) });
    };
    emit();
    const id = setInterval(emit, TICK_MS);
    return () => clearInterval(id);
  },

  async submitGuess() {
    await delay(60);
  },

  async settleRound(window, guess) {
    // Simulates waiting for the backend to confirm the official close.
    await delay(500);
    const openPrice = mockPriceAt(window.symbol, window.startMs);
    const closePrice = mockPriceAt(window.symbol, window.endMs);
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

  async getLeaderboard(period, self) {
    await delay(250);
    return mockLeaderboard(period, self);
  },
};
