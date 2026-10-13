"use client";

import { useEffect, useState } from "react";
import { LIVE_FEED_SYMBOLS } from "@/lib/marketData/types";
import { TF_MS, TIMEFRAMES, type Timeframe } from "@/lib/config";
import { getMarketDataFeed } from "@/lib/marketData";
import type { Bar } from "@/lib/marketData/types";

const LIVE_MODE = process.env.NEXT_PUBLIC_DATA_SOURCE === "live";

/**
 * Dev-only sanity check (spec 4.7): the last 50 bars for a symbol/timeframe,
 * so they can be compared line by line against TradingView's own chart.
 * Target tolerance is 0.01 index points. Not linked from the app nav.
 */
interface FeedStatus {
  healthy: boolean;
  source: "google" | "yahoo" | "broker" | null;
  consecutiveFailures: number;
  lastTickAt: number | null;
}

export default function FeedCheckPage() {
  const [symbol, setSymbol] = useState<string>(LIVE_FEED_SYMBOLS[0]);
  const [timeframe, setTimeframe] = useState<Timeframe>("1m");
  const [bars, setBars] = useState<Bar[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [status, setStatus] = useState<FeedStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const feed = getMarketDataFeed(symbol);
    const tfMs = TF_MS[timeframe];

    const load = async () => {
      const now = Date.now();
      const history = await feed.getBars(symbol, timeframe, now - tfMs * 50, now);
      if (cancelled) return;
      setBars(history.slice(-50));
      setUpdatedAt(now);
    };

    const loadStatus = async () => {
      if (!LIVE_MODE) return;
      const res = await fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}`);
      const data = await res.json();
      if (!cancelled) setStatus(data);
    };

    load();
    loadStatus();
    const id = setInterval(load, 5000);
    const statusId = setInterval(loadStatus, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearInterval(statusId);
    };
  }, [symbol, timeframe]);

  if (process.env.NODE_ENV === "production") {
    return <div className="p-6 text-sm text-muted">/dev/feed-check is not available in production.</div>;
  }

  return (
    <div className="min-h-dvh bg-bg p-6 text-fg">
      <h1 className="text-lg font-semibold">Feed check</h1>
      <p className="mt-1 text-sm text-muted">
        Data source: <b className="tabular">{LIVE_MODE ? "live (Google Finance, Yahoo Finance fallback)" : "mock"}</b>
        {!LIVE_MODE && " - set NEXT_PUBLIC_DATA_SOURCE=live to check the real feed."}
      </p>

      {LIVE_MODE && status && (
        <p className="mt-1 text-sm text-muted">
          Feed health:{" "}
          <b className={status.healthy ? "text-up" : "text-down"}>{status.healthy ? "healthy" : "down"}</b>
          {status.source && (
            <>
              {" "}
              via <b className="tabular">{status.source}</b>
            </>
          )}
          {status.consecutiveFailures > 0 && (
            <span className="text-down"> ({status.consecutiveFailures} consecutive failures, backing off)</span>
          )}
          {status.lastTickAt && <span className="text-faint"> - last tick {new Date(status.lastTickAt).toLocaleTimeString()}</span>}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm"
        >
          {LIVE_FEED_SYMBOLS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={timeframe}
          onChange={(e) => setTimeframe(e.target.value as Timeframe)}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm"
        >
          {TIMEFRAMES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {updatedAt && <span className="self-center text-xs text-faint">Updated {new Date(updatedAt).toLocaleTimeString()}</span>}
      </div>

      <table className="tabular mt-4 w-full max-w-2xl border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-1.5 pr-4">Time</th>
            <th className="py-1.5 pr-4">Open</th>
            <th className="py-1.5 pr-4">High</th>
            <th className="py-1.5 pr-4">Low</th>
            <th className="py-1.5 pr-4">Close</th>
          </tr>
        </thead>
        <tbody>
          {bars.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-faint">
                No bars yet{LIVE_MODE ? " - waiting on the poller (~3s cadence)." : "."}
              </td>
            </tr>
          )}
          {bars
            .slice()
            .reverse()
            .map((b) => (
              <tr key={b.t} className="border-b border-line/50">
                <td className="py-1 pr-4">{new Date(b.t).toLocaleString()}</td>
                <td className="py-1 pr-4">{b.o.toFixed(2)}</td>
                <td className="py-1 pr-4">{b.h.toFixed(2)}</td>
                <td className="py-1 pr-4">{b.l.toFixed(2)}</td>
                <td className="py-1 pr-4">{b.c.toFixed(2)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
