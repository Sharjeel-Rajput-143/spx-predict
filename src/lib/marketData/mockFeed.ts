import { TF_MS, TICK_MS, getTicker, type Timeframe } from "../config";
import { mockPriceAt, mockVolumeAt } from "../mock/priceModel";
import type { Bar, MarketDataFeed } from "./types";

/** At least ~12 samples per bar so OHLC has a believable high/low, capped by tick resolution. */
function sampleStepFor(tfMs: number) {
  return Math.max(TICK_MS * 2, Math.min(tfMs, Math.round(tfMs / 12)));
}

function buildBar(symbol: string, barStart: number, barEnd: number, hasVolume: boolean): Bar {
  const step = sampleStepFor(barEnd - barStart);
  const o = mockPriceAt(symbol, barStart);
  let hi = o;
  let lo = o;
  let c = o;
  for (let t = barStart + step; t < barEnd; t += step) {
    const p = mockPriceAt(symbol, t);
    if (p > hi) hi = p;
    if (p < lo) lo = p;
    c = p;
  }
  const close = mockPriceAt(symbol, Math.max(barStart, barEnd - 1));
  if (close > hi) hi = close;
  if (close < lo) lo = close;
  c = close;
  const bar: Bar = { t: barStart, o, h: hi, l: lo, c };
  if (hasVolume) bar.v = mockVolumeAt(symbol, barStart, barEnd - barStart);
  return bar;
}

export function mockBars(symbol: string, tf: Timeframe, fromMs: number, toMs: number): Bar[] {
  const tfMs = TF_MS[tf];
  const hasVolume = getTicker(symbol).hasVolume;
  const start = Math.floor(fromMs / tfMs) * tfMs;
  const end = Math.ceil(toMs / tfMs) * tfMs;
  const bars: Bar[] = [];
  for (let t = start; t < end; t += tfMs) {
    bars.push(buildBar(symbol, t, t + tfMs, hasVolume));
  }
  return bars;
}

export const mockMarketDataFeed: MarketDataFeed = {
  async getBars(symbol, tf, fromMs, toMs) {
    return mockBars(symbol, tf, fromMs, toMs);
  },

  subscribeBars(symbol, tf, onBar) {
    const tfMs = TF_MS[tf];
    const hasVolume = getTicker(symbol).hasVolume;
    let barStart = Math.floor(Date.now() / tfMs) * tfMs;
    let o = mockPriceAt(symbol, barStart);
    let bar: Bar = { t: barStart, o, h: o, l: o, c: o, v: hasVolume ? 0 : undefined };

    const tick = () => {
      const now = Date.now();
      if (now >= barStart + tfMs) {
        onBar({ ...bar }, true);
        barStart = Math.floor(now / tfMs) * tfMs;
        o = mockPriceAt(symbol, barStart);
        bar = { t: barStart, o, h: o, l: o, c: o, v: hasVolume ? 0 : undefined };
      }
      const p = mockPriceAt(symbol, now);
      bar = {
        ...bar,
        h: Math.max(bar.h, p),
        l: Math.min(bar.l, p),
        c: p,
        v: hasVolume ? mockVolumeAt(symbol, barStart, now - barStart) : undefined,
      };
      onBar({ ...bar }, false);
    };

    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  },
};
