import "server-only";
import { waitForTick } from "@/lib/marketData/tickStore";

/** A live quote older than this isn't a price to trade on. */
const MAX_QUOTE_AGE_MS = 5 * 60_000;
/** A server that has only just started has no quote yet; give its first one a few seconds. */
const FIRST_QUOTE_WAIT_MS = 6_000;

/**
 * The price a webhook call runs at: the one in the alert message if it carries one, else the live quote of the bot's
 * underlying if it is fresh. A call needs no message at all (as with Option Alpha, the call itself is the trigger);
 * the price is only there to place the strikes. Null when there is neither.
 */
export async function resolveHookPrice(given: number | null, underlying: string | null, now: number = Date.now()): Promise<number | null> {
  if (given !== null) return given;
  if (!underlying) return null;
  const tick = await waitForTick(underlying, FIRST_QUOTE_WAIT_MS);
  return tick && now - tick.t <= MAX_QUOTE_AGE_MS ? tick.price : null;
}
