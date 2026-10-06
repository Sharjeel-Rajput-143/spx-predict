/**
 * Pure helpers for scripts/tradier-sandbox-probe.ts - the read-only look at Tradier's sandbox that settles the
 * "unconfirmed" points (NDX option root, symbol format, strike increment, quotes). No I/O here.
 */

export interface OccParts {
  root: string;
  /** YYYY-MM-DD */
  expiry: string;
  right: "call" | "put";
  strike: number;
}

/** "NDXP261007P20970000" -> { root: "NDXP", expiry: "2026-10-07", right: "put", strike: 20970 } */
export function parseOcc(symbol: string): OccParts | null {
  const m = /^([A-Z0-9.]{1,6}?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol.trim());
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, right: m[5] === "C" ? "call" : "put", strike: Number(m[6]) / 1000 };
}

/** Always-an-array for Tradier's "one thing is an object, several are a list, none is null or a string". */
export function asList<T>(value: unknown): T[] {
  if (value == null || typeof value === "string") return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

/** The strike spacing near `price`: the gaps between the `count` strikes closest to it, and the one that occurs most. */
export function strikeIncrementNear(strikes: number[], price: number, count = 14): { increment: number | null; gaps: number[] } {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  const near = [...sorted].sort((a, b) => Math.abs(a - price) - Math.abs(b - price)).slice(0, count).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < near.length; i++) gaps.push(Math.round((near[i] - near[i - 1]) * 1000) / 1000);
  if (gaps.length === 0) return { increment: null, gaps };
  const tally = new Map<number, number>();
  for (const g of gaps) tally.set(g, (tally.get(g) ?? 0) + 1);
  const increment = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  return { increment, gaps: [...new Set(gaps)].sort((a, b) => a - b) };
}

export interface ChainOption {
  symbol: string;
  root_symbol?: string;
  strike?: number;
  option_type?: string;
  expiration_date?: string;
  bid?: number | null;
  ask?: number | null;
}

/** The puts closest to the price (at or below it), for a sample of real bid/ask. */
export function nearMoneyPuts(chain: ChainOption[], price: number, n = 2): ChainOption[] {
  return chain
    .filter((o) => (o.option_type === "put" || parseOcc(o.symbol)?.right === "put") && typeof o.strike === "number" && o.strike <= price)
    .sort((a, b) => (b.strike ?? 0) - (a.strike ?? 0))
    .slice(0, n);
}

/** Which roots a lookup returned, with how many contracts each, e.g. NDX: 812, NDXP: 640. */
export function rootsOf(lookup: unknown): { root: string; contracts: number }[] {
  const entries = asList<{ rootSymbol?: string; options?: unknown }>((lookup as { symbols?: unknown } | null)?.symbols);
  const count = (o: unknown) => (Array.isArray(o) ? o.length : typeof o === "string" && o !== "null" && o !== "" ? 1 : 0);
  return entries.filter((e) => e.rootSymbol).map((e) => ({ root: e.rootSymbol!, contracts: count(e.options) }));
}

/** Our own guess at the symbol, to compare with what Tradier really lists. */
export function ourSymbol(root: string, expiry: string, right: "call" | "put", strike: number): string {
  const [y, m, d] = expiry.split("-");
  return `${root}${y.slice(2)}${m}${d}${right === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

/** The expiry to inspect: today's if listed (a 0DTE), else the soonest upcoming one. */
export function pickExpiry(dates: string[], today: string): { expiry: string | null; zeroDte: boolean } {
  const upcoming = [...dates].sort().filter((d) => d >= today);
  return { expiry: upcoming[0] ?? null, zeroDte: upcoming[0] === today };
}
