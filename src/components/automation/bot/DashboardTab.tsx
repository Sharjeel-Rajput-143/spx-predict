"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconBell, IconChevronRight, IconInfo } from "@/components/icons";
import { Card } from "@/components/ui";
import { cn } from "@/lib/format";
import type { Decision } from "@/lib/automation/types";
import type { BotContext } from "./BotDetail";
import { LineChart, type ChartPoint } from "./LineChart";
import { InfoTip, KeyValue, Pill } from "./primitives";
import { NO_PRICE_TIP, TYPE_LABEL, etDayKey, etShortTime, outcomeInfo, pctText, plClass, plText, usd, usd2, type BotDetailData } from "./model";
import { btcActivity, isBtcPosition, isBtcUnderlying } from "./btcWording";

type Metric = "pl" | "opened";

export function DashboardTab({ ctx }: { ctx: BotContext }) {
  const { data, navigate } = ctx;
  const { stats, capital, counts, limits } = data;
  const allocation = data.config?.allocationLimit ?? null;
  const returnPct = stats.closedPL != null && allocation ? stats.closedPL / allocation : null;
  const [metric, setMetric] = useState<Metric>(stats.priced > 0 ? "pl" : "opened");
  // The BTC bot trades a tiny size, so its results are cents: +$0.72 must not read as +$1. The option bots keep whole dollars.
  const cents = isBtcUnderlying(data.config?.underlying);
  const digits = cents ? 2 : 0;
  const money = cents ? usd2 : usd;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Tile label="Closed P/L" tip={NO_PRICE_TIP} value={<span className={plClass(stats.closedPL)}>{plText(stats.closedPL, digits)}</span>} />
          <Tile label="Return" tip="Closed P/L as a share of the bot's allocation." value={<span className={plClass(returnPct)}>{pctText(returnPct, 2)}</span>} />
          <Tile label="Change" tip="Unrealized change needs live option prices, which Phase 1 doesn't have." value="—" />
          <Tile label="Change %" tip="Unrealized change needs live option prices, which Phase 1 doesn't have." value="—" />
        </div>

        <PerformanceChart data={data} metric={metric} onMetric={setMetric} />

        <Card className="p-5">
          <h2 className="mb-4 text-base font-semibold">Position stats</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
            <Stat label="Closed positions" value={stats.finished} link onClick={() => navigate("positions")} />
            <Stat label="Closed P/L" value={<span className={plClass(stats.closedPL)}>{plText(stats.closedPL, digits)}</span>} />
            <Stat label="Profit factor" value={stats.profitFactor != null ? stats.profitFactor.toFixed(2) : "—"} tip="Gross wins divided by gross losses. Blank until there is at least one loss." />
            <Stat label="Max drawdown" value={stats.maxDrawdown != null ? money(stats.maxDrawdown) : "—"} tip="The largest peak-to-trough drop in realized P/L." />
            <Stat label="Win rate" value={pctText(stats.winRate, 1, false)} />
            <Stat label="Wins" value={stats.priced ? stats.wins : "—"} />
            <Stat label="Losses" value={stats.priced ? stats.losses : "—"} />
            <Stat label="Avg P/L" value={<span className={plClass(stats.avgPL)}>{plText(stats.avgPL, digits)}</span>} />
            <Stat label="Avg win" value={<span className="text-up">{plText(stats.avgWin, digits)}</span>} />
            <Stat label="Avg loss" value={<span className="text-down">{plText(stats.avgLoss, digits)}</span>} />
            <Stat
              label="Streak"
              link={!!stats.streak}
              onClick={() => navigate("positions")}
              value={stats.streak ? <span className={stats.streak.kind === "win" ? "text-up" : "text-down"}>{stats.streak.count} {stats.streak.kind === "win" ? "win" : "loss"}{stats.streak.count === 1 ? "" : stats.streak.kind === "win" ? "s" : "es"}</span> : "—"}
            />
            <Stat label="Expired" value={data.positions.filter((p) => p.status === "expired").length} tip="Positions left to expire at the 4:05 PM sweep - their result isn't priced." />
          </div>
          {stats.priced === 0 && (
            <p className="mt-5 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
              {stats.finished > 0 ? `${stats.finished} finished position${stats.finished === 1 ? "" : "s"}, none with a fill price. ` : ""}
              {NO_PRICE_TIP}
            </p>
          )}
          <div className="mt-4 text-center">
            <button onClick={() => navigate("positions")} className="text-sm font-medium text-accent hover:underline">
              Analyze results ›
            </button>
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <ActivityCard ctx={ctx} />

        <Card className="p-5">
          <h2 className="mb-2 text-base font-semibold">Capital</h2>
          {capital ? (
            <KeyValue
              rows={[
                [<>Allocation</>, money(capital.allocation)],
                [<>Net liquid<InfoTip text="Allocation plus realized P/L. Blank until closes are priced." /></>, capital.netLiquid != null ? money(capital.netLiquid) : "—"],
                [<>At risk<InfoTip text="Maximum loss on open positions: (width - credit) x 100 x quantity." /></>, money(capital.atRisk)],
                [<>Available<InfoTip text="Allocation minus what's at risk." /></>, money(capital.available)],
              ]}
            />
          ) : (
            <p className="text-sm text-muted">Unavailable until the bot&apos;s required settings are filled in.</p>
          )}
          <p className="mt-3 text-xs text-faint">
            {counts.activePositions}/{limits.totalPositionLimit} positions open
          </p>
        </Card>

        <TagsCard ctx={ctx} />
      </div>
    </div>
  );
}

function Tile({ label, value, tip }: { label: string; value: React.ReactNode; tip?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
        {tip && <InfoTip text={tip} />}
      </div>
      <div className="tabular mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function Stat({ label, value, tip, link, onClick }: { label: string; value: React.ReactNode; tip?: string; link?: boolean; onClick?: () => void }) {
  return (
    <div>
      <div className={cn("text-[11px] font-medium uppercase tracking-wide", link ? "text-accent" : "text-muted")}>
        {link && onClick ? (
          <button onClick={onClick} className="uppercase tracking-wide hover:underline">
            {label}
          </button>
        ) : (
          label
        )}
        {tip && <InfoTip text={tip} />}
      </div>
      <div className="tabular mt-1 text-lg font-medium">{value}</div>
    </div>
  );
}

function PerformanceChart({ data, metric, onMetric }: { data: BotDetailData; metric: Metric; onMetric: (m: Metric) => void }) {
  const points = useMemo<ChartPoint[]>(() => {
    if (metric === "pl") return data.stats.curve;
    // Cumulative positions opened, in the order they opened.
    return data.positions
      .filter((p) => p.openedAt != null && p.status !== "rejected")
      .sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0))
      .map((p, i) => ({ at: p.openedAt ?? 0, value: i + 1 }));
  }, [data, metric]);

  const cents = isBtcUnderlying(data.config?.underlying);
  const dollars = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", cents ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : undefined)}`;
  const since = points[0] ? new Date(points[0].at).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : null;

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <label className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          <select
            value={metric}
            onChange={(e) => onMetric(e.target.value as Metric)}
            aria-label="Chart metric"
            className="cursor-pointer rounded bg-transparent py-1 pr-1 text-[11px] font-medium uppercase tracking-wide outline-none"
          >
            <option value="pl">Closed P/L</option>
            <option value="opened">Positions opened</option>
          </select>
        </label>
      </div>
      <LineChart
        points={points}
        format={metric === "pl" ? dollars : (n) => String(n)}
        empty={metric === "pl" ? "No priced closes yet - Closed P/L needs fill prices from the executor." : "No positions opened yet."}
        integer={metric === "opened"}
      />
      {since && <div className="mt-2 text-[11px] text-faint">Since {since}</div>}
    </Card>
  );
}

const PREV_VISIT_KEY = (botId: string) => `automation:last-visit:${botId}`;

function ActivityCard({ ctx }: { ctx: BotContext }) {
  const { data, navigate } = ctx;
  const [since, setSince] = useState<number | null>(null);
  const mounted = useRef(false);

  // "Since" is the previous visit to this dashboard - what happened while you were away.
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    try {
      const prev = Number(localStorage.getItem(PREV_VISIT_KEY(data.bot.id)));
      setSince(Number.isFinite(prev) && prev > 0 ? prev : null);
      localStorage.setItem(PREV_VISIT_KEY(data.bot.id), String(Date.now()));
    } catch {
      /* storage unavailable: just no marker */
    }
  }, [data.bot.id]);

  const positions = new Map(data.positions.map((p) => [p.id, p]));
  const recent = data.decisions.filter((d) => d.createdAt > data.bot.logClearedAt).slice(0, 6);

  /** A short title, and (for decisions that aren't a position) the reason underneath. */
  const describe = (d: Decision): { title: string; reason?: string } => {
    const info = outcomeInfo(d.outcome);
    const pos = (d.detail?.positionId as string | undefined) ? positions.get(d.detail.positionId as string) : undefined;
    // A BTC trade is not a spread: it is named long or short, and how it ended (see btcWording.ts).
    if (pos && isBtcPosition(pos)) return btcActivity(d, pos, info.label);
    return pos ? { title: `${info.label}: ${TYPE_LABEL[pos.type]} ${pos.shortStrike}/${pos.longStrike}` } : { title: info.label, reason: d.reason };
  };

  return (
    <Card className="p-5">
      <h2 className="mb-2 text-base font-semibold">Activity</h2>
      {recent.length === 0 ? (
        <p className="py-3 text-sm text-muted">Nothing yet. Decisions show up here as signals arrive.</p>
      ) : (
        <ul className="divide-y divide-line">
          {recent.map((d) => {
            const info = outcomeInfo(d.outcome);
            const isNew = since != null && d.createdAt > since;
            return (
              <li key={d.id}>
                <button
                  onClick={() => navigate(d.outcome === "opened" || d.outcome === "closed" ? "positions" : "log")}
                  className="flex w-full items-center gap-3 py-2.5 text-left hover:text-accent"
                >
                  <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full", info.tone === "ok" ? "bg-up-soft text-up" : info.tone === "error" ? "bg-down-soft text-down" : info.tone === "warn" ? "bg-amber-500/15 text-amber-500" : "bg-surface-2 text-muted")}>
                    {info.tone === "ok" ? <IconBell width={12} height={12} /> : <IconInfo width={12} height={12} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{describe(d).title}</span>
                    <span className="tabular block truncate text-xs text-faint" title={describe(d).reason}>
                      {etShortTime(d.createdAt)}
                      {describe(d).reason ? ` · ${describe(d).reason}` : ""}
                    </span>
                  </span>
                  {isNew && <Pill tone="info">New</Pill>}
                  <IconChevronRight width={14} height={14} className="shrink-0 text-faint" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-faint">
        {since ? `* Since your last visit, ${new Date(since).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "* Most recent decisions"} · New York time
      </p>
      <p className="mt-0.5 text-[11px] text-faint">{etDayKey(data.now)}</p>
    </Card>
  );
}

function TagsCard({ ctx }: { ctx: BotContext }) {
  const { data, patch } = ctx;
  const [draft, setDraft] = useState("");
  const tags = data.bot.tags;

  const add = () => {
    const t = draft.trim();
    if (!t || tags.includes(t)) return setDraft("");
    setDraft("");
    patch({ tags: [...tags, t] });
  };

  return (
    <Card className="p-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">Tags</h2>
        {tags.length > 0 && (
          <button onClick={() => patch({ tags: [] })} className="text-xs font-medium text-accent hover:underline">
            Reset
          </button>
        )}
      </div>
      {tags.length === 0 && <p className="mb-2 text-sm text-faint">No tags yet.</p>}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1 text-xs">
            {t}
            <button onClick={() => patch({ tags: tags.filter((x) => x !== t) })} aria-label={`Remove tag ${t}`} className="text-faint hover:text-down">
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
        placeholder="Add tag"
        aria-label="Add tag"
        className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
      />
    </Card>
  );
}
