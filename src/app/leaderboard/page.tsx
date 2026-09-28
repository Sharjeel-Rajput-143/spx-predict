"use client";

import { useEffect, useState } from "react";
import { useGame } from "@/components/GameProvider";
import { IconFlame } from "@/components/icons";
import { Avatar, Card, Segmented } from "@/components/ui";
import { cn, formatPct } from "@/lib/format";
import type { LeaderboardEntry, LeaderboardPeriod } from "@/lib/types";

const PERIODS: { value: LeaderboardPeriod; label: string }[] = [
  { value: "day", label: "Today" },
  { value: "week", label: "Week" },
  { value: "all", label: "All time" },
];

type SortKey = "accuracy" | "streak";

export default function LeaderboardPage() {
  const { service, stats, profile, results, hydrated } = useGame();
  const [period, setPeriod] = useState<LeaderboardPeriod>("day");
  const [sort, setSort] = useState<SortKey>("accuracy");
  const [rows, setRows] = useState<LeaderboardEntry[] | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    setRows(null);
    const now = Date.now();
    const since = period === "day" ? now - 86_400_000 : period === "week" ? now - 7 * 86_400_000 : 0;
    const scoped = results.filter((r) => r.endMs >= since);
    const wins = scoped.filter((r) => r.correct).length;
    service
      .getLeaderboard(period, {
        username: profile.username,
        avatarHue: profile.avatarHue,
        accuracy: scoped.length ? wins / scoped.length : 0,
        predictions: scoped.length,
        streak: stats.currentStreak,
      })
      .then((r) => !cancelled && setRows(r));
    return () => {
      cancelled = true;
    };
  }, [period, service, profile, results, stats.currentStreak, hydrated]);

  const sorted = rows
    ? sort === "accuracy"
      ? rows
      : [...rows].sort((a, b) => b.streak - a.streak || b.accuracy - a.accuracy).map((r, i) => ({ ...r, rank: i + 1 }))
    : null;
  const you = sorted?.find((r) => r.isYou);
  const podium = sorted?.slice(0, 3) ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Leaderboard</h1>
        <Segmented options={PERIODS} value={period} onChange={setPeriod} />
      </div>

      {/* Podium */}
      <div className="grid grid-cols-3 items-end gap-2">
        {[1, 0, 2].map((i) => {
          const e = podium[i];
          const tall = i === 0;
          return (
            <Card
              key={i}
              className={cn("flex flex-col items-center px-2 pb-3 text-center", tall ? "pt-5" : "pt-3", !e && "animate-pulse")}
            >
              {e ? (
                <>
                  <div className="relative">
                    <Avatar name={e.username} hue={e.avatarHue} size={tall ? 52 : 42} />
                    <span
                      className={cn(
                        "absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold text-black",
                        i === 0 ? "bg-[#f5c451]" : i === 1 ? "bg-[#c7ccd4]" : "bg-[#d49a6a]",
                      )}
                    >
                      {e.rank}
                    </span>
                  </div>
                  <div className="mt-2 w-full truncate text-sm font-semibold">
                    {e.username}
                    {e.isYou && <span className="text-muted"> (you)</span>}
                  </div>
                  <div className="tabular text-lg font-bold text-up">
                    {sort === "accuracy" ? formatPct(e.accuracy) : e.streak}
                  </div>
                  <div className="tabular text-[11px] text-faint">
                    {sort === "accuracy" ? `${e.predictions} calls` : "streak"}
                  </div>
                </>
              ) : (
                <div className="h-24" />
              )}
            </Card>
          );
        })}
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted">
          <span className="w-7">#</span>
          <span className="flex-1">Trader</span>
          <button
            onClick={() => setSort("accuracy")}
            className={cn("w-20 whitespace-nowrap text-right uppercase", sort === "accuracy" && "text-fg")}
          >
            Accuracy{sort === "accuracy" && " ↓"}
          </button>
          <button
            onClick={() => setSort("streak")}
            className={cn("w-16 whitespace-nowrap text-right uppercase", sort === "streak" && "text-fg")}
          >
            Streak{sort === "streak" && " ↓"}
          </button>
        </div>
        {!sorted ? (
          <ul>
            {Array.from({ length: 8 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="h-8 w-full animate-pulse rounded-lg bg-surface-2" />
              </li>
            ))}
          </ul>
        ) : (
          <ul className="divide-y divide-line">
            {sorted.slice(3).map((e) => (
              <Row key={e.userId} e={e} />
            ))}
          </ul>
        )}
      </Card>

      {you && you.rank > 8 && (
        <div className="sticky bottom-20 xl:bottom-4">
          <Card className="overflow-hidden border-accent/40 shadow-lg shadow-black/20">
            <ul>
              <Row e={you} />
            </ul>
          </Card>
        </div>
      )}

      <p className="text-center text-xs text-faint">
        Ranked by accuracy with a minimum number of calls per period. Streak breaks ties.
      </p>
    </div>
  );
}

function Row({ e }: { e: LeaderboardEntry }) {
  return (
    <li className={cn("flex list-none items-center gap-3 px-4 py-2.5", e.isYou && "bg-accent/10")}>
      <span className="tabular w-7 text-sm font-semibold text-muted">{e.rank}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Avatar name={e.username} hue={e.avatarHue} size={30} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {e.username}
            {e.isYou && <span className="ml-1.5 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent">YOU</span>}
          </div>
          <div className="tabular text-[11px] text-faint">{e.predictions} calls</div>
        </div>
      </div>
      <span className="tabular w-20 text-right text-sm font-semibold">{formatPct(e.accuracy)}</span>
      <span className="tabular inline-flex w-16 items-center justify-end gap-1 text-sm text-muted">
        {e.streak}
        <IconFlame width={12} height={12} className={e.streak >= 5 ? "text-[#ff9f43]" : "text-faint"} />
      </span>
    </li>
  );
}
