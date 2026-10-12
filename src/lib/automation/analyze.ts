import { computeStats, positionPL, positionRisk } from "./pnl";
import type { Position, PositionType } from "./types";

/**
 * The Analyze view's numbers (Option Alpha's Positions > Analyze), worked out from the positions themselves and nothing else:
 * only a closed or expired position with a known result counts (a fill, an estimate from the day's close, or one typed in);
 * a refused order never does, and a position without a result is counted separately, never guessed. Pure arithmetic: no clock,
 * no network, so every number can be checked by hand. Safe for the browser.
 */

export type RangeKey = "all" | "7d" | "30d" | "90d" | "ytd";
export const RANGES: { key: RangeKey; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "ytd", label: "This year" },
];

export interface BotInfo {
  id: string;
  name: string;
  accountId: string | null;
  group: string | null;
  /** The credit assumed for risk until a fill reports a real one. */
  estimate: number | null;
}

export interface AnalyzeFilters {
  range: RangeKey;
  accounts: string[];
  symbols: string[];
  tags: string[];
  strategies: PositionType[];
  /** Days to expiration when it was opened (0 = same day). */
  dtes: number[];
  bots: string[];
  groups: string[];
  /** Day of the week it was opened, 1 = Monday ... 5 = Friday. */
  days: number[];
  /** Hour of the day it was opened, New York time, 0-23. */
  hours: number[];
}

export const NO_FILTERS: AnalyzeFilters = { range: "all", accounts: [], symbols: [], tags: [], strategies: [], dtes: [], bots: [], groups: [], days: [], hours: [] };

export const STRATEGY_LABEL: Record<PositionType, string> = { short_put_spread: "Short Put Spread", short_call_spread: "Short Call Spread" };
export const WEEKDAY_LABEL = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "AM" : "PM"}`;

const DAY_MS = 86_400_000;
const TRADING_DAYS_PER_YEAR = 252;

// --- New York calendar parts --------------------------------------------------------------------------------------

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hour12: false });
const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function etParts(ms: number): { dateKey: string; weekday: number; hour: number } {
  const parts = fmt.formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { dateKey: `${get("year")}-${get("month")}-${get("day")}`, weekday: WEEKDAY_INDEX[get("weekday")] ?? 0, hour: Number(get("hour")) % 24 };
}

/** Whole days from one YYYY-MM-DD to another. */
export const dayDiff = (fromKey: string, toKey: string) => Math.round((Date.parse(toKey) - Date.parse(fromKey)) / DAY_MS);

// --- What counts ---------------------------------------------------------------------------------------------------

export interface Counted {
  position: Position;
  pl: number;
  /** Capital at risk: (width - credit) x 100 x contracts. Null when no credit is known. */
  risk: number | null;
  /** When it ended (its close or expiry), New York time parts. */
  endedKey: string;
  /** When it was opened, New York time parts. */
  openedWeekday: number;
  openedHour: number;
  openedKey: string;
  dte: number;
  daysInTrade: number;
  botName: string;
}

export interface Bucket {
  key: string;
  label: string;
  value: number;
  count: number;
}

export interface DailyPoint {
  dateKey: string;
  pl: number;
  count: number;
  /** The day's result as a share of the capital at risk on the positions that ended that day. */
  returnOnRisk: number | null;
}

export interface Analysis {
  counted: Counted[];
  /** Finished positions (closed or expired) that match the filters but have no result yet, so they are not in any number here. */
  withoutResult: number;
  closedPL: number | null;
  /** Average over the days that had at least one position end. */
  plPerDay: number | null;
  profitFactor: number | null;
  winRate: number | null;
  positions: number;
  wins: number;
  losses: number;
  sharpe: number | null;
  sortino: number | null;
  avgPL: number | null;
  avgReturnOnRisk: number | null;
  avgRisk: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** Needs option prices and a pricing model: never available here. */
  entryPop: null;
  avgDte: number | null;
  avgDaysInTrade: number | null;
  /** Running total, one point per position in the order they ended. */
  curve: { at: number; value: number }[];
  daily: DailyPoint[];
  byWeekday: Bucket[];
  byHour: Bucket[];
  byStrategy: Bucket[];
  bySymbol: Bucket[];
  /** The first day in range, for "Since ...". */
  since: string | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function rangeStart(range: RangeKey, now: number): number {
  if (range === "all") return -Infinity;
  if (range === "ytd") return Date.parse(`${etParts(now).dateKey.slice(0, 4)}-01-01T00:00:00Z`) - 5 * 3_600_000; // 1 January, New York (standard time)
  return now - { "7d": 7, "30d": 30, "90d": 90 }[range] * DAY_MS;
}

const finished = (p: Position) => p.status === "closed" || p.status === "expired";

/** Which positions the filters let through (before asking whether they have a result). */
export function matchesFilters(p: Position, bot: BotInfo | undefined, f: AnalyzeFilters, now: number): boolean {
  if (!finished(p)) return false;
  const ended = p.closedAt ?? p.openedAt ?? 0;
  if (ended < rangeStart(f.range, now)) return false;
  if (f.accounts.length && !f.accounts.includes(bot?.accountId ?? "")) return false;
  if (f.symbols.length && !f.symbols.includes(p.underlying)) return false;
  if (f.tags.length && !(p.tags ?? []).some((t) => f.tags.includes(t))) return false;
  if (f.strategies.length && !f.strategies.includes(p.type)) return false;
  if (f.bots.length && !f.bots.includes(p.botId)) return false;
  if (f.groups.length && !f.groups.includes(bot?.group ?? "")) return false;
  const opened = p.openedAt != null ? etParts(p.openedAt) : null;
  if (f.dtes.length) {
    if (!opened || !f.dtes.includes(dayDiff(opened.dateKey, p.expiry))) return false;
  }
  if (f.days.length && (!opened || !f.days.includes(opened.weekday))) return false;
  if (f.hours.length && (!opened || !f.hours.includes(opened.hour))) return false;
  return true;
}

export function analyze(positions: Position[], bots: BotInfo[], filters: AnalyzeFilters, now: number): Analysis {
  const botById = new Map(bots.map((b) => [b.id, b]));
  const matching = positions.filter((p) => matchesFilters(p, botById.get(p.botId), filters, now));

  const counted: Counted[] = [];
  let withoutResult = 0;
  for (const p of matching) {
    const pl = positionPL(p);
    if (pl === null) {
      withoutResult++;
      continue;
    }
    const bot = botById.get(p.botId);
    const opened = p.openedAt != null ? etParts(p.openedAt) : null;
    const endedAt = p.closedAt ?? p.openedAt ?? 0;
    const ended = etParts(endedAt);
    counted.push({
      position: p,
      pl,
      risk: positionRisk(p, bot?.estimate ?? undefined),
      endedKey: ended.dateKey,
      openedWeekday: opened?.weekday ?? ended.weekday,
      openedHour: opened?.hour ?? ended.hour,
      openedKey: opened?.dateKey ?? ended.dateKey,
      dte: opened ? dayDiff(opened.dateKey, p.expiry) : 0,
      daysInTrade: opened ? Math.max(0, dayDiff(opened.dateKey, ended.dateKey)) : 0,
      botName: bot?.name ?? p.botId,
    });
  }
  counted.sort((a, b) => (a.position.closedAt ?? 0) - (b.position.closedAt ?? 0));

  // The same definitions as the bot's own dashboard, so a number is never different on two pages.
  const stats = computeStats(counted.map((c) => c.position));

  // One row per day a position ended.
  const days = new Map<string, { pl: number; count: number; risk: number }>();
  for (const c of counted) {
    const d = days.get(c.endedKey) ?? { pl: 0, count: 0, risk: 0 };
    d.pl += c.pl;
    d.count += 1;
    d.risk += c.risk ?? 0;
    days.set(c.endedKey, d);
  }
  const daily: DailyPoint[] = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateKey, d]) => ({ dateKey, pl: round2(d.pl), count: d.count, returnOnRisk: d.risk > 0 ? d.pl / d.risk : null }));

  // Sharpe and Sortino from the daily return on risk, annualised over 252 trading days with a 0% risk-free rate.
  const returns = daily.map((d) => d.returnOnRisk).filter((r): r is number => r !== null);
  let sharpe: number | null = null;
  let sortino: number | null = null;
  if (returns.length >= 2) {
    const m = mean(returns)!;
    const variance = returns.reduce((s, r) => s + (r - m) ** 2, 0) / (returns.length - 1);
    if (variance > 0) sharpe = (m / Math.sqrt(variance)) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    const downside = Math.sqrt(returns.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / returns.length);
    if (downside > 0) sortino = (m / downside) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  }

  const risks = counted.map((c) => c.risk).filter((r): r is number => r !== null && r > 0);
  const returnsOnRisk = counted.filter((c) => c.risk !== null && c.risk > 0).map((c) => c.pl / c.risk!);

  const sum = (items: Counted[], key: (c: Counted) => string, label: (k: string) => string): Bucket[] => {
    const m = new Map<string, { value: number; count: number }>();
    for (const c of items) {
      const k = key(c);
      const e = m.get(k) ?? { value: 0, count: 0 };
      e.value += c.pl;
      e.count += 1;
      m.set(k, e);
    }
    return [...m.entries()].map(([k, e]) => ({ key: k, label: label(k), value: round2(e.value), count: e.count }));
  };

  const byWeekday = [1, 2, 3, 4, 5].map((d) => {
    const items = counted.filter((c) => c.openedWeekday === d);
    return { key: String(d), label: WEEKDAY_LABEL[d], value: round2(items.reduce((s, c) => s + c.pl, 0)), count: items.length };
  });
  const hoursSeen = counted.map((c) => c.openedHour);
  const firstHour = Math.min(9, ...hoursSeen);
  const lastHour = Math.max(15, ...hoursSeen);
  const byHour = Array.from({ length: lastHour - firstHour + 1 }, (_, i) => firstHour + i).map((h) => {
    const items = counted.filter((c) => c.openedHour === h);
    return { key: String(h), label: hourLabel(h), value: round2(items.reduce((s, c) => s + c.pl, 0)), count: items.length };
  });

  return {
    counted,
    withoutResult,
    closedPL: stats.closedPL === null ? null : round2(stats.closedPL),
    plPerDay: daily.length ? round2(daily.reduce((s, d) => s + d.pl, 0) / daily.length) : null,
    profitFactor: stats.profitFactor,
    winRate: counted.length ? stats.winRate : null,
    positions: counted.length,
    wins: stats.wins,
    losses: stats.losses,
    sharpe,
    sortino,
    avgPL: stats.avgPL === null ? null : round2(stats.avgPL),
    avgReturnOnRisk: mean(returnsOnRisk),
    avgRisk: mean(risks) === null ? null : round2(mean(risks)!),
    avgWin: stats.avgWin === null ? null : round2(stats.avgWin),
    avgLoss: stats.avgLoss === null ? null : round2(stats.avgLoss),
    entryPop: null,
    avgDte: mean(counted.map((c) => c.dte)),
    avgDaysInTrade: mean(counted.map((c) => c.daysInTrade)),
    curve: stats.curve,
    daily,
    byWeekday,
    byHour,
    byStrategy: sum(counted, (c) => c.position.type, (k) => STRATEGY_LABEL[k as PositionType] ?? k).sort((a, b) => b.value - a.value),
    bySymbol: sum(counted, (c) => c.position.underlying, (k) => k).sort((a, b) => b.value - a.value),
    since: daily[0]?.dateKey ?? null,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What each filter offers: only what the positions actually contain. */
export function filterOptions(positions: Position[], bots: BotInfo[]) {
  const botById = new Map(bots.map((b) => [b.id, b]));
  const fin = positions.filter(finished);
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  const dtes = uniq(fin.filter((p) => p.openedAt != null).map((p) => dayDiff(etParts(p.openedAt!).dateKey, p.expiry))).sort((a, b) => a - b);
  const hours = uniq(fin.filter((p) => p.openedAt != null).map((p) => etParts(p.openedAt!).hour)).sort((a, b) => a - b);
  return {
    accounts: uniq(fin.map((p) => botById.get(p.botId)?.accountId).filter((x): x is string => !!x)).sort(),
    symbols: uniq(fin.map((p) => p.underlying)).sort(),
    tags: uniq(fin.flatMap((p) => p.tags ?? [])).sort(),
    strategies: uniq(fin.map((p) => p.type)),
    dtes,
    bots: uniq(fin.map((p) => p.botId)).map((id) => ({ id, name: botById.get(id)?.name ?? id })),
    groups: uniq(fin.map((p) => botById.get(p.botId)?.group).filter((x): x is string => !!x)).sort(),
    days: [1, 2, 3, 4, 5],
    hours,
  };
}

