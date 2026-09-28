"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useGame } from "@/components/GameProvider";
import { IconAutomation, IconChevron, IconFlame, IconMoon, IconSun, IconTarget } from "@/components/icons";
import { Avatar, Card, Stat } from "@/components/ui";
import { TICKERS } from "@/lib/config";
import { cn, formatDate, formatPct } from "@/lib/format";

export default function ProfilePage() {
  const { profile, setUsername, stats, results, theme, toggleTheme, resetDemo, hydrated } = useGame();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile.username);

  const byTicker = useMemo(
    () =>
      TICKERS.map((t) => {
        const rs = results.filter((r) => r.symbol === t.symbol);
        const w = rs.filter((r) => r.correct).length;
        return { symbol: t.symbol, total: rs.length, rate: rs.length ? w / rs.length : 0 };
      }).filter((x) => x.total > 0),
    [results],
  );

  const upCalls = results.filter((r) => r.guess === "up");
  const downCalls = results.filter((r) => r.guess === "down");
  const rate = (rs: typeof results) => (rs.length ? rs.filter((r) => r.correct).length / rs.length : 0);
  const recent = results.slice(0, 20).reverse();

  const save = () => {
    const name = draft.trim().replace(/\s+/g, "_").slice(0, 20);
    if (name) setUsername(name);
    setEditing(false);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card className="p-5">
        <div className="flex items-center gap-4">
          <Avatar name={profile.username} hue={profile.avatarHue} size={64} />
          <div className="min-w-0 flex-1">
            {editing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  save();
                }}
                className="flex gap-2"
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={20}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-lg font-semibold outline-none focus:border-accent"
                  aria-label="Username"
                />
                <button className="rounded-lg bg-fg px-3 text-sm font-semibold text-bg">Save</button>
              </form>
            ) : (
              <div className="flex items-center gap-2">
                <h1 className="truncate text-xl font-bold tracking-tight">@{profile.username}</h1>
                <button
                  onClick={() => {
                    setDraft(profile.username);
                    setEditing(true);
                  }}
                  className="text-xs font-medium text-accent"
                >
                  Edit
                </button>
              </div>
            )}
            <p className="mt-0.5 text-sm text-muted">Trading since {hydrated ? formatDate(profile.joinedAt) : ""}</p>
          </div>
        </div>

        {recent.length > 0 && (
          <div className="mt-5">
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">Last {recent.length} calls</div>
            <div className="flex gap-1">
              {recent.map((r) => (
                <span
                  key={r.id}
                  title={`${r.symbol} ${r.correct ? "win" : "loss"}`}
                  className={cn("h-6 flex-1 rounded-sm", r.correct ? "bg-up" : "bg-down/70")}
                />
              ))}
            </div>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Predictions" value={stats.totalPredictions} />
        <Stat label="Win rate" icon={<IconTarget width={12} height={12} />} value={formatPct(stats.winRate)} hint={`${stats.wins} wins`} />
        <Stat label="Longest streak" icon={<IconFlame width={12} height={12} className="text-[#ff9f43]" />} value={stats.longestStreak} />
        <Stat label="Current streak" value={stats.currentStreak} />
      </div>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">Accuracy breakdown</h2>
        <div className="space-y-3">
          <Bar label="Up calls" count={upCalls.length} rate={rate(upCalls)} tone="up" />
          <Bar label="Down calls" count={downCalls.length} rate={rate(downCalls)} tone="down" />
          <div className="h-px bg-line" />
          {byTicker.map((t) => (
            <Bar key={t.symbol} label={t.symbol} count={t.total} rate={t.rate} tone="neutral" />
          ))}
        </div>
      </Card>

      <Card className="divide-y divide-line">
        <Link href="/automations" className="flex w-full items-center justify-between px-4 py-3.5 text-sm">
          <span className="inline-flex items-center gap-1.5">
            <IconAutomation width={16} height={16} className="text-muted" />
            Automations
          </span>
          <IconChevron width={14} height={14} className="-rotate-90 text-faint" />
        </Link>
        <button onClick={toggleTheme} className="flex w-full items-center justify-between px-4 py-3.5 text-sm">
          <span>Appearance</span>
          <span className="inline-flex items-center gap-1.5 text-muted">
            {theme === "dark" ? <IconMoon width={16} height={16} /> : <IconSun width={16} height={16} />}
            {theme === "dark" ? "Dark" : "Light"}
          </span>
        </button>
        <button
          onClick={() => confirm("Reset your demo history and stats?") && resetDemo()}
          className="flex w-full items-center justify-between px-4 py-3.5 text-sm text-down"
        >
          Reset demo data
        </button>
      </Card>
    </div>
  );
}

function Bar({ label, count, rate, tone }: { label: string; count: number; rate: number; tone: "up" | "down" | "neutral" }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular text-muted">
          <span className="font-semibold text-fg">{formatPct(rate, 0)}</span> · {count}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn("h-full rounded-full", tone === "up" ? "bg-up" : tone === "down" ? "bg-down" : "bg-fg/60")}
          style={{ width: `${rate * 100}%` }}
        />
      </div>
    </div>
  );
}
