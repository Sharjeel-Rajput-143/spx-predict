import "server-only";
import { BYBIT_UNDERLYING, bridgeSymbols, priceSource } from "@/lib/automation/executorKind";
import { fetchBybitPrice } from "./bybitFeed";
import { fetchBrokerPrice } from "./brokerFeed";
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

export type FeedSource = "google" | "yahoo" | "broker" | "bybit";

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

/** How long either source gets before the lookup gives up on it. */
const FEED_TIMEOUT_MS = 3000;
/** Google Finance is the nearer-to-real-time source, so it gets this long to answer before Yahoo's answer is taken instead. */
const GOOGLE_HEAD_START_MS = 700;

/**
 * Both sources are asked at once. Google Finance (near-realtime) is preferred: if it answers within a short head start its price is
 * used. If it hasn't, the first good answer wins - Yahoo Finance's chart endpoint (yahooFinance.ts) is typically slightly staler, but
 * a price a second later beats a better price eight seconds later (asking one after the other, with long limits, made a cold server
 * wait out Google's own retries before Yahoo was even tried). Neither is an official/licensed API, so relying on just one would make
 * every automation watching this feed only as reliable as that one undocumented endpoint.
 */
function fetchFeedPrice(symbol: string): Promise<{ price: number; source: FeedSource } | null> {
  const google = fetchGoogleFinancePrice(symbol, FEED_TIMEOUT_MS).catch(() => null);
  const yahoo = fetchYahooFinancePrice(symbol, FEED_TIMEOUT_MS).catch(() => null);
  return new Promise((resolve) => {
    let googleDone = false;
    let yahooDone = false;
    let yahooPrice: number | null = null;
    let headStartOver = false;
    let settled = false;
    const finish = (r: { price: number; source: FeedSource } | null) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const check = () => {
      if (settled) return;
      // Yahoo's price is taken once Google has said it has none, or once Google's head start is over.
      if (yahooPrice != null && (googleDone || headStartOver)) finish({ price: yahooPrice, source: "yahoo" });
      else if (googleDone && yahooDone && yahooPrice == null) finish(null);
    };
    google.then((p) => {
      googleDone = true;
      if (p != null) finish({ price: p, source: "google" });
      else check();
    });
    yahoo.then((p) => {
      yahooDone = true;
      yahooPrice = p;
      check();
    });
    const timer = setTimeout(() => {
      headStartOver = true;
      check();
    }, GOOGLE_HEAD_START_MS);
    timer.unref?.();
  });
}

/** Records a price the feed gave as the symbol's latest tick, and tells whoever is listening. */
function recordTick(state: SymbolState, result: { price: number; source: FeedSource }): Tick {
  state.lastFetchOk = true;
  state.lastSource = result.source;
  state.consecutiveFailures = 0;
  const tick: Tick = { t: Date.now(), price: result.price };
  state.ticks.push(tick);
  if (state.ticks.length > MAX_TICKS) state.ticks.splice(0, state.ticks.length - MAX_TICKS);
  state.listeners.forEach((fn) => fn(tick));
  return tick;
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

    recordTick(state, result);
    state.timer = setTimeout(poll, BASE_POLL_MS);
  };

  poll();
}

/** The live price of a symbol from the source the settings choose (PRICE_SOURCE: the public feed by default, or the broker's own quote). A bad setting gives no price, never a different source. */
export function fetchPrice(symbol: string): Promise<{ price: number; source: FeedSource } | null> {
  // The BTC bot's price is Bybit's own (the demo host's mark price), whatever PRICE_SOURCE says for the index bots.
  if (symbol.toUpperCase() === BYBIT_UNDERLYING) return fetchBybitPrice(FEED_TIMEOUT_MS).then((price) => (price === null ? null : { price, source: "bybit" as const }));
  let source;
  try {
    source = priceSource();
  } catch (err) {
    console.error(`[marketData] ${err instanceof Error ? err.message : String(err)}`);
    return Promise.resolve(null);
  }
  if (source !== "broker") return fetchFeedPrice(symbol);
  // The broker's own quote is only asked for the symbols the bridge takes (NDX). A symbol it doesn't take (SPX) runs on the internal
  // simulation, and its price comes from the public feed - nothing is sent to the bridge for it, and nothing fails for want of a quote.
  try {
    if (!bridgeSymbols().includes(symbol.toUpperCase())) return fetchFeedPrice(symbol);
  } catch (err) {
    console.error(`[marketData] ${err instanceof Error ? err.message : String(err)}`);
    return Promise.resolve(null);
  }
  return fetchBrokerPrice(symbol);
}

export function isLiveSymbol(symbol: string): boolean {
  return symbol === BYBIT_UNDERLYING || symbol in GOOGLE_FINANCE_CODES || symbol in YAHOO_CODES;
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

/** A price older than this, when the feed can't be reached, is not used at all. */
export const STALE_FALLBACK_MS = 60_000;

/**
 * The latest tick, and a recent one. A tick no older than `maxAgeMs` is returned at once (an always-on server's poller keeps one a couple of
 * seconds old). Otherwise - the poller has only just been started, or a serverless instance has been asleep and holds an old tick - the feed
 * is asked directly now, for up to `timeoutMs`, rather than waiting for a poll timer that may have been frozen. If the feed gives nothing in
 * time, the last tick is used only if it is at most STALE_FALLBACK_MS old; otherwise null. Without `maxAgeMs` any tick counts, as before.
 */
export async function waitForTick(symbol: string, timeoutMs: number, maxAgeMs: number = Infinity): Promise<Tick | null> {
  const last = getLastTick(symbol);
  if (last && Date.now() - last.t <= maxAgeMs) return last;
  if (timeoutMs <= 0) return last && Date.now() - last.t <= STALE_FALLBACK_MS ? last : null;
  const state = getState(symbol);
  const fresh = await Promise.race([
    fetchPrice(symbol).then((r) => (r ? recordTick(state, r) : null)),
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (fresh) return fresh;
  const latest = state.ticks[state.ticks.length - 1] ?? null;
  return latest && Date.now() - latest.t <= STALE_FALLBACK_MS ? latest : null;
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
