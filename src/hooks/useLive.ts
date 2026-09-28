"use client";

import { useEffect, useState } from "react";
import { CHART_WINDOW_MS } from "@/lib/config";
import type { PricePoint } from "@/lib/types";
import { useGame } from "@/components/GameProvider";

/** Re-renders on an interval and returns the current time. */
export function useNow(intervalMs = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Live price for a symbol: seeded with history, then appended tick by tick. */
export function usePriceFeed(symbol: string) {
  const { service } = useGame();
  const [points, setPoints] = useState<PricePoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    setPoints([]);

    const now = Date.now();
    service.getPriceHistory(symbol, now - CHART_WINDOW_MS, now).then((history) => {
      if (cancelled) return;
      setPoints(history);
      unsub = service.subscribePrice(symbol, (tick) => {
        setPoints((prev) => {
          const cutoff = tick.t - CHART_WINDOW_MS;
          const trimmed = prev.filter((p) => p.t >= cutoff && p.t < tick.t);
          return [...trimmed, tick];
        });
      });
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [symbol, service]);

  const last = points[points.length - 1];
  return { points, price: last?.price ?? null, lastTick: last?.t ?? null };
}
