/**
 * Fallback quote source for when Google Finance is unreachable or its
 * markup has drifted (see googleFinance.ts - there's no official API for
 * either source, so a single-source outage would otherwise take the whole
 * live feed, and every automation watching it, down with it).
 *
 * Yahoo Finance's chart endpoint is unofficial but returns plain JSON with
 * a `regularMarketPrice` field - no HTML parsing to go stale, and it's the
 * same endpoint most third-party finance tools have relied on for years.
 * tickStore only reaches for this after Google Finance itself has failed.
 */

export const YAHOO_CODES: Partial<Record<string, string>> = {
  SPX: "^GSPC",
  NDX: "^NDX",
  SPY: "SPY",
  QQQ: "QQQ",
};

export async function fetchYahooFinancePrice(symbol: string): Promise<number | null> {
  const code = YAHOO_CODES[symbol];
  if (!code) return null;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?interval=1m&range=1d`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: { result?: { meta?: { regularMarketPrice?: number } }[] };
    };
    const price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === "number" && Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}
