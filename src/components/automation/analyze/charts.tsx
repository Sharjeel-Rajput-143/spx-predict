"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/format";
import type { Bucket, DailyPoint } from "@/lib/automation/analyze";
import { niceTicks } from "../bot/chartScale";

/** Dollars for an axis or a label: $1,200, -$90. */
export const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

const EMPTY = "grid place-items-center rounded-lg bg-surface-2/40 text-sm text-muted";

/** Running total as a filled area: dashed gridlines, the values down the left edge, a read-out on hover. */
export function AreaChart({ points, empty }: { points: { at: number; value: number }[]; empty: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return <div className={cn(EMPTY, "h-72")}>{empty}</div>;

  const values = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (v: number) => 100 - ((v - lo) / (hi - lo || 1)) * 100;
  const x = (i: number) => (points.length === 1 ? 50 : (i / (points.length - 1)) * 100);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(2)},${y(0).toFixed(2)} L${x(0).toFixed(2)},${y(0).toFixed(2)} Z`;
  const up = points[points.length - 1].value >= 0;
  const active = hover != null ? points[hover] : null;

  return (
    <div className="flex gap-2">
      <div className="relative h-72 w-14 shrink-0 text-right text-[11px] text-muted">
        {ticks.map((t) => (
          <span key={t} className="absolute right-0 -translate-y-1/2 tabular" style={{ top: `${y(t)}%` }}>
            {money(t)}
          </span>
        ))}
      </div>
      <div
        className="relative h-72 flex-1"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - rect.left) / rect.width) * (points.length - 1)))));
        }}
      >
        {ticks.map((t) => (
          <div key={t} className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: `${y(t)}%` }} />
        ))}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <path d={area} fill={up ? "var(--up)" : "var(--down)"} fillOpacity={0.35} />
          <path d={line} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        </svg>
        {active && (
          <>
            <div className="pointer-events-none absolute inset-y-0 border-l border-fg/30" style={{ left: `${x(hover!)}%` }} />
            <div className="pointer-events-none absolute top-1 z-10 rounded-md border border-line bg-surface px-2 py-1 text-xs shadow" style={{ left: `${Math.min(x(hover!), 78)}%` }}>
              <div className="tabular font-medium">{money(active.value)}</div>
              <div className="text-faint">{new Date(active.at).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Vertical bars, green above zero and red below, with the values down the left edge. */
export function ColumnChart({ buckets, labelEvery = 1, empty, height = "h-44" }: { buckets: Bucket[]; labelEvery?: number; empty?: string; height?: string }) {
  const values = buckets.map((b) => b.value);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (v: number) => 100 - ((v - lo) / (hi - lo || 1)) * 100;
  if (buckets.length === 0 || buckets.every((b) => b.count === 0)) return <div className={cn(EMPTY, height)}>{empty ?? "Nothing yet."}</div>;
  return (
    <div>
      <div className="flex gap-2">
        <div className={cn("relative w-14 shrink-0 text-right text-[11px] text-muted", height)}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2 tabular" style={{ top: `${y(t)}%` }}>
              {money(t)}
            </span>
          ))}
        </div>
        <div className={cn("relative flex-1", height)}>
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: `${y(t)}%` }} />
          ))}
          <div className="absolute inset-0 flex items-stretch gap-1 px-1">
            {buckets.map((b) => {
              const top = Math.min(y(b.value), y(0));
              const h = Math.abs(y(b.value) - y(0));
              return (
                <div key={b.key} className="relative flex-1" title={`${b.label}: ${money(b.value)} (${b.count} position${b.count === 1 ? "" : "s"})`}>
                  {b.count > 0 && <div className={cn("absolute inset-x-[12%] rounded-sm", b.value >= 0 ? "bg-up/70" : "bg-down/80")} style={{ top: `${top}%`, height: `${Math.max(h, 0.8)}%` }} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="mt-1 flex gap-2">
        <div className="w-14 shrink-0" />
        <div className="flex flex-1 gap-1 px-1 text-center text-[11px] text-muted">
          {buckets.map((b, i) => (
            <div key={b.key} className="flex-1 truncate">
              {i % labelEvery === 0 ? b.label : ""}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One horizontal bar per row (strategy, symbol), scaled to the biggest. */
export function BarList({ buckets, empty }: { buckets: Bucket[]; empty: string }) {
  if (buckets.length === 0) return <div className={cn(EMPTY, "h-20")}>{empty}</div>;
  const max = Math.max(...buckets.map((b) => Math.abs(b.value)), 1);
  return (
    <div className="space-y-2.5">
      {buckets.map((b) => (
        <div key={b.key} className="flex items-center gap-3 text-xs">
          <div className="w-32 shrink-0 truncate text-right text-muted" title={b.label}>
            {b.label}
          </div>
          <div className="relative h-6 flex-1 rounded bg-surface-2/50">
            <div className={cn("h-full rounded", b.value >= 0 ? "bg-up/70" : "bg-down/80")} style={{ width: `${Math.max((Math.abs(b.value) / max) * 100, 1.5)}%` }} />
          </div>
          <div className={cn("tabular w-20 shrink-0 text-right font-medium", b.value > 0 ? "text-up" : b.value < 0 ? "text-down" : "")}>{money(b.value)}</div>
        </div>
      ))}
    </div>
  );
}

/** A small ring: how much of the whole is filled. */
export function Donut({ fraction, label }: { fraction: number | null; label: string }) {
  const f = fraction == null ? 0 : Math.max(0, Math.min(1, fraction));
  return (
    <svg viewBox="0 0 36 36" className="h-11 w-11 shrink-0" role="img" aria-label={label}>
      <circle cx="18" cy="18" r="14" fill="none" stroke="var(--down)" strokeOpacity={fraction == null ? 0.15 : 0.55} strokeWidth="5" />
      <circle cx="18" cy="18" r="14" fill="none" stroke="var(--up)" strokeWidth="5" strokeDasharray={`${f * 88} 88`} transform="rotate(-90 18 18)" />
    </svg>
  );
}

/** A tiny line for a tile. */
export function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="h-9 w-16 shrink-0" />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(100 - ((v - lo) / (hi - lo || 1)) * 100).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-9 w-16 shrink-0 overflow-visible" aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A tiny set of bars for a tile. */
export function MiniBars({ values }: { values: number[] }) {
  if (values.length === 0) return <div className="h-9 w-16 shrink-0" />;
  const recent = values.slice(-14);
  const max = Math.max(...recent.map(Math.abs), 1);
  return (
    <div className="flex h-9 w-16 shrink-0 items-end gap-px" aria-hidden>
      {recent.map((v, i) => (
        <div key={i} className={cn("flex-1 rounded-sm", v >= 0 ? "bg-up/70" : "bg-down/80")} style={{ height: `${Math.max((Math.abs(v) / max) * 100, 8)}%` }} />
      ))}
    </div>
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** One month at a time: each day shows what ended that day, green or red. */
export function CalendarGrid({ daily }: { daily: DailyPoint[] }) {
  const months = useMemo(() => [...new Set(daily.map((d) => d.dateKey.slice(0, 7)))], [daily]);
  const [shown, setShown] = useState<string | null>(null);
  if (daily.length === 0) return <div className={cn(EMPTY, "h-72")}>No closed positions with a result in this range.</div>;
  const key = shown && months.includes(shown) ? shown : months[months.length - 1];
  const index = months.indexOf(key);
  const [year, month] = key.split("-").map(Number);
  const byDay = new Map(daily.filter((d) => d.dateKey.startsWith(key)).map((d) => [Number(d.dateKey.slice(8)), d]));
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0 = Sunday
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);
  const total = [...byDay.values()].reduce((s, d) => s + d.pl, 0);
  const max = Math.max(...[...byDay.values()].map((d) => Math.abs(d.pl)), 1);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-sm">
        <button aria-label="Previous month" disabled={index <= 0} onClick={() => setShown(months[index - 1])} className="rounded-md border border-line px-2.5 py-1 text-muted hover:text-fg disabled:opacity-30">
          ‹
        </button>
        <div className="font-medium">
          {MONTHS[month - 1]} {year} <span className={cn("ml-2 tabular text-xs", total > 0 ? "text-up" : total < 0 ? "text-down" : "text-muted")}>{money(total)}</span>
        </div>
        <button aria-label="Next month" disabled={index >= months.length - 1} onClick={() => setShown(months[index + 1])} className="rounded-md border border-line px-2.5 py-1 text-muted hover:text-fg disabled:opacity-30">
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d}>{d}</div>
        ))}
        {cells.map((day, i) => {
          const d = day ? byDay.get(day) : undefined;
          return (
            <div
              key={i}
              title={d ? `${key}-${String(day).padStart(2, "0")}: ${money(d.pl)} (${d.count} position${d.count === 1 ? "" : "s"})` : undefined}
              className={cn("flex h-14 flex-col items-center justify-center rounded-md border border-line/60 text-[11px]", !day && "border-transparent")}
              style={d ? { backgroundColor: `color-mix(in srgb, ${d.pl >= 0 ? "var(--up)" : "var(--down)"} ${Math.round(15 + (Math.abs(d.pl) / max) * 45)}%, transparent)` } : undefined}
            >
              {day && <span className="text-faint">{day}</span>}
              {d && <span className="tabular font-medium">{money(d.pl)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
