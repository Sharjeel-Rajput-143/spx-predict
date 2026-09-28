"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TF_MS, type Timeframe } from "@/lib/config";
import { getMarketDataFeed } from "@/lib/marketData";
import type { Bar } from "@/lib/marketData/types";

const HISTORY_BARS = 260;
const STALE_AFTER_MS = 5000;

/** Historical + live-streamed OHLC bars for one symbol at one view timeframe. */
export function useBars(symbol: string, tf: Timeframe) {
  const feed = useMemo(() => getMarketDataFeed(symbol), [symbol]);
  const [bars, setBars] = useState<Bar[]>([]);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const lastTickAtRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    setLoading(true);
    setBars([]);
    setStale(false);
    lastTickAtRef.current = Date.now();

    const now = Date.now();
    const tfMs = TF_MS[tf];
    const from = now - tfMs * HISTORY_BARS;

    feed.getBars(symbol, tf, from, now).then((history) => {
      if (cancelled) return;
      setBars(history);
      setLoading(false);
      unsub = feed.subscribeBars(symbol, tf, (bar) => {
        lastTickAtRef.current = Date.now();
        setBars((prev) => {
          if (prev.length && prev[prev.length - 1].t === bar.t) {
            const next = prev.slice(0, -1);
            next.push(bar);
            return next;
          }
          return [...prev, bar];
        });
      });
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [symbol, tf, feed]);

  // Feed-health guard (spec 4.8): flag it stale if no tick has arrived
  // recently, independent of whether the market itself is open - a closed
  // market still ticks (with an unchanged price); a broken feed goes silent.
  useEffect(() => {
    const id = setInterval(() => {
      setStale(Date.now() - lastTickAtRef.current > STALE_AFTER_MS);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return { bars, loading, stale };
}
