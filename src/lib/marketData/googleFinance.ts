/**
 * Server-only scraper for Google Finance quote pages.
 *
 * There is no public Google Finance API. This parses the server-rendered
 * HTML of https://www.google.com/finance/quote/<code>, which is undocumented
 * and can break without notice if Google changes their markup - that's why
 * every caller treats a parse failure as "no data" rather than throwing, and
 * the app's stale-data guard disables predictions when ticks stop arriving
 * instead of settling on stale/broken data.
 *
 * Anchor strategy: the page has exactly one `class="gO24Ff"` element (the
 * instrument's display name), immediately followed by a `jsname="Pdsbrc"`
 * span holding the last price. `jsname` attributes are Google's internal
 * behavior hooks and tend to be more stable across markup/style changes
 * than CSS class names, so we anchor on structure (name label -> next
 * Pdsbrc span) rather than on any specific class name or display string.
 *
 * Cookie note: without a session cookie, Google serves a stripped-down page
 * missing the price widget entirely (not an error page - a smaller 200 that
 * silently omits the data). A short-lived in-memory cookie jar, refreshed
 * whenever a parse comes up empty, works around this.
 */

/** Our app symbols -> Google Finance quote codes. ES1! has no clean Google
 * Finance equivalent (continuous futures aren't listed there), so it's
 * intentionally left out and falls back to the mock feed. */
export const GOOGLE_FINANCE_CODES: Partial<Record<string, string>> = {
  SPX: ".INX:INDEXSP",
  NDX: "NDX:INDEXNASDAQ",
  SPY: "SPY:NYSEARCA",
  QQQ: "QQQ:NASDAQ",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

let cookieJar = "";

function extractSetCookies(res: Response): string[] {
  const withGetSetCookie = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === "function") return withGetSetCookie.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

async function fetchWithCookies(url: string, timeoutMs: number): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      ...(cookieJar ? { Cookie: cookieJar } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const setCookies = extractSetCookies(res);
  if (setCookies.length > 0) {
    cookieJar = setCookies.map((c) => c.split(";")[0]).join("; ");
  }
  return res;
}

function parsePrice(html: string): number | null {
  const label = html.match(/class="gO24Ff">([^<]+)<\/div>/);
  if (!label) return null;
  const tail = html.slice(label.index!, label.index! + 600);
  const price = tail.match(/jsname="Pdsbrc"[^>]*><span>\$?([\d,]+\.?\d*)<\/span>/);
  if (!price) return null;
  const n = Number(price[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export async function fetchGoogleFinancePrice(symbol: string, timeoutMs = 8000): Promise<number | null> {
  const code = GOOGLE_FINANCE_CODES[symbol];
  if (!code) return null;
  const url = `https://www.google.com/finance/quote/${code}?hl=en`;

  try {
    const res = await fetchWithCookies(url, timeoutMs);
    if (!res.ok) return null;
    const price = parsePrice(await res.text());
    if (price != null) return price;

    // Empty parse usually means we're missing (or have a stale) session
    // cookie - Google then serves a smaller page with no price widget at
    // all. Drop the jar and retry once with a fresh one.
    cookieJar = "";
    const retry = await fetchWithCookies(url, timeoutMs);
    if (!retry.ok) return null;
    return parsePrice(await retry.text());
  } catch {
    return null;
  }
}
