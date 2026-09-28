"use client";

import Link from "next/link";
import { cn, formatChange, formatPrice, formatTime } from "@/lib/format";
import type { RoundResult } from "@/lib/types";
import { DirectionPill, ResultMark } from "../ui";
import { IconFlame, IconX } from "../icons";

export function RevealBanner({
  result,
  streak,
  onDismiss,
}: {
  result: RoundResult;
  streak: number;
  onDismiss: () => void;
}) {
  const change = result.closePrice - result.openPrice;
  return (
    <div
      role="status"
      className={cn(
        "animate-pop-in relative overflow-hidden rounded-2xl border p-4",
        result.correct ? "border-up/30 bg-up-soft" : "border-down/30 bg-down-soft",
      )}
    >
      <button onClick={onDismiss} aria-label="Dismiss" className="absolute right-3 top-3 text-muted hover:text-fg">
        <IconX width={16} height={16} />
      </button>
      <div className="flex items-center gap-3">
        <ResultMark correct={result.correct} size={40} />
        <div className="min-w-0">
          <div className={cn("text-lg font-bold", result.correct ? "text-up" : "text-down")}>
            {result.correct ? "Called it." : result.outcome === "flat" ? "Flat close. No win." : "Missed this one."}
          </div>
          <div className="text-sm text-muted">
            {result.symbol} closed <DirectionPill dir={result.outcome} />{" "}
            <span className="tabular">
              {formatPrice(result.openPrice)} → {formatPrice(result.closePrice)} ({formatChange(change)})
            </span>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className="text-muted">You called</span>
        <DirectionPill dir={result.guess} />
        <span className="ml-auto inline-flex items-center gap-1 font-semibold">
          {result.correct ? (
            <>
              <IconFlame width={16} height={16} className="text-[#ff9f43]" /> {streak} streak
            </>
          ) : (
            <span className="text-muted">Streak reset</span>
          )}
        </span>
      </div>
    </div>
  );
}

export function SettlingBanner() {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-faint border-t-fg" />
      Candle closed. Confirming the result…
    </div>
  );
}

export function RecentRounds({
  results,
  limit = 6,
  title = "Recent rounds",
  showHeader = true,
}: {
  results: RoundResult[];
  limit?: number;
  title?: string;
  showHeader?: boolean;
}) {
  const rows = results.slice(0, limit);
  return (
    <div>
      {showHeader && (
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Link href="/history" className="text-xs font-medium text-muted hover:text-fg">
            See all
          </Link>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-faint">No rounds yet. Make your first call above.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="animate-pop-in flex items-center gap-3 py-2.5">
              <ResultMark correct={r.correct} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-semibold">{r.symbol}</span>
                  <span className="text-xs text-faint">{formatTime(r.startMs)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 whitespace-nowrap text-xs text-muted">
                  <span className="inline-flex items-center gap-1">Called <DirectionPill dir={r.guess} /></span>
                  <span className="inline-flex items-center gap-1">Closed <DirectionPill dir={r.outcome} /></span>
                </div>
              </div>
              <span
                className={cn(
                  "tabular text-sm font-medium",
                  r.closePrice > r.openPrice ? "text-up" : r.closePrice < r.openPrice ? "text-down" : "text-muted",
                )}
              >
                {formatChange(r.closePrice - r.openPrice)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
