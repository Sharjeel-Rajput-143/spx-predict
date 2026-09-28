"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CHART_WINDOW_MS } from "@/lib/config";
import { formatPrice } from "@/lib/format";
import type { PricePoint, RoundWindow } from "@/lib/types";

interface Props {
  points: PricePoint[];
  window: RoundWindow;
  now: number;
  openPrice: number | null;
  height?: number;
}

/**
 * Lightweight SVG line chart. The x axis runs to the end of the current
 * window, so the empty space on the right is the time left in the candle.
 */
export function PriceChart({ points, window, now, openPrice, height = 220 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const gradId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const padR = 64; // room for the price labels
  const padY = 16;

  const geom = useMemo(() => {
    if (!width || points.length < 2) return null;
    const x0 = window.endMs - CHART_WINDOW_MS;
    const x1 = window.endMs;
    const visible = points.filter((p) => p.t >= x0);
    const prices = visible.map((p) => p.price);
    if (openPrice != null) prices.push(openPrice);
    let lo = Math.min(...prices);
    let hi = Math.max(...prices);
    const span = Math.max(hi - lo, lo * 0.0004);
    lo -= span * 0.15;
    hi += span * 0.15;

    const plotW = width - padR;
    const sx = (t: number) => ((t - x0) / (x1 - x0)) * plotW;
    const sy = (p: number) => padY + (1 - (p - lo) / (hi - lo)) * (height - padY * 2);

    const line = visible.map((p, i) => `${i ? "L" : "M"}${sx(p.t).toFixed(1)},${sy(p.price).toFixed(1)}`).join("");
    const lastP = visible[visible.length - 1];
    const firstP = visible[0];
    const area = `${line}L${sx(lastP.t).toFixed(1)},${height}L${sx(firstP.t).toFixed(1)},${height}Z`;

    const ticks = [0.2, 0.5, 0.8].map((f) => {
      const price = hi - (hi - lo) * f;
      return { y: sy(price), price };
    });

    return {
      line,
      area,
      last: { x: sx(lastP.t), y: sy(lastP.price), price: lastP.price },
      openY: openPrice != null ? sy(openPrice) : null,
      windowX: sx(window.startMs),
      nowX: sx(Math.min(now, window.endMs)),
      plotW,
      ticks,
    };
  }, [width, points, window, now, openPrice, height]);

  const trendUp = geom && openPrice != null ? geom.last.price >= openPrice : true;
  const stroke = trendUp ? "var(--up)" : "var(--down)";

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {!geom ? (
        <div className="absolute inset-0 animate-pulse rounded-xl bg-surface-2/60" />
      ) : (
        <svg width={width} height={height} className="block overflow-visible" role="img" aria-label="Live price chart">
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>

          {geom.ticks.map((t) => (
            <g key={t.y}>
              <line x1={0} x2={geom.plotW} y1={t.y} y2={t.y} stroke="var(--grid)" />
              <text x={geom.plotW + 8} y={t.y + 4} fontSize={10} fill="var(--faint)" className="tabular">
                {formatPrice(t.price)}
              </text>
            </g>
          ))}

          {/* Current window region */}
          <rect x={geom.windowX} y={0} width={geom.plotW - geom.windowX} height={height} fill="var(--surface-2)" opacity={0.55} />
          <line x1={geom.windowX} x2={geom.windowX} y1={0} y2={height} stroke="var(--border)" strokeDasharray="3 4" />
          {/* Time remaining in candle */}
          <rect x={geom.nowX} y={0} width={Math.max(0, geom.plotW - geom.nowX)} height={height} fill="var(--surface-2)" opacity={0.6} />

          {geom.openY != null && (
            <>
              <line x1={geom.windowX} x2={geom.plotW} y1={geom.openY} y2={geom.openY} stroke="var(--muted)" strokeDasharray="4 4" strokeWidth={1} />
              <text x={geom.windowX + 6} y={geom.openY - 6} fontSize={10} fill="var(--muted)" fontWeight={500}>
                OPEN
              </text>
            </>
          )}

          <path d={geom.area} fill={`url(#${gradId})`} />
          <path d={geom.line} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          <circle cx={geom.last.x} cy={geom.last.y} r={8} fill={stroke} opacity={0.18} className="animate-pulse-dot" />
          <circle cx={geom.last.x} cy={geom.last.y} r={3.5} fill={stroke} />

          <g transform={`translate(${geom.plotW + 4}, ${geom.last.y - 10})`}>
            <rect width={padR - 6} height={20} rx={5} fill={stroke} />
            <text x={(padR - 6) / 2} y={14} fontSize={10.5} fontWeight={600} textAnchor="middle" fill="var(--bg)" className="tabular">
              {formatPrice(geom.last.price)}
            </text>
          </g>
        </svg>
      )}
    </div>
  );
}
