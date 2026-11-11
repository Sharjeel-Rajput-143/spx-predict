import "server-only";

/**
 * The BTC bot's price: Bybit's own, never the NDX quote. One public (no key) read of the mark price of BTCUSDT on the Bybit DEMO host, the same price Bybit's stops and
 * its profit and loss work from. Null when Bybit cannot be reached or gives nothing usable; the caller then has no price and says so.
 */
export const BYBIT_FEED_URL = "https://api-demo.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT";

export async function fetchBybitPrice(timeoutMs: number, fetcher: typeof fetch = fetch): Promise<number | null> {
  try {
    const res = await fetcher(BYBIT_FEED_URL, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { retCode?: number; result?: { list?: { markPrice?: string; lastPrice?: string }[] } };
    if (json.retCode !== 0) return null;
    const row = json.result?.list?.[0];
    const price = Number(row?.markPrice || row?.lastPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}
