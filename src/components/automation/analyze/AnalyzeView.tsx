"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui";
import { cn } from "@/lib/format";
import { NO_FILTERS, RANGES, STRATEGY_LABEL, WEEKDAY_LABEL, analyze, filterOptions, hourLabel, type AnalyzeFilters, type BotInfo, type RangeKey } from "@/lib/automation/analyze";
import type { HindsightReport } from "@/lib/automation/hindsight";
import { positionsToCsv } from "@/lib/automation/positionsCsv";
import type { Position, PositionType } from "@/lib/automation/types";
import { InfoTip } from "../bot/primitives";
import { pctText, plClass, plText, usd } from "../bot/model";
import { AreaChart, BarList, CalendarGrid, ColumnChart, Donut, MiniBars, Spark, money } from "./charts";
import { MultiSelect } from "./MultiSelect";

const TIPS = {
  closedPL: "The total result of the closed and expired positions in view. A result comes from a fill, from the day's closing price (marked estimated) or from one typed in.",
  perDay: "Closed P/L divided by the number of days on which a position ended.",
  profitFactor: "Gross wins divided by gross losses. Blank until there is at least one loss.",
  winRate: "Positions that made money, as a share of all the positions counted. A break-even one is neither a win nor a loss.",
  sharpe: "The average daily return on risk divided by its standard deviation, annualised over 252 trading days, with a 0% risk-free rate. The daily return on risk is that day's result over the capital at risk on the positions that ended that day.",
  sortino: "Like Sharpe, but only the days that lost money count as risk. Blank when no day lost money.",
  entryPop: "The chance of profit when the position was opened needs option prices and a pricing model, which this platform doesn't have. It is never estimated.",
  returnOnRisk: "Each position's result over its capital at risk, averaged.",
  dte: "Days from opening to expiration. 0 is a same-day option.",
  daysInTrade: "Days from opening to closing or expiring.",
  weekday: "Result by the day of the week the position was opened (New York time).",
  hour: "Result by the hour of the day the position was opened (New York time).",
};

type ChartMode = "total" | "daily" | "calendar";

const dateText = (key: string) => {
  const [y, m, d] = key.split("-");
  return `${m}/${d}/${y}`;
};

function Tile({ label, tip, value, tone, visual }: { label: string; tip: string; value: string; tone?: string; visual: React.ReactNode }) {
  return (
    <Card className="flex items-center justify-between gap-3 p-3.5">
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          {label}
          <InfoTip text={tip} />
        </div>
        <div className={cn("tabular mt-1 text-xl font-semibold", tone)}>{value}</div>
      </div>
      {visual}
    </Card>
  );
}

function Row({ label, tip, value, tone }: { label: string; tip?: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
        {tip && <InfoTip text={tip} />}
      </span>
      <span className={cn("tabular", tone)}>{value}</span>
    </div>
  );
}

const optionList = <T extends string | number>(values: T[], label: (v: T) => string) => values.map((v) => ({ value: String(v), label: label(v) }));

/** Option Alpha's Positions > Analyze: how the closed positions did, sliced by account, symbol, tag, strategy, bot, day and hour. */
export function AnalyzeView({ positions, bots, now, botName }: { positions: Position[]; bots: BotInfo[]; now: number; botName: (id: string) => string }) {
  const [filters, setFilters] = useState<AnalyzeFilters>(NO_FILTERS);
  const [mode, setMode] = useState<ChartMode>("total");
  const options = useMemo(() => filterOptions(positions, bots), [positions, bots]);
  const a = useMemo(() => analyze(positions, bots, filters, now), [positions, bots, filters, now]);
  const set = <K extends keyof AnalyzeFilters>(key: K, value: AnalyzeFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const active = Object.entries(filters).some(([k, v]) => (k === "range" ? v !== "all" : (v as unknown[]).length > 0));

  const [report, setReport] = useState<HindsightReport | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const createReport = async () => {
    setReporting(true);
    setReportError(null);
    try {
      const res = await fetch("/api/automation/analyze/hindsight", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: a.counted.map((c) => c.position.id) }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "The report couldn't be made.");
      setReport(json as HindsightReport);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "The report couldn't be made.");
    } finally {
      setReporting(false);
    }
  };

  const exportData = () => {
    const csv = positionsToCsv(a.counted.map((c) => c.position), botName);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `positions-${new Date(now).toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const empty = a.positions === 0;
  const grossWin = a.counted.filter((c) => c.pl > 0).reduce((s, c) => s + c.pl, 0);
  const grossLoss = -a.counted.filter((c) => c.pl < 0).reduce((s, c) => s + c.pl, 0);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2" aria-label="Filters">
        <MultiSelect label="Account" options={optionList(options.accounts, (v) => v)} selected={filters.accounts} onChange={(v) => set("accounts", v)} />
        <MultiSelect label="Symbols" options={optionList(options.symbols, (v) => v)} selected={filters.symbols} onChange={(v) => set("symbols", v)} />
        <MultiSelect label="Tags" options={optionList(options.tags, (v) => v)} selected={filters.tags} onChange={(v) => set("tags", v)} />
        <MultiSelect label="Strategy" options={optionList(options.strategies, (v) => STRATEGY_LABEL[v])} selected={filters.strategies} onChange={(v) => set("strategies", v as PositionType[])} />
        <MultiSelect label="DTE" options={optionList(options.dtes, (v) => `${v} day${v === 1 ? "" : "s"}`)} selected={filters.dtes.map(String)} onChange={(v) => set("dtes", v.map(Number))} />
        <MultiSelect label="Bot" options={options.bots.map((b) => ({ value: b.id, label: b.name }))} selected={filters.bots} onChange={(v) => set("bots", v)} />
        <MultiSelect label="Bot Group" options={optionList(options.groups, (v) => v)} selected={filters.groups} onChange={(v) => set("groups", v)} />
        <MultiSelect label="Day" options={optionList(options.days, (v) => WEEKDAY_LABEL[v])} selected={filters.days.map(String)} onChange={(v) => set("days", v.map(Number))} />
        <MultiSelect label="Hour" options={optionList(options.hours, hourLabel)} selected={filters.hours.map(String)} onChange={(v) => set("hours", v.map(Number))} />
        {active && (
          <button onClick={() => setFilters(NO_FILTERS)} className="rounded-lg px-2 py-1.5 text-sm text-muted underline-offset-2 hover:text-fg hover:underline">
            Clear filters
          </button>
        )}
      </div>

      {a.withoutResult > 0 && (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          {a.withoutResult} finished position{a.withoutResult === 1 ? " has" : "s have"} no result yet (no fill price, and no closing price to settle it from), so {a.withoutResult === 1 ? "it isn't" : "they aren't"} in any number here.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {/* Tiles */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Tile label="Closed P/L" tip={TIPS.closedPL} value={plText(a.closedPL)} tone={plClass(a.closedPL)} visual={<Spark values={a.curve.map((c) => c.value)} />} />
            <Tile label="P/L per day" tip={TIPS.perDay} value={plText(a.plPerDay)} tone={plClass(a.plPerDay)} visual={<MiniBars values={a.daily.map((d) => d.pl)} />} />
            <Tile label="Profit factor" tip={TIPS.profitFactor} value={a.profitFactor != null ? a.profitFactor.toFixed(2) : "—"} visual={<Donut fraction={grossWin + grossLoss > 0 ? grossWin / (grossWin + grossLoss) : null} label="Gross wins against gross losses" />} />
            <Tile label="Win rate" tip={TIPS.winRate} value={pctText(a.winRate, 1, false)} visual={<Donut fraction={a.winRate} label="Win rate" />} />
          </div>

          {/* Closed P/L */}
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold">Closed P/L</div>
              <div className="inline-flex overflow-hidden rounded-lg border border-line text-xs" role="tablist" aria-label="Chart type">
                {([["total", "Total"], ["daily", "Daily"], ["calendar", "Calendar"]] as const).map(([m, text]) => (
                  <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn("px-3 py-1.5", mode === m ? "bg-accent/10 font-medium text-accent" : "text-muted hover:text-fg")}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
            {mode === "total" && <AreaChart points={a.curve} empty="No closed positions with a result in this range." />}
            {mode === "daily" && (
              <ColumnChart
                height="h-72"
                buckets={a.daily.map((d) => ({ key: d.dateKey, label: d.dateKey.slice(5).replace("-", "/"), value: d.pl, count: d.count }))}
                labelEvery={Math.max(1, Math.ceil(a.daily.length / 12))}
                empty="No closed positions with a result in this range."
              />
            )}
            {mode === "calendar" && <CalendarGrid daily={a.daily} />}
            {a.since && <div className="mt-2 text-[11px] text-faint">Since {dateText(a.since)}</div>}
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-4">
              <div className="mb-3 flex items-center gap-1 text-sm font-semibold">
                Day of Week <InfoTip text={TIPS.weekday} />
              </div>
              <ColumnChart buckets={a.byWeekday} empty="No closed positions yet." />
            </Card>
            <Card className="p-4">
              <div className="mb-3 flex items-center gap-1 text-sm font-semibold">
                Hour of Day <InfoTip text={TIPS.hour} />
              </div>
              <ColumnChart buckets={a.byHour} empty="No closed positions yet." />
            </Card>
          </div>

          <Card className="p-4">
            <div className="mb-3 text-sm font-semibold">By Strategy</div>
            <BarList buckets={a.byStrategy} empty="No closed positions yet." />
          </Card>
          <Card className="p-4">
            <div className="mb-3 text-sm font-semibold">By Symbol</div>
            <BarList buckets={a.bySymbol} empty="No closed positions yet." />
          </Card>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3 text-sm">
              <label htmlFor="analyze-range" className="font-semibold">
                Range
              </label>
              <select id="analyze-range" value={filters.range} onChange={(e) => set("range", e.target.value as RangeKey)} className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-fg">
                {RANGES.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            {a.since && <div className="mt-2 text-xs text-accent">Since {dateText(a.since)}</div>}
          </Card>

          <Card className="p-4">
            <div className="mb-1 text-sm font-semibold">Metrics</div>
            <Row label="Positions" value={a.positions} />
            <Row label="Wins" value={a.wins} />
            <Row label="Losses" value={a.losses} />
            <Row label="Sharpe ratio" tip={TIPS.sharpe} value={a.sharpe != null ? a.sharpe.toFixed(2) : "—"} />
            <Row label="Sortino ratio" tip={TIPS.sortino} value={a.sortino != null ? a.sortino.toFixed(2) : "—"} />
            <div className="mb-1 mt-3 text-sm font-semibold">Averages</div>
            <Row label="P/L" value={plText(a.avgPL)} tone={plClass(a.avgPL)} />
            <Row label="Return on risk" tip={TIPS.returnOnRisk} value={pctText(a.avgReturnOnRisk, 2)} tone={plClass(a.avgReturnOnRisk)} />
            <Row label="Risk" value={a.avgRisk != null ? usd(a.avgRisk) : "—"} />
            <Row label="Win" value={plText(a.avgWin)} tone={plClass(a.avgWin)} />
            <Row label="Loss" value={plText(a.avgLoss)} tone={plClass(a.avgLoss)} />
            <Row label="Entry POP" tip={TIPS.entryPop} value="—" />
            <Row label="DTE" tip={TIPS.dte} value={a.avgDte != null ? `${Math.round(a.avgDte * 10) / 10} days` : "—"} />
            <Row label="Days in trade" tip={TIPS.daysInTrade} value={a.avgDaysInTrade != null ? `${Math.round(a.avgDaysInTrade * 10) / 10} days` : "—"} />
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Hindsight Report</div>
            <p className="mt-1 text-xs text-muted">Find out what would have happened if you held these positions until expiration.</p>
            <button onClick={createReport} disabled={reporting || empty} className="mt-3 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-50">
              {reporting ? "Working it out..." : "Create Report"}
            </button>
            {reportError && <p className="mt-2 text-xs text-down">{reportError}</p>}
            {report && <HindsightResult report={report} />}
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Export Data</div>
            <p className="mt-1 text-xs text-muted">Download the position data for all positions included in this report (up to 10,000 positions).</p>
            <button onClick={exportData} disabled={empty} className="mt-3 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-50">
              Export Data
            </button>
          </Card>
        </div>
      </div>
    </div>
  );
}

function HindsightResult({ report }: { report: HindsightReport }) {
  if (report.rows.length === 0) return <p className="mt-3 text-xs text-muted">None of these positions were closed before they expired, so there is nothing to compare.</p>;
  if (report.compared === 0) return <p className="mt-3 text-xs text-muted">{report.unknown} position{report.unknown === 1 ? " was" : "s were"} closed early, but the closing price of {report.unknown === 1 ? "its" : "their"} expiration day isn't available yet, so nothing can be compared.</p>;
  const better = report.difference > 0;
  return (
    <div className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
      <Row label="Closed early" value={`${report.compared} position${report.compared === 1 ? "" : "s"}`} />
      <Row label="Actual P/L" value={money(report.actualTotal)} tone={plClass(report.actualTotal)} />
      <Row label="Held to expiry" value={money(report.heldTotal)} tone={plClass(report.heldTotal)} />
      <Row label="Difference" value={plText(report.difference)} tone={plClass(report.difference)} />
      <p className="pt-1 text-xs text-muted">
        Holding would have {better ? "made more" : report.difference < 0 ? "made less" : "made the same"} overall: {report.betterHeld} would have done better held, {report.worseHeld} worse. Worked out from each expiration day&apos;s official closing price; an estimate, not a fill.
        {report.unknown > 0 && ` ${report.unknown} more can't be compared yet.`}
      </p>
    </div>
  );
}
