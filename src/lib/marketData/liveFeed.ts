import { TF_MS } from "../config";
import type { Bar, MarketDataFeed } from "./types";

/**
 * Live adapter: bars come from GET /api/bars (server-aggregated from real
 * ticks), and subscribeBars streams raw ticks over SSE and aggregates them
 * into the requested timeframe client-side - the same "one raw tick source,
 * many timeframes" shape as the mock feed, just fed by a real source.
 */
export const liveMarketDataFeed: MarketDataFeed = {
  async getBars(symbol, tf, fromMs, toMs) {
    const params = new URLSearchParams({ symbol, tf, from: String(fromMs), to: String(toMs) });
    const res = await fetch(`/api/bars?${params}`);
    if (!res.ok) return [];
    const { bars } = (await res.json()) as { bars: Bar[] };
    return bars;
  },

  subscribeBars(symbol, tf, onBar) {
    const tfMs = TF_MS[tf];
    let barStart: number | null = null;
    let bar: Bar | null = null;

    const es = new EventSource(`/api/stream?symbol=${encodeURIComponent(symbol)}`);
    es.onmessage = (ev) => {
      const tick = JSON.parse(ev.data) as { t: number; price: number };
      const start = Math.floor(tick.t / tfMs) * tfMs;
      if (barStart !== start) {
        if (bar) onBar(bar, true);
        barStart = start;
        bar = { t: start, o: tick.price, h: tick.price, l: tick.price, c: tick.price };
      } else if (bar) {
        bar.h = Math.max(bar.h, tick.price);
        bar.l = Math.min(bar.l, tick.price);
        bar.c = tick.price;
      }
      if (bar) onBar(bar, false);
    };

    return () => es.close();
  },
};
