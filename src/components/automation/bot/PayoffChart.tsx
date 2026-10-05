"use client";

import { useId, useState } from "react";
import { breakeven, maxLoss, maxProfit, payoffAt, priceRange, type Spread } from "@/lib/automation/payoff";
import { niceTicks } from "./chartScale";
import { num, plText } from "./model";

/**
 * Profit or loss at expiry across the underlying's price: green above zero,
 * red below, a dashed line at breakeven, and a pill showing where the
 * underlying is now. It is exact arithmetic from the strikes and the credit
 * (see lib/automation/payoff.ts) - no option prices involved.
 */
export function PayoffChart({ spread, underlying, underlyingLabel = "SPX" }: { spread: Spread; underlying: number | null; underlyingLabel?: string }) {
  const clipId = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);

  const { lo, hi } = priceRange(spread, underlying);
  const profit = maxProfit(spread);
  const loss = maxLoss(spread);
  const ticks = niceTicks(-loss * 1.15, profit * 1.15);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];

  const x = (price: number) => ((price - lo) / (hi - lo)) * 100;
  const y = (pl: number) => 100 - ((pl - yMin) / (yMax - yMin)) * 100;
  const zeroY = y(0);

  // The payoff is piecewise linear with kinks at the two strikes, so four points are exact.
  const kinks = [lo, Math.min(spread.shortStrike, spread.longStrike), Math.max(spread.shortStrike, spread.longStrike), hi];
  const line = kinks.map((p) => `${x(p).toFixed(3)},${y(payoffAt(spread, p)).toFixed(3)}`);
  const path = `M${line.join(" L")}`;
  const area = `M${x(lo).toFixed(3)},${zeroY.toFixed(3)} L${line.join(" L")} L${x(hi).toFixed(3)},${zeroY.toFixed(3)} Z`;

  const be = breakeven(spread);
  const hoverPrice = hover != null ? lo + hover * (hi - lo) : null;
  const strikeLabels = [...new Set([spread.longStrike, spread.shortStrike])].sort((a, b) => a - b);

  return (
    <div>
      <div className="relative mb-1 h-6" aria-hidden={underlying == null}>
        {underlying != null && (
          <span
            className="tabular absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold text-white"
            style={{ left: `calc(3.5rem + (100% - 3.5rem) * ${x(underlying) / 100})` }}
            title={`${underlyingLabel} now`}
          >
            {num(underlying)}
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <div className="relative h-56 w-12 shrink-0 text-right text-[11px] text-faint">
          {ticks.map((t) => (
            <span key={t} className="tabular absolute right-0 -translate-y-1/2" style={{ top: `${y(t)}%` }}>
              {plText(t)}
            </span>
          ))}
        </div>

        <div
          className="relative h-56 flex-1"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
          }}
        >
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: `${y(t)}%` }} />
          ))}
          <div className="absolute inset-x-0 border-t border-fg/30" style={{ top: `${zeroY}%` }} />

          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" role="img" aria-label="Profit and loss at expiry">
            <defs>
              <clipPath id={`${clipId}-up`}>
                <rect x="0" y="0" width="100" height={Math.max(0, zeroY)} />
              </clipPath>
              <clipPath id={`${clipId}-down`}>
                <rect x="0" y={zeroY} width="100" height={Math.max(0, 100 - zeroY)} />
              </clipPath>
            </defs>
            <path d={area} fill="var(--up)" opacity={0.22} clipPath={`url(#${clipId}-up)`} />
            <path d={area} fill="var(--down)" opacity={0.22} clipPath={`url(#${clipId}-down)`} />
            <path d={path} fill="none" stroke="var(--text)" strokeOpacity={0.85} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>

          <div className="absolute inset-y-0 border-l border-dashed border-fg/60" style={{ left: `${x(be)}%` }} />
          <span className="tabular absolute -translate-x-1/2 whitespace-nowrap rounded bg-surface px-1 text-[10px] font-medium text-muted" style={{ left: `${x(be)}%`, bottom: 2 }}>
            BE {num(be)}
          </span>

          {hover != null && hoverPrice != null && (
            <>
              <div className="pointer-events-none absolute inset-y-0 w-px bg-fg/30" style={{ left: `${hover * 100}%` }} />
              <div
                className="tabular pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded-lg border border-line bg-surface px-2 py-1 text-xs shadow-lg"
                style={{ left: `${hover * 100}%`, transform: hover > 0.65 ? "translateX(-105%)" : "translateX(8px)" }}
              >
                <span className="text-muted">{num(hoverPrice)}</span>{" "}
                <span className={payoffAt(spread, hoverPrice) >= 0 ? "font-semibold text-up" : "font-semibold text-down"}>{plText(payoffAt(spread, hoverPrice))}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="relative ml-14 mt-1 h-4 text-[11px] text-faint">
        {strikeLabels.map((k) => (
          <span key={k} className="tabular absolute -translate-x-1/2" style={{ left: `${x(k)}%` }}>
            {num(k)}
          </span>
        ))}
      </div>
    </div>
  );
}
