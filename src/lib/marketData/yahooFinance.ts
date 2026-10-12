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

export async function fetchYahooFinancePrice(symbol: string, timeoutMs = 8000): Promise<number | null> {
  const code = YAHOO_CODES[symbol];
  if (!code) return null;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?interval=1m&range=1d`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
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

const easternDay = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

/**
 * The official closing price of a symbol on one trading day ("YYYY-MM-DD", New York date), from Yahoo's daily bars, or null when it
 * can't be had (the day isn't among the recent bars, the market was shut, the endpoint failed). Same unofficial source as the
 * live quote, so it is only ever used to estimate how an expired position settled, never to place anything.
 */
export async function fetchYahooDailyClose(symbol: string, dateKey: string, fetcher: typeof fetch = fetch): Promise<number | null> {
  const code = YAHOO_CODES[symbol];
  if (!code) return null;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?interval=1d&range=1mo`;
  try {
    const res = await fetcher(url, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] } };
    const result = data.chart?.result?.[0];
    const times = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    for (let i = 0; i < times.length; i++) {
      if (easternDay(times[i] * 1000) !== dateKey) continue;
      const close = closes[i];
      return typeof close === "number" && Number.isFinite(close) && close > 0 ? close : null;
    }
    return null;
  } catch {
    return null;
  }
}
