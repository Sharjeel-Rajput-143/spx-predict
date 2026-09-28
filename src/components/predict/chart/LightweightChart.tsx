"use client";

/**
 * Chart engine, built on TradingView's Lightweight Charts (Apache License
 * 2.0, https://github.com/tradingview/lightweight-charts). Attribution
 * footnote is rendered in the corner per the library's license.
 */
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineWidth,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ChartType } from "@/lib/config";
import { formatCountdown } from "@/lib/format";
import { computeIndicator } from "@/lib/indicators/compute";
import { INDICATOR_DEFS, type ActiveIndicator } from "@/lib/indicators/registry";
import type { Bar } from "@/lib/marketData/types";
import { PredictionWindowPrimitive } from "./predictionPrimitive";

const PALETTE = {
  dark: {
    bg: "#131722",
    panel: "#1e222d",
    grid: "#2a2e39",
    border: "#2a2e39",
    text: "#d1d4dc",
    muted: "#787b86",
    up: "#089981",
    down: "#f23645",
    accent: "#2962ff",
  },
  light: {
    bg: "#ffffff",
    panel: "#f5f6f8",
    grid: "#e2e5ea",
    border: "#e2e5ea",
    text: "#0e1116",
    muted: "#69717d",
    up: "#089981",
    down: "#f23645",
    accent: "#2962ff",
  },
} as const;

type Palette = { bg: string; panel: string; grid: string; border: string; text: string; muted: string; up: string; down: string; accent: string };

export interface LegendData {
  o: number;
  h: number;
  l: number;
  c: number;
  changeAbs: number;
  changePct: number;
}

export interface LightweightChartHandle {
  reset: () => void;
}

interface Props {
  bars: Bar[];
  chartType: ChartType;
  hasVolume: boolean;
  theme: "dark" | "light";
  tfMs: number;
  predictionWindow: { startMs: number; endMs: number; openPrice: number | null } | null;
  priceDecimals?: number;
  activeIndicators?: ActiveIndicator[];
  onLegendChange?: (legend: LegendData | null) => void;
  onIndicatorValuesChange?: (values: Record<string, string>) => void;
}

function toTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

function toLineWidth(n: number | undefined): LineWidth {
  const r = Math.round(n ?? 1.5);
  return Math.min(4, Math.max(1, r)) as LineWidth;
}

/** Floors the auto-scaled price range so a near-flat market (e.g. after
 * hours, where a real feed can sit within a few cents for minutes) doesn't
 * zoom in so tight the candle collapses into an invisible hairline. */
function withMinRange(original: () => AutoscaleInfo | null, lastPrice: number | undefined): AutoscaleInfo | null {
  const res = original();
  if (!res || !res.priceRange || lastPrice == null) return res;
  const minSpan = Math.max(lastPrice * 0.0006, 0.25);
  const { minValue, maxValue } = res.priceRange;
  if (maxValue - minValue >= minSpan) return res;
  const mid = (minValue + maxValue) / 2;
  return { ...res, priceRange: { minValue: mid - minSpan / 2, maxValue: mid + minSpan / 2 } };
}

function barsToLegend(bars: Bar[], idx: number): LegendData | null {
  const bar = bars[idx];
  if (!bar) return null;
  const prevClose = bars[idx - 1]?.c ?? bar.o;
  const changeAbs = bar.c - prevClose;
  const changePct = prevClose ? changeAbs / prevClose : 0;
  return { o: bar.o, h: bar.h, l: bar.l, c: bar.c, changeAbs, changePct };
}

function volumePoint(b: Bar, colors: Palette) {
  return { time: toTime(b.t), value: b.v ?? 0, color: b.c >= b.o ? `${colors.up}80` : `${colors.down}80` };
}

function barPoint(b: Bar, chartType: ChartType) {
  return chartType === "line" || chartType === "area"
    ? { time: toTime(b.t), value: b.c }
    : { time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c };
}

/** Full reseed - only for the initial load or right after the series itself
 * was recreated (chart type/theme/volume change), never on a live tick. */
function applyData(
  series: ISeriesApi<"Candlestick" | "Bar" | "Line" | "Area">,
  volumeSeries: ISeriesApi<"Histogram"> | null,
  bars: Bar[],
  chartType: ChartType,
  colors: Palette,
) {
  if (bars.length === 0) return;
  series.setData(bars.map((b) => barPoint(b, chartType)) as never);
  if (volumeSeries) volumeSeries.setData(bars.map((b) => volumePoint(b, colors)));
}

/** Live ticks: push just the most recent bar through update(), which either
 * amends the in-progress candle or appends a newly-closed one in place -
 * the smooth path setData() (a full re-layout every call) isn't meant for. */
function updateLastBar(
  series: ISeriesApi<"Candlestick" | "Bar" | "Line" | "Area">,
  volumeSeries: ISeriesApi<"Histogram"> | null,
  bars: Bar[],
  chartType: ChartType,
  colors: Palette,
) {
  const last = bars[bars.length - 1];
  if (!last) return;
  series.update(barPoint(last, chartType) as never);
  if (volumeSeries) volumeSeries.update(volumePoint(last, colors));
}

export const LightweightChart = forwardRef<LightweightChartHandle, Props>(function LightweightChart(
  {
    bars,
    chartType,
    hasVolume,
    theme,
    tfMs,
    predictionWindow,
    priceDecimals = 2,
    activeIndicators = [],
    onLegendChange,
    onIndicatorValuesChange,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<"Candlestick" | "Bar" | "Line" | "Area"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const primitiveRef = useRef<PredictionWindowPrimitive | null>(null);
  const openLineRef = useRef<IPriceLine | null>(null);
  // One series per computed line, in the same order computeIndicator() returns them.
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<"Line" | "Histogram">[]>>(new Map());
  const [countdown, setCountdown] = useState<{ top: number; text: string } | null>(null);

  const colors = PALETTE[theme];
  // The chart-creation effect below runs once; give it a stable way to read
  // the latest bars without stale-closing over the first render's array.
  const barsRef = useRef<Bar[]>(bars);
  barsRef.current = bars;
  // Tracks what's actually been pushed to the current series instance, so
  // the data-update effect can tell "just the tail changed" (update()) apart
  // from "this is a different dataset than what's on screen" (setData()).
  const appliedBarsRef = useRef<Bar[]>([]);

  useImperativeHandle(ref, () => ({
    reset() {
      const chart = chartRef.current;
      const series = mainSeriesRef.current;
      if (!chart || !series) return;
      chart.timeScale().fitContent();
      series.priceScale().applyOptions({ autoScale: true });
    },
  }));

  // Chart lifecycle: created once, destroyed on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: colors.text,
        fontFamily: "var(--font-sans, ui-sans-serif)",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.muted, labelBackgroundColor: colors.panel, style: LineStyle.Dashed },
        horzLine: { color: colors.muted, labelBackgroundColor: colors.panel, style: LineStyle.Dashed },
      },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 8 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      kineticScroll: { touch: true, mouse: false },
    });
    chartRef.current = chart;

    const dblClick = () => {
      chart.timeScale().fitContent();
      mainSeriesRef.current?.priceScale().applyOptions({ autoScale: true });
    };
    container.addEventListener("dblclick", dblClick);

    const onCrosshair = (param: MouseEventParams<Time>) => {
      if (!onLegendChange) return;
      const current = barsRef.current;
      if (param.time == null) {
        onLegendChange(barsToLegend(current, current.length - 1));
        return;
      }
      const t = Math.floor(Number(param.time));
      const idx = current.findIndex((b) => Math.floor(b.t / 1000) === t);
      onLegendChange(idx === -1 ? barsToLegend(current, current.length - 1) : barsToLegend(current, idx));
    };
    chart.subscribeCrosshairMove(onCrosshair);

    return () => {
      container.removeEventListener("dblclick", dblClick);
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      chartRef.current = null;
      mainSeriesRef.current = null;
      volumeSeriesRef.current = null;
      primitiveRef.current = null;
      openLineRef.current = null;
      indicatorSeriesRef.current.clear();
    };
    // Chart is created once; theme/legend updates are applied via effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme updates.
  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: { textColor: colors.text },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      crosshair: {
        vertLine: { color: colors.muted, labelBackgroundColor: colors.panel },
        horzLine: { color: colors.muted, labelBackgroundColor: colors.panel },
      },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border },
    });
  }, [colors]);

  // Series lifecycle: recreated whenever the chart type or volume visibility changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (mainSeriesRef.current) chart.removeSeries(mainSeriesRef.current);
    if (volumeSeriesRef.current) {
      chart.removeSeries(volumeSeriesRef.current);
      volumeSeriesRef.current = null;
    }
    openLineRef.current = null;

    let series: ISeriesApi<"Candlestick" | "Bar" | "Line" | "Area">;
    const priceFormat = { type: "price" as const, precision: priceDecimals, minMove: 1 / 10 ** priceDecimals };
    if (chartType === "candles" || chartType === "hollow") {
      series = chart.addSeries(CandlestickSeries, {
        upColor: chartType === "hollow" ? "transparent" : colors.up,
        downColor: colors.down,
        borderVisible: true,
        borderUpColor: colors.up,
        borderDownColor: colors.down,
        wickUpColor: colors.up,
        wickDownColor: colors.down,
        priceFormat,
      });
    } else if (chartType === "bars") {
      series = chart.addSeries(BarSeries, {
        upColor: colors.up,
        downColor: colors.down,
        thinBars: false,
        priceFormat,
      });
    } else if (chartType === "line") {
      series = chart.addSeries(LineSeries, { color: colors.accent, lineWidth: 2, priceFormat });
    } else {
      series = chart.addSeries(AreaSeries, {
        lineColor: colors.accent,
        topColor: `${colors.accent}33`,
        bottomColor: `${colors.accent}03`,
        lineWidth: 2,
        priceFormat,
      });
    }
    mainSeriesRef.current = series;
    series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: hasVolume ? 0.3 : 0.08 } });
    series.applyOptions({
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => withMinRange(original, barsRef.current[barsRef.current.length - 1]?.c),
    });

    const primitive = new PredictionWindowPrimitive(theme === "dark" ? "rgba(41,98,255,0.06)" : "rgba(41,98,255,0.05)");
    series.attachPrimitive(primitive);
    primitiveRef.current = primitive;

    if (hasVolume) {
      const volSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
      });
      volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volumeSeriesRef.current = volSeries;
    }

    // The series was just (re)created empty - populate it immediately with
    // whatever bars this render already has, rather than waiting for the
    // barsKey effect below (which won't rerun on a theme/type change alone).
    applyData(series, volumeSeriesRef.current, barsRef.current, chartType, colors);
    appliedBarsRef.current = barsRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType, hasVolume, theme]);

  // Data updates as new/updated bars stream in. Most ticks only touch the
  // last bar (amend the in-progress candle, or close it and start a new
  // one) - those go through update() for a smooth, in-place move. A full
  // setData() reseed only happens when the dataset itself is discontinuous
  // from what's already on the series (a symbol/timeframe swap slipping
  // through without a remount, or a bar count that jumped by more than one).
  useEffect(() => {
    const series = mainSeriesRef.current;
    if (!series || bars.length === 0) return;

    const prev = appliedBarsRef.current;
    const isContinuous = prev.length > 0 && prev[0].t === bars[0].t && Math.abs(bars.length - prev.length) <= 1;

    if (isContinuous) {
      updateLastBar(series, volumeSeriesRef.current, bars, chartType, colors);
    } else {
      applyData(series, volumeSeriesRef.current, bars, chartType, colors);
    }
    appliedBarsRef.current = bars;

    onLegendChange?.(barsToLegend(bars, bars.length - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, chartType]);

  // Indicator series lifecycle: create/remove series only when the set of
  // active indicator ids changes (settings/color/visibility are handled by
  // the options+data effect below, without recreating anything).
  const indicatorIdsKey = activeIndicators.map((i) => i.id).join(",");
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const map = indicatorSeriesRef.current;
    const currentIds = new Set(activeIndicators.map((i) => i.id));

    for (const [id, seriesArr] of map) {
      if (currentIds.has(id)) continue;
      seriesArr.forEach((s) => chart.removeSeries(s));
      map.delete(id);
    }

    let nextPane = 1;
    const paneIndexById = new Map<string, number>();
    for (const ind of activeIndicators) {
      if (INDICATOR_DEFS[ind.kind].category === "oscillator") paneIndexById.set(ind.id, nextPane++);
    }

    for (const ind of activeIndicators) {
      if (map.has(ind.id)) continue;
      const computed = computeIndicator(ind, barsRef.current);
      const paneIndex = paneIndexById.get(ind.id) ?? 0;
      const seriesArr = computed.lines.map((line) =>
        line.kind === "histogram"
          ? (chart.addSeries(HistogramSeries, { color: line.color, priceLineVisible: false, lastValueVisible: false }, paneIndex) as ISeriesApi<
              "Line" | "Histogram"
            >)
          : (chart.addSeries(
              LineSeries,
              {
                color: line.color,
                lineWidth: toLineWidth(line.lineWidth),
                lineStyle: line.lineStyle === "dashed" ? LineStyle.Dashed : LineStyle.Solid,
                priceLineVisible: false,
                lastValueVisible: false,
              },
              paneIndex,
            ) as ISeriesApi<"Line" | "Histogram">),
      );
      map.set(ind.id, seriesArr);

      // A couple of oscillators get their conventional reference bands.
      const refSeries = seriesArr[0];
      if (ind.kind === "rsi") {
        [70, 30].forEach((price) =>
          refSeries.createPriceLine({ price, color: colors.muted, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" }),
        );
      } else if (ind.kind === "stochastic") {
        [80, 20].forEach((price) =>
          refSeries.createPriceLine({ price, color: colors.muted, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" }),
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorIdsKey]);

  // Indicator options + data: settings/color/visibility changes and every bar update.
  useEffect(() => {
    if (indicatorSeriesRef.current.size === 0 && activeIndicators.length === 0) return;
    const values: Record<string, string> = {};

    for (const ind of activeIndicators) {
      const seriesArr = indicatorSeriesRef.current.get(ind.id);
      if (!seriesArr) continue;
      const def = INDICATOR_DEFS[ind.kind];
      const computed = computeIndicator(ind, bars);

      computed.lines.forEach((line, i) => {
        const s = seriesArr[i];
        if (!s) return;
        s.applyOptions({ color: line.color, visible: ind.visible, ...(line.kind === "line" ? { lineWidth: toLineWidth(line.lineWidth) } : {}) });

        const points = bars
          .map((b, idx) => ({ time: toTime(b.t), value: line.values[idx], color: line.pointColors?.[idx] }))
          .filter((p): p is { time: UTCTimestamp; value: number; color: string | undefined } => p.value != null);
        s.setData(points.map((p) => ({ time: p.time, value: p.value, color: p.color ?? (line.kind === "histogram" ? line.color : undefined) })));
      });

      const lastValues = computed.lines.map((l) => l.values[l.values.length - 1] ?? null);
      values[ind.id] = def.formatValue(lastValues);
    }

    onIndicatorValuesChange?.(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, activeIndicators]);

  // Prediction window: dashed OPEN line + background highlight.
  useEffect(() => {
    const series = mainSeriesRef.current;
    if (!series) return;

    if (predictionWindow?.openPrice != null) {
      if (openLineRef.current) {
        openLineRef.current.applyOptions({ price: predictionWindow.openPrice });
      } else {
        openLineRef.current = series.createPriceLine({
          price: predictionWindow.openPrice,
          color: colors.muted,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "OPEN",
        });
      }
    } else if (openLineRef.current) {
      series.removePriceLine(openLineRef.current);
      openLineRef.current = null;
    }

    primitiveRef.current?.setRange(
      predictionWindow
        ? { from: toTime(predictionWindow.startMs), to: toTime(predictionWindow.endMs) }
        : null,
    );
    // predictionWindow is a fresh object every render (the caller recomputes
    // it from a live clock) - depending on the object itself would redraw
    // the chart every ~250ms for no reason. Its actual identity only changes
    // when one of these primitives does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [predictionWindow?.startMs, predictionWindow?.endMs, predictionWindow?.openPrice, colors.muted]);

  // Countdown to the current *view* bar's close, positioned under the last-price label.
  useEffect(() => {
    const id = setInterval(() => {
      const series = mainSeriesRef.current;
      const last = bars[bars.length - 1];
      if (!series || !last) {
        setCountdown(null);
        return;
      }
      const y = series.priceToCoordinate(last.c);
      if (y == null) {
        setCountdown(null);
        return;
      }
      const barEnd = Math.ceil((Date.now() + 1) / tfMs) * tfMs;
      setCountdown({ top: y + 16, text: formatCountdown(barEnd - Date.now()) });
    }, 1000);
    return () => clearInterval(id);
  }, [bars, tfMs]);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {countdown && (
        <div
          className="tabular pointer-events-none absolute right-0.5 z-10 rounded-sm px-1 py-0.5 text-[10px] font-medium"
          style={{ top: countdown.top, background: colors.accent, color: "#fff" }}
        >
          {countdown.text}
        </div>
      )}
    </div>
  );
});
