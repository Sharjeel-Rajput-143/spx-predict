"use client";

import { useState } from "react";
import { cn } from "@/lib/format";
import { niceTicks } from "./chartScale";

export interface ChartPoint {
  at: number;
  value: number;
}

/** A plain SVG line chart: dashed gridlines, value labels on the right edge,
 * and a hover read-out. The line is stretched to fit but the labels are real
 * HTML, so text never distorts. */
export function LineChart({
  points,
  format,
  empty,
  integer,
}: {
  points: ChartPoint[];
  format: (n: number) => string;
  empty: string;
  /** Counts: keep the axis on whole numbers. */
  integer?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) {
    return <div className="grid h-64 place-items-center rounded-lg bg-surface-2/40 text-sm text-muted">{empty}</div>;
  }

  const values = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), integer);
  const min = ticks[0];
  const max = ticks[ticks.length - 1];
  const y = (v: number) => 100 - ((v - min) / (max - min)) * 100;
  const x = (i: number) => (points.length === 1 ? 50 : (i / (points.length - 1)) * 100);

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(" ");
  const last = points[points.length - 1].value;
  const tone = last >= 0 ? "var(--up)" : "var(--down)";
  const active = hover != null ? points[hover] : null;

  return (
    <div className="flex gap-2">
      <div
        className="relative h-64 flex-1"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left) / rect.width;
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
        }}
      >
        {ticks.map((t) => (
          <div key={t} className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: `${y(t)}%` }} />
        ))}
        <div className="absolute inset-x-0 border-t border-line" style={{ top: `${y(0)}%` }} />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <path d={`${path} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={tone} opacity={0.08} />
          <path d={path} fill="none" stroke={tone} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
        {active && hover != null && (
          <>
            <div className="pointer-events-none absolute inset-y-0 w-px bg-line" style={{ left: `${x(hover)}%` }} />
            <div
              className={cn(
                "pointer-events-none absolute z-10 -translate-y-1/2 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-lg",
                x(hover) > 70 ? "-translate-x-full" : "translate-x-2",
              )}
              style={{ left: `${x(hover)}%`, top: `${Math.min(Math.max(y(active.value), 12), 88)}%` }}
            >
              <div className="tabular font-semibold">{format(active.value)}</div>
              <div className="text-faint">
                {new Date(active.at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </div>
            </div>
          </>
        )}
      </div>
      <div className="relative h-64 w-14 text-right text-[11px] text-faint">
        {ticks.map((t) => (
          <span key={t} className="tabular absolute right-0 -translate-y-1/2" style={{ top: `${y(t)}%` }}>
            {format(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
