import "server-only";

/**
 * The price from the broker's own quote (PRICE_SOURCE=broker), for the same places that use the public feed: the same shape, so
 * everything that reads a tick works unchanged. No fallback to the public feed on purpose: a price the broker could not give
 * (bridge down, Gateway signed out, a quote older than BRIDGE_MAX_QUOTE_AGE_MS) is "no price", and the bot does not trade on it.
 * The broker is imported when first used, so a build that never asks for it doesn't load it.
 */
export async function fetchBrokerPrice(symbol: string): Promise<{ price: number; source: "broker" } | null> {
  try {
    const { sharedExecutor } = await import("@/lib/automation/sharedExecutor");
    const quote = await sharedExecutor.getUnderlyingQuote?.(symbol);
    return quote ? { price: quote.price, source: "broker" } : null;
  } catch (err) {
    console.warn(`[marketData] broker quote for ${symbol} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
