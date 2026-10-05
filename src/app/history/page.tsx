"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useGame } from "@/components/GameProvider";
import { Card, DirectionPill, ResultMark, Segmented } from "@/components/ui";
import { TICKERS } from "@/lib/config";
import { cn, dayLabel, formatChange, formatPct, formatPrice, formatTime } from "@/lib/format";
import type { RoundResult } from "@/lib/types";

type Filter = "all" | "wins" | "losses";

export default function HistoryPage() {
  const { results, pending, stats, hydrated } = useGame();
  const [filter, setFilter] = useState<Filter>("all");
  const [ticker, setTicker] = useState<string>("ALL");

  const filtered = useMemo(
    () =>
      results.filter(
        (r) =>
          (ticker === "ALL" || r.symbol === ticker) &&
          (filter === "all" || (filter === "wins" ? r.correct : !r.correct)),
      ),
    [results, filter, ticker],
  );

  const groups = useMemo(() => {
    const map = new Map<string, RoundResult[]>();
    filtered.forEach((r) => {
      const key = dayLabel(r.endMs);
      map.set(key, [...(map.get(key) ?? []), r]);
    });
    return [...map.entries()];
  }, [filtered]);

  const open = Object.values(pending);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">History</h1>
          <p className="tabular text-sm text-muted">
            {stats.totalPredictions} calls · {formatPct(stats.winRate)} win rate
          </p>
        </div>
        <Segmented
          options={[
            { value: "all", label: "All" },
            { value: "wins", label: "Wins" },
            { value: "losses", label: "Losses" },
          ]}
          value={filter}
          onChange={setFilter}
        />
      </div>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none]">
        {["ALL", ...TICKERS.map((t) => t.symbol)].map((s) => (
          <button
            key={s}
            onClick={() => setTicker(s)}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
              ticker === s ? "border-fg bg-fg text-bg" : "border-line text-muted hover:text-fg",
            )}
          >
            {s === "ALL" ? "All tickers" : s}
          </button>
        ))}
      </div>

      {open.length > 0 && (
        <Card className="p-4">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Open</div>
          {open.map((p) => (
            <div key={p.window.id} className="flex items-center gap-3 text-sm">
              <span className="h-2 w-2 animate-pulse-dot rounded-full bg-accent" />
              <span className="font-semibold">{p.window.symbol}</span>
              <DirectionPill dir={p.guess} />
              <span className="ml-auto text-xs text-muted">Closes {formatTime(p.window.endMs)}</span>
            </div>
          ))}
        </Card>
      )}

      {!hydrated ? (
        <Card className="h-64 animate-pulse" >{null}</Card>
      ) : groups.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-muted">Nothing here yet.</p>
          <Link href="/predict" className="mt-3 inline-block rounded-lg bg-fg px-4 py-2 text-sm font-semibold text-bg">
            Make a call
          </Link>
        </Card>
      ) : (
        groups.map(([day, rows]) => {
          const w = rows.filter((r) => r.correct).length;
          return (
            <section key={day}>
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold">{day}</h2>
                <span className="tabular text-xs text-muted">
                  <span className="text-up">{w}W</span> <span className="text-down">{rows.length - w}L</span>
                </span>
              </div>
              <Card className="overflow-hidden">
                <ul className="divide-y divide-line">
                  {rows.map((r) => (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                      <ResultMark correct={r.correct} size={26} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">{r.symbol}</span>
                          <span className="tabular whitespace-nowrap text-xs text-faint">{formatTime(r.startMs)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 whitespace-nowrap text-xs text-muted">
                          <span className="inline-flex items-center gap-1">Called <DirectionPill dir={r.guess} /></span>
                          <span className="inline-flex items-center gap-1">Closed <DirectionPill dir={r.outcome} /></span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div
                          className={cn(
                            "tabular text-sm font-semibold",
                            r.outcome === "up" ? "text-up" : r.outcome === "down" ? "text-down" : "text-muted",
                          )}
                        >
                          {formatChange(r.closePrice - r.openPrice)}
                        </div>
                        <div className="tabular text-[11px] text-faint">
                          {formatPrice(r.openPrice)} → {formatPrice(r.closePrice)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          );
        })
      )}
    </div>
  );
}
