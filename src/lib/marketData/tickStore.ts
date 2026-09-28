import "server-only";
import { fetchGoogleFinancePrice, GOOGLE_FINANCE_CODES } from "./googleFinance";

/**
 * Single in-process tick store shared by the /api/bars, /api/stream and
 * /api/settle route handlers. One poller per symbol, started lazily on
 * first request and kept alive for the life of the server process.
 *
 * This is intentionally a single-process singleton - fine for a single
 * server instance (dev, or a small always-on deployment), but it will NOT
 * stay in sync across multiple serverless instances / replicas. A real
 * deployment would replace this with a shared store (Redis, a DB, or a
 * dedicated ingest service) behind the same getTicks/subscribe interface.
 */

export interface Tick {
  t: number; // epoch ms
  price: number;
}

const POLL_MS = 2000;
const MAX_TICKS = 12_000; // ~10 hours at one tick / 3s

interface SymbolState {
  ticks: Tick[];
  listeners: Set<(tick: Tick) => void>;
  timer: ReturnType<typeof setInterval> | null;
  lastFetchOk: boolean;
}

const store = new Map<string, SymbolState>();

function getState(symbol: string): SymbolState {
  let s = store.get(symbol);
  if (!s) {
    s = { ticks: [], listeners: new Set(), timer: null, lastFetchOk: false };
    store.set(symbol, s);
  }
  return s;
}

function startPolling(symbol: string) {
  const state = getState(symbol);
  if (state.timer || !GOOGLE_FINANCE_CODES[symbol]) return;

  const poll = async () => {
    const price = await fetchGoogleFinancePrice(symbol);
    if (price == null) {
      state.lastFetchOk = false;
      return;
    }
    state.lastFetchOk = true;
    const tick: Tick = { t: Date.now(), price };
    state.ticks.push(tick);
    if (state.ticks.length > MAX_TICKS) state.ticks.splice(0, state.ticks.length - MAX_TICKS);
    state.listeners.forEach((fn) => fn(tick));
  };

  poll();
  state.timer = setInterval(poll, POLL_MS);
}

export function isLiveSymbol(symbol: string): boolean {
  return symbol in GOOGLE_FINANCE_CODES;
}

export function getTicks(symbol: string, fromMs: number, toMs: number): Tick[] {
  startPolling(symbol);
  const state = getState(symbol);
  return state.ticks.filter((t) => t.t >= fromMs && t.t <= toMs);
}

export function getLastTick(symbol: string): Tick | null {
  startPolling(symbol);
  const state = getState(symbol);
  return state.ticks[state.ticks.length - 1] ?? null;
}

export function isFeedHealthy(symbol: string): boolean {
  return getState(symbol).lastFetchOk;
}

export function subscribeTicks(symbol: string, onTick: (tick: Tick) => void): () => void {
  startPolling(symbol);
  const state = getState(symbol);
  state.listeners.add(onTick);
  return () => state.listeners.delete(onTick);
}
