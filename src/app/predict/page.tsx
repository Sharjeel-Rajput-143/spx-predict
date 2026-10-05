"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useGame } from "@/components/GameProvider";
import { BottomPanel } from "@/components/predict/BottomPanel";
import { ChartPanel } from "@/components/predict/chart/ChartPanel";
import type { LightweightChartHandle } from "@/components/predict/chart/LightweightChart";
import { IndicatorsModal } from "@/components/predict/IndicatorsModal";
import { OnboardingTip } from "@/components/predict/OnboardingTip";
import { OrderTicket } from "@/components/predict/OrderTicket";
import { PredictPanel } from "@/components/predict/PredictPanel";
import { PriceHeader } from "@/components/predict/PriceHeader";
import { RevealBanner, SettlingBanner } from "@/components/predict/Rounds";
import type { SymbolSearchHandle } from "@/components/predict/SymbolSearch";
import { Toolbar } from "@/components/predict/Toolbar";
import { DEFAULT_CHART_PREFS, loadChartPrefs, saveChartPrefs } from "@/lib/chartPrefs";
import { getTicker, TF_MS, TIMEFRAMES, type ChartType, type Timeframe } from "@/lib/config";
import { windowFor } from "@/lib/game";
import { createIndicator, type ActiveIndicator, type IndicatorKind } from "@/lib/indicators/registry";
import { formatOpensIn, getMarketStatus, nextOpenMs } from "@/lib/marketStatus";
import { playSound } from "@/lib/sound";
import { useBars } from "@/hooks/useBars";
import { useNow, usePriceFeed } from "@/hooks/useLive";

export default function PredictPage() {
  const game = useGame();
  const { symbol, setSymbol, pending, placeGuess, stats, results, lastReveal, dismissReveal, settlingIds, hydrated } = game;
  const now = useNow(250);
  const { points, price } = usePriceFeed(symbol);
  const window = windowFor(symbol, now);

  const [prefsHydrated, setPrefsHydrated] = useState(false);
  const [timeframe, setTimeframe] = useState<Timeframe>(DEFAULT_CHART_PREFS.timeframe);
  const [chartType, setChartType] = useState<ChartType>(DEFAULT_CHART_PREFS.chartType);
  const [activeIndicators, setActiveIndicators] = useState<ActiveIndicator[]>(DEFAULT_CHART_PREFS.indicators);
  const [showIndicators, setShowIndicators] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const chartRef = useRef<LightweightChartHandle>(null);
  const symbolSearchRef = useRef<SymbolSearchHandle>(null);

  useEffect(() => {
    const saved = loadChartPrefs();
    setTimeframe(saved.timeframe);
    setChartType(saved.chartType);
    setActiveIndicators(saved.indicators);
    setPrefsHydrated(true);
  }, []);

  useEffect(() => {
    if (!prefsHydrated) return;
    saveChartPrefs({ ...DEFAULT_CHART_PREFS, symbol, timeframe, chartType, indicators: activeIndicators });
  }, [prefsHydrated, symbol, timeframe, chartType, activeIndicators]);

  const handleAddIndicator = (kind: IndicatorKind) => {
    setActiveIndicators((prev) => [...prev, createIndicator(kind)]);
  };
  const handleToggleIndicator = (id: string) => {
    setActiveIndicators((prev) => prev.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i)));
  };
  const handleRemoveIndicator = (id: string) => {
    setActiveIndicators((prev) => prev.filter((i) => i.id !== id));
  };
  const handleUpdateIndicator = (id: string, settings: ActiveIndicator["settings"]) => {
    setActiveIndicators((prev) => prev.map((i) => (i.id === id ? { ...i, settings: { ...i.settings, ...settings } } : i)));
  };

  const ticker = getTicker(symbol);
  const { bars, loading: barsLoading, stale } = useBars(symbol, timeframe);

  const openPrice = useMemo(() => {
    const first = points.find((p) => p.t >= window.startMs);
    return first?.price ?? null;
  }, [points, window.startMs]);

  const current = pending[window.id];
  const showSettling = settlingIds.length > 0 && !lastReveal;
  // Market-hours gating only applies against the live feed - the mock feed
  // is meant to be testable at any hour of the day.
  const isLiveMode = process.env.NEXT_PUBLIC_DATA_SOURCE === "live";
  const marketStatus = isLiveMode ? getMarketStatus(ticker, now) : "open";
  const marketClosed = marketStatus !== "open";
  const predictionDisabled = !hydrated || price == null || stale || marketClosed;

  // Desktop keyboard shortcuts: arrows to predict, 1-9 for timeframes, "/" for symbol search.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;

      if (e.key === "/") {
        e.preventDefault();
        symbolSearchRef.current?.open();
      } else if (e.key >= "1" && e.key <= "9") {
        const tf = TIMEFRAMES[Number(e.key) - 1];
        if (tf) setTimeframe(tf.value);
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !current?.guess && !predictionDisabled) {
        e.preventDefault();
        placeGuess(window, e.key === "ArrowUp" ? "up" : "down");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [current, predictionDisabled, window, placeGuess]);

  const handleLockForClose = () => {
    if (game.soundEnabled) playSound("lock");
  };

  // Everything here depends on the clock, so render only on the client.
  if (!hydrated) return <PredictSkeleton />;

  const predictionWindow = { startMs: window.startMs, endMs: window.endMs, openPrice };

  return (
    <div className="pb-[168px] xl:pb-0">
      <div className={fullscreen ? "fixed inset-0 z-40 flex flex-col gap-3 bg-bg p-3" : "flex flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-6"}>
        <div className="flex flex-col gap-3">
          <Toolbar
            symbol={symbol}
            onSymbolChange={setSymbol}
            timeframe={timeframe}
            onTimeframeChange={setTimeframe}
            chartType={chartType}
            onChartTypeChange={setChartType}
            onOpenIndicators={() => setShowIndicators(true)}
            onReset={() => chartRef.current?.reset()}
            fullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((f) => !f)}
            symbolSearchRef={symbolSearchRef}
          />

          <PriceHeader symbol={symbol} price={price} openPrice={openPrice} />

          {stale && (
            <div className="flex items-center gap-2 rounded-xl border border-down/30 bg-down-soft px-3 py-2 text-sm text-down">
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-down" />
              Reconnecting to live data - predictions are paused until the feed catches up.
            </div>
          )}

          {!stale && marketClosed && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm text-muted">
              <span>
                Market closed, opens in {formatOpensIn(nextOpenMs(now) - now)}.
              </span>
              {ticker.session === "regular" && <span>Try ES1! - it trades almost 24 hours.</span>}
            </div>
          )}

          <div className="overflow-hidden rounded-2xl border border-line bg-surface px-1 pb-1 pt-1">
            <ChartPanel
              ref={chartRef}
              symbol={symbol}
              exchange={ticker.exchange}
              tfLabel={timeframe}
              tfMs={TF_MS[timeframe]}
              bars={bars}
              loading={barsLoading}
              chartType={chartType}
              hasVolume={ticker.hasVolume}
              theme={game.theme}
              predictionWindow={predictionWindow}
              className={fullscreen ? "relative min-h-0 flex-1" : "relative h-[55vh] w-full xl:h-[560px]"}
              activeIndicators={activeIndicators}
              onToggleIndicator={handleToggleIndicator}
              onRemoveIndicator={handleRemoveIndicator}
              onUpdateIndicator={handleUpdateIndicator}
            />
          </div>

          {!fullscreen && (
            <>
              {showSettling && <SettlingBanner />}
              {lastReveal && <RevealBanner result={lastReveal} streak={stats.currentStreak} onDismiss={dismissReveal} />}
              <BottomPanel results={results} />
            </>
          )}
        </div>

        {!fullscreen && (
          <aside className="hidden xl:block">
            <OrderTicket
              window={window}
              now={now}
              guess={current?.guess ?? null}
              openPrice={openPrice}
              price={price}
              disabled={predictionDisabled}
              onGuess={(d) => placeGuess(window, d)}
              stats={stats}
            />
          </aside>
        )}
      </div>

      {/* Mobile: Up/Down always one tap away, pinned above the bottom tab bar. */}
      {!fullscreen && (
        <div
          className="fixed inset-x-0 z-30 border-t border-line bg-surface px-4 pb-3 pt-3 xl:hidden"
          style={{ bottom: "calc(64px + env(safe-area-inset-bottom))" }}
        >
          <PredictPanel
            window={window}
            now={now}
            guess={current?.guess ?? null}
            openPrice={openPrice}
            price={price}
            disabled={predictionDisabled}
            onGuess={(d) => placeGuess(window, d)}
            onLockForClose={handleLockForClose}
          />
        </div>
      )}

      <OnboardingTip />

      {showIndicators && (
        <IndicatorsModal hasVolume={ticker.hasVolume} onAdd={handleAddIndicator} onClose={() => setShowIndicators(false)} />
      )}
    </div>
  );
}

function PredictSkeleton() {
  return (
    <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-6" aria-busy>
      <div className="space-y-4">
        <div className="h-16 w-full animate-pulse rounded-2xl bg-surface-2" />
        <div className="h-16 w-56 animate-pulse rounded-xl bg-surface-2" />
        <div className="h-[400px] animate-pulse rounded-2xl bg-surface-2" />
        <div className="h-64 animate-pulse rounded-2xl bg-surface-2" />
      </div>
      <div className="h-80 animate-pulse rounded-2xl bg-surface-2" />
    </div>
  );
}
