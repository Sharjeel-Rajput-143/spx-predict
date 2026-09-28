"use client";

import { IconFlame, IconTarget } from "@/components/icons";
import { formatPct } from "@/lib/format";
import type { Direction, RoundWindow, UserStats } from "@/lib/types";
import { Card, Stat } from "@/components/ui";
import { PredictPanel } from "./PredictPanel";

export function OrderTicket({
  window,
  now,
  guess,
  openPrice,
  price,
  onGuess,
  disabled,
  stats,
  onLockForClose,
}: {
  window: RoundWindow;
  now: number;
  guess: Direction | null;
  openPrice: number | null;
  price: number | null;
  onGuess: (d: Direction) => void;
  disabled?: boolean;
  stats: UserStats;
  onLockForClose?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Card className="p-4">
        <PredictPanel
          window={window}
          now={now}
          guess={guess}
          openPrice={openPrice}
          price={price}
          onGuess={onGuess}
          disabled={disabled}
          onLockForClose={onLockForClose}
        />
      </Card>

      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="Streak"
          icon={<IconFlame width={12} height={12} className="text-[#ff9f43]" />}
          value={stats.currentStreak}
          hint={`Best ${stats.longestStreak}`}
        />
        <Stat
          label="Today"
          icon={<IconTarget width={12} height={12} />}
          value={stats.todayPredictions ? formatPct(stats.todayAccuracy, 0) : "—"}
          hint={`${stats.todayWins}W ${stats.todayPredictions - stats.todayWins}L`}
        />
        <Stat label="All time" value={formatPct(stats.winRate, 0)} hint={`${stats.totalPredictions} calls`} />
      </div>
    </div>
  );
}
