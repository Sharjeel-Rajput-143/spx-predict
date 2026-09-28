"use client";

import { forwardRef, useState } from "react";
import type { ChartType } from "@/lib/config";
import type { ActiveIndicator } from "@/lib/indicators/registry";
import type { Bar } from "@/lib/marketData/types";
import { ChartLegend } from "./ChartLegend";
import { IndicatorLegend } from "./IndicatorLegend";
import { LightweightChart, type LegendData, type LightweightChartHandle } from "./LightweightChart";

interface Props {
  symbol: string;
  exchange: string;
  tfLabel: string;
  tfMs: number;
  bars: Bar[];
  loading: boolean;
  chartType: ChartType;
  hasVolume: boolean;
  theme: "dark" | "light";
  predictionWindow: { startMs: number; endMs: number; openPrice: number | null } | null;
  priceDecimals?: number;
  className?: string;
  activeIndicators: ActiveIndicator[];
  onToggleIndicator: (id: string) => void;
  onRemoveIndicator: (id: string) => void;
  onUpdateIndicator: (id: string, settings: ActiveIndicator["settings"]) => void;
}

export const ChartPanel = forwardRef<LightweightChartHandle, Props>(function ChartPanel(
  {
    symbol,
    exchange,
    tfLabel,
    tfMs,
    bars,
    loading,
    chartType,
    hasVolume,
    theme,
    predictionWindow,
    priceDecimals,
    className,
    activeIndicators,
    onToggleIndicator,
    onRemoveIndicator,
    onUpdateIndicator,
  },
  ref,
) {
  const [legend, setLegend] = useState<LegendData | null>(null);
  const [indicatorValues, setIndicatorValues] = useState<Record<string, string>>({});

  return (
    <div className={className ?? "relative h-[190px] w-full"}>
      {loading ? (
        <div className="absolute inset-0 animate-pulse rounded-xl bg-surface-2/60" />
      ) : bars.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center text-sm text-faint">No price data yet.</div>
      ) : (
        <>
          <ChartLegend symbol={symbol} exchange={exchange} tfLabel={tfLabel} legend={legend} decimals={priceDecimals} />
          <IndicatorLegend
            indicators={activeIndicators}
            values={indicatorValues}
            onToggle={onToggleIndicator}
            onRemove={onRemoveIndicator}
            onUpdate={onUpdateIndicator}
          />
          <LightweightChart
            ref={ref}
            bars={bars}
            chartType={chartType}
            hasVolume={hasVolume}
            theme={theme}
            tfMs={tfMs}
            predictionWindow={predictionWindow}
            priceDecimals={priceDecimals}
            activeIndicators={activeIndicators}
            onLegendChange={setLegend}
            onIndicatorValuesChange={setIndicatorValues}
          />
        </>
      )}
    </div>
  );
});
