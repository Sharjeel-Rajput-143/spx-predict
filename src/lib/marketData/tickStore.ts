import "server-only";
import { fetchGoogleFinancePrice, GOOGLE_FINANCE_CODES } from "./googleFinance";
import { fetchYahooFinancePrice, YAHOO_CODES } from "./yahooFinance";

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

export type FeedSource = "google" | "yahoo";

const BASE_POLL_MS = 2000;
const MAX_BACKOFF_MS = 30_000;
const MAX_TICKS = 12_000; // ~6-7 hours at the base 2s poll cadence

interface SymbolState {
  ticks: Tick[];
  listeners: Set<(tick: Tick) => void>;
  timer: ReturnType<typeof setTimeout> | null;
  lastFetchOk: boolean;
  lastSource: FeedSource | null;
  consecutiveFailures: number;
}

const store = new Map<string, SymbolState>();

function getState(symbol: string): SymbolState {
  let s = store.get(symbol);
  if (!s) {
    s = { ticks: [], listeners: new Set(), timer: null, lastFetchOk: false, lastSource: null, consecutiveFailures: 0 };
    store.set(symbol, s);
  }
  return s;
}

/**
 * Google Finance first (near-realtime) - Yahoo Finance's chart endpoint
 * (yahooFinance.ts) is only ever reached for as a fallback, since it's
 * typically slightly staler. Neither is an official/licensed API, so
 * relying on just one would make every automation watching this feed only
 * as reliable as that one undocumented endpoint.
 */
async function fetchPrice(symbol: string): Promise<{ price: number; source: FeedSource } | null> {
  const google = await fetchGoogleFinancePrice(symbol);
  if (google != null) return { price: google, source: "google" };
  const yahoo = await fetchYahooFinancePrice(symbol);
  if (yahoo != null) return { price: yahoo, source: "yahoo" };
  return null;
}

function startPolling(symbol: string) {
  const state = getState(symbol);
  if (state.timer || !isLiveSymbol(symbol)) return;

  const poll = async () => {
    const result = await fetchPrice(symbol);

    if (result == null) {
      state.lastFetchOk = false;
      state.consecutiveFailures++;
      // Circuit breaker: back off geometrically instead of hammering two
      // sources that are both down, capped at MAX_BACKOFF_MS and reset to
      // the base cadence the instant either source recovers.
      const delay = Math.min(BASE_POLL_MS * 2 ** Math.min(state.consecutiveFailures, 4), MAX_BACKOFF_MS);
      state.timer = setTimeout(poll, delay);
      return;
    }

    state.lastFetchOk = true;
    state.lastSource = result.source;
    state.consecutiveFailures = 0;
    const tick: Tick = { t: Date.now(), price: result.price };
    state.ticks.push(tick);
    if (state.ticks.length > MAX_TICKS) state.ticks.splice(0, state.ticks.length - MAX_TICKS);
    state.listeners.forEach((fn) => fn(tick));
    state.timer = setTimeout(poll, BASE_POLL_MS);
  };

  poll();
}

export function isLiveSymbol(symbol: string): boolean {
  return symbol in GOOGLE_FINANCE_CODES || symbol in YAHOO_CODES;
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

/**
 * The latest tick, waiting up to `timeoutMs` for the first one when the poller has only just been started (a cold server
 * has no tick yet; the first poll takes a moment). Resolves to null if the feed gives nothing in time.
 */
export function waitForTick(symbol: string, timeoutMs: number): Promise<Tick | null> {
  const last = getLastTick(symbol);
  if (last || timeoutMs <= 0) return Promise.resolve(last);
  return new Promise((resolve) => {
    const done = (tick: Tick | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(tick);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const unsubscribe = subscribeTicks(symbol, (tick) => done(tick));
  });
}

export interface FeedStatus {
  healthy: boolean;
  /** Which upstream actually served the last successful tick. Seeing this
   * flip to "yahoo" for a stretch is a signal Google Finance is degraded,
   * even though the app itself keeps working. */
  source: FeedSource | null;
  consecutiveFailures: number;
  lastTickAt: number | null;
}

export function getFeedStatus(symbol: string): FeedStatus {
  startPolling(symbol);
  const state = getState(symbol);
  return {
    healthy: state.lastFetchOk,
    source: state.lastSource,
    consecutiveFailures: state.consecutiveFailures,
    lastTickAt: state.ticks[state.ticks.length - 1]?.t ?? null,
  };
}

export function subscribeTicks(symbol: string, onTick: (tick: Tick) => void): () => void {
  startPolling(symbol);
  const state = getState(symbol);
  state.listeners.add(onTick);
  return () => state.listeners.delete(onTick);
}
