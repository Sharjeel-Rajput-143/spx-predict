import "server-only";
import { getLastTick, waitForTick } from "@/lib/marketData/tickStore";

/** A quote at most this old is used as it is; an older one is replaced by asking the feed again. */
export const QUOTE_FRESH_MS = 15_000;
/** A live quote older than this isn't a price to trade on, even when the feed could not be reached to replace it. */
const MAX_QUOTE_AGE_MS = 60_000;
/** A server that has only just started has no quote yet. A TradingView call must be answered within about 3 seconds, so the call waits
 * this long for the first quote, then answers and finishes in the background (SLOW wait). The Test Hook button, with no such limit, uses SLOW at once. */
export const QUICK_QUOTE_WAIT_MS = 1_500;
export const SLOW_QUOTE_WAIT_MS = 8_000;

/**
 * The price a webhook call runs at: the live quote of the bot's underlying, from this app's own price feed, if it is fresh. Never a
 * price sent by the caller. As in Option Alpha, a webhook is only a trigger: the alert's message is not read, and the bot uses its
 * own market data. Null when there is no fresh quote.
 */
export async function resolveHookPrice(underlying: string | null, now: number = Date.now(), waitMs: number = QUICK_QUOTE_WAIT_MS): Promise<number | null> {
  if (!underlying) return null;
  const tick = await waitForTick(underlying, waitMs, QUOTE_FRESH_MS);
  return tick && Date.now() - tick.t <= MAX_QUOTE_AGE_MS ? tick.price : null;
}

/**
 * The quote the feed already holds, if it is fresh (no older than QUOTE_FRESH_MS), with NO waiting and no network: what a webhook call can use while it is being answered.
 * Null when the feed holds none or an older one; the call is then answered all the same and looks for a price behind its answer (resolveHookPrice).
 */
export function freshQuoteNow(underlying: string | null, now: number = Date.now()): number | null {
  if (!underlying) return null;
  const tick = getLastTick(underlying);
  return tick && now - tick.t <= QUOTE_FRESH_MS ? tick.price : null;
}

/**
 * Starts the quote feed of each of these underlyings (the lookup starts its poller, which then keeps a quote a couple of seconds old), so the first call after the server
 * starts finds one instead of having to fetch it. Seen on the real app: the first alert after a restart took 1.7 seconds, nearly all of it fetching a quote.
 */
export function warmQuoteFeeds(underlyings: Iterable<string | null | undefined>): string[] {
  const started: string[] = [];
  for (const u of new Set([...underlyings].filter((x): x is string => !!x))) {
    try {
      getLastTick(u);
      started.push(u);
    } catch {
      /* a feed that cannot start is found out when a call needs it */
    }
  }
  return started;
}
