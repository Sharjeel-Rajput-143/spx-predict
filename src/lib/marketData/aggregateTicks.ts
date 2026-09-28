import type { Tick } from "./tickStore";
import type { Bar } from "./types";

/** Buckets raw ticks into OHLC bars aligned to `tfMs`. Bars with no ticks are skipped. */
export function aggregateTicksToBars(ticks: Tick[], tfMs: number): Bar[] {
  const bars: Bar[] = [];
  let current: Bar | null = null;

  for (const tick of ticks) {
    const barStart = Math.floor(tick.t / tfMs) * tfMs;
    if (!current || current.t !== barStart) {
      current = { t: barStart, o: tick.price, h: tick.price, l: tick.price, c: tick.price };
      bars.push(current);
    } else {
      current.h = Math.max(current.h, tick.price);
      current.l = Math.min(current.l, tick.price);
      current.c = tick.price;
    }
  }

  return bars;
}
