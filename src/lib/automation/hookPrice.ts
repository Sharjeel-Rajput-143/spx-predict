import "server-only";
import { waitForTick } from "@/lib/marketData/tickStore";

/** A live quote older than this isn't a price to trade on. */
const MAX_QUOTE_AGE_MS = 5 * 60_000;
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
  const tick = await waitForTick(underlying, waitMs);
  return tick && now - tick.t <= MAX_QUOTE_AGE_MS ? tick.price : null;
}
