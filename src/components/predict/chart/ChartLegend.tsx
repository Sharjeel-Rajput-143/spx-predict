"use client";

import { cn } from "@/lib/format";
import type { LegendData } from "./LightweightChart";

function fmt(n: number, decimals: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function ChartLegend({
  symbol,
  exchange,
  tfLabel,
  legend,
  decimals = 2,
}: {
  symbol: string;
  exchange: string;
  tfLabel: string;
  legend: LegendData | null;
  decimals?: number;
}) {
  const dir = legend ? Math.sign(legend.changeAbs) : 0;
  return (
    <div className="tabular pointer-events-none absolute left-2 right-2 top-2 z-10 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-tight text-muted">
      <span className="font-semibold text-fg">{symbol}</span>
      <span className="text-faint">·</span>
      <span>{tfLabel}</span>
      <span className="text-faint">·</span>
      <span>{exchange}</span>
      {legend && (
        <>
          <span className="ml-1">
            O <span className="text-fg">{fmt(legend.o, decimals)}</span>
          </span>
          <span>
            H <span className="text-fg">{fmt(legend.h, decimals)}</span>
          </span>
          <span>
            L <span className="text-fg">{fmt(legend.l, decimals)}</span>
          </span>
          <span>
            C <span className="text-fg">{fmt(legend.c, decimals)}</span>
          </span>
          <span className={cn("font-medium", dir > 0 ? "text-up" : dir < 0 ? "text-down" : "text-muted")}>
            {dir >= 0 ? "+" : ""}
            {fmt(legend.changeAbs, decimals)} ({dir >= 0 ? "+" : ""}
            {(legend.changePct * 100).toFixed(2)}%)
          </span>
        </>
      )}
      {/* Apache-2.0 license requires either this attribution + link, or the library's own logo (which we disable in favor of this compact credit). */}
      <a
        href="https://www.tradingview.com/lightweight-charts/"
        target="_blank"
        rel="noreferrer"
        className="pointer-events-auto hidden text-faint opacity-70 hover:opacity-100 hover:underline sm:inline"
      >
        · Lightweight Charts™ (Apache 2.0)
      </a>
    </div>
  );
}
