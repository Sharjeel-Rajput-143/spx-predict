"use client";

import { useEffect, useRef, useState } from "react";
import { TICKERS, getTicker } from "@/lib/config";
import { cn, formatChange, formatPct, formatPrice } from "@/lib/format";
import { useNow } from "@/hooks/useLive";
import { formatOpensIn, getMarketStatus, nextOpenMs, type MarketStatus } from "@/lib/marketStatus";

const STATUS_LABEL: Record<MarketStatus, string> = {
  open: "OPEN",
  pre: "PRE-MARKET",
  after: "AFTER HOURS",
  closed: "CLOSED",
};

export function MarketStatusBadge({ symbol }: { symbol: string }) {
  const now = useNow(30_000);
  const ticker = getTicker(symbol);
  // Market-hours status only means anything against the live feed - the
  // mock feed runs around the clock, so it always reads as "OPEN".
  const isLiveMode = process.env.NEXT_PUBLIC_DATA_SOURCE === "live";
  const status = isLiveMode ? getMarketStatus(ticker, now) : "open";

  if (status === "open") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-up">
        <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-up" />
        {STATUS_LABEL.open}
      </span>
    );
  }

  const dotColor = status === "closed" ? "bg-down" : "bg-accent";
  const textColor = status === "closed" ? "text-down" : "text-accent";
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", textColor)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", dotColor)} />
      {STATUS_LABEL[status]}
      {status === "closed" && <span className="text-faint">· opens in {formatOpensIn(nextOpenMs(now) - now)}</span>}
    </span>
  );
}

export function TickerTabs({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
      {TICKERS.map((t) => (
        <button
          key={t.symbol}
          onClick={() => onChange(t.symbol)}
          className={cn(
            "shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors",
            value === t.symbol
              ? "border-fg bg-fg text-bg"
              : "border-line text-muted hover:border-faint hover:text-fg",
          )}
        >
          {t.symbol}
        </button>
      ))}
    </div>
  );
}

export function PriceHeader({
  symbol,
  price,
  openPrice,
}: {
  symbol: string;
  price: number | null;
  openPrice: number | null;
}) {
  const ticker = getTicker(symbol);
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState<"" | "flash-up" | "flash-down">("");
  const [flashKey, setFlashKey] = useState(0);

  useEffect(() => {
    if (price == null) return;
    if (prev.current != null && price !== prev.current) {
      setFlash(price > prev.current ? "flash-up" : "flash-down");
      setFlashKey((k) => k + 1);
    }
    prev.current = price;
  }, [price]);

  const change = price != null && openPrice != null ? price - openPrice : null;
  const dir = change == null ? 0 : Math.sign(change);

  return (
    <div>
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className="font-semibold text-fg">{ticker.symbol}</span>
        <span>{ticker.name}</span>
        <span className="ml-auto">
          <MarketStatusBadge symbol={symbol} />
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span key={flashKey} className={cn("tabular text-4xl font-bold tracking-tight md:text-5xl", flash)}>
          {price == null ? "—" : formatPrice(price)}
        </span>
        {change != null && openPrice != null && (
          <span
            className={cn(
              "tabular text-sm font-semibold",
              dir > 0 ? "text-up" : dir < 0 ? "text-down" : "text-muted",
            )}
          >
            {formatChange(change)} ({dir > 0 ? "+" : dir < 0 ? "−" : ""}
            {formatPct(Math.abs(change) / openPrice, 3)})
            <span className="ml-1.5 font-normal text-faint">this candle</span>
          </span>
        )}
      </div>
    </div>
  );
}
