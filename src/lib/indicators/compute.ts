import { atr } from "./atr";
import { bollinger } from "./bollinger";
import { ema } from "./ema";
import { macd } from "./macd";
import type { ActiveIndicator, PriceSource } from "./registry";
import { rsi } from "./rsi";
import { sma } from "./sma";
import { stochastic } from "./stochastic";
import { supertrend } from "./supertrend";
import type { OHLCV } from "./types";
import { vwap } from "./vwap";
import { wma } from "./wma";

export interface IndicatorLine {
  key: string;
  values: (number | null)[];
  /** Per-point color override (Supertrend flips up/down colors). Falls back to a single `color`. */
  pointColors?: (string | undefined)[];
  color: string;
  lineWidth?: number;
  lineStyle?: "solid" | "dashed";
  kind: "line" | "histogram";
}

export interface ComputedIndicator {
  category: "overlay" | "oscillator";
  lines: IndicatorLine[];
}

function sourceValues(bars: OHLCV[], source: PriceSource = "close"): number[] {
  switch (source) {
    case "open":
      return bars.map((b) => b.o);
    case "high":
      return bars.map((b) => b.h);
    case "low":
      return bars.map((b) => b.l);
    case "hl2":
      return bars.map((b) => (b.h + b.l) / 2);
    default:
      return bars.map((b) => b.c);
  }
}

function toNullable(values: number[]): (number | null)[] {
  return values.map((v) => (Number.isNaN(v) ? null : v));
}

const UP_COLOR = "#089981";
const DOWN_COLOR = "#f23645";

export function computeIndicator(ind: ActiveIndicator, bars: OHLCV[]): ComputedIndicator {
  const s = ind.settings;
  const color = s.color ?? "#2962ff";
  const lineWidth = s.lineWidth ?? 1.5;

  switch (ind.kind) {
    case "sma": {
      const values = sourceValues(bars, s.source);
      return { category: "overlay", lines: [{ key: "value", values: toNullable(sma(values, s.length ?? 20)), color, lineWidth, kind: "line" }] };
    }
    case "ema": {
      const values = sourceValues(bars, s.source);
      return { category: "overlay", lines: [{ key: "value", values: toNullable(ema(values, s.length ?? 20)), color, lineWidth, kind: "line" }] };
    }
    case "wma": {
      const values = sourceValues(bars, s.source);
      return { category: "overlay", lines: [{ key: "value", values: toNullable(wma(values, s.length ?? 20)), color, lineWidth, kind: "line" }] };
    }
    case "bollinger": {
      const values = sourceValues(bars, s.source);
      const { upper, middle, lower } = bollinger(values, s.length ?? 20, s.mult ?? 2);
      return {
        category: "overlay",
        lines: [
          { key: "upper", values: toNullable(upper), color: s.color2 ?? color, lineWidth: 1, lineStyle: "dashed", kind: "line" },
          { key: "middle", values: toNullable(middle), color, lineWidth, kind: "line" },
          { key: "lower", values: toNullable(lower), color: s.color2 ?? color, lineWidth: 1, lineStyle: "dashed", kind: "line" },
        ],
      };
    }
    case "vwap": {
      return { category: "overlay", lines: [{ key: "value", values: toNullable(vwap(bars)), color, lineWidth, kind: "line" }] };
    }
    case "supertrend": {
      const points = supertrend(bars, s.length ?? 10, s.mult ?? 3);
      const values = points.map((p) => (p ? p.value : null));
      const pointColors = points.map((p) => (p ? (p.direction === 1 ? UP_COLOR : DOWN_COLOR) : undefined));
      return { category: "overlay", lines: [{ key: "value", values, pointColors, color: UP_COLOR, lineWidth: lineWidth ?? 2, kind: "line" }] };
    }
    case "rsi": {
      const values = sourceValues(bars, s.source);
      return { category: "oscillator", lines: [{ key: "value", values: toNullable(rsi(values, s.length ?? 14)), color, lineWidth, kind: "line" }] };
    }
    case "macd": {
      const values = sourceValues(bars, s.source);
      const { macd: macdLine, signal, histogram } = macd(values, s.length ?? 12, s.length2 ?? 26, s.length3 ?? 9);
      return {
        category: "oscillator",
        lines: [
          { key: "histogram", values: toNullable(histogram), color, lineWidth, kind: "histogram" },
          { key: "macd", values: toNullable(macdLine), color, lineWidth, kind: "line" },
          { key: "signal", values: toNullable(signal), color: s.color2 ?? "#ff9800", lineWidth, kind: "line" },
        ],
      };
    }
    case "stochastic": {
      const { k, d } = stochastic(bars, s.length ?? 14, s.length2 ?? 3, s.length3 ?? 3);
      return {
        category: "oscillator",
        lines: [
          { key: "k", values: toNullable(k), color, lineWidth, kind: "line" },
          { key: "d", values: toNullable(d), color: s.color2 ?? "#ff9800", lineWidth, kind: "line" },
        ],
      };
    }
    case "atr": {
      return { category: "oscillator", lines: [{ key: "value", values: toNullable(atr(bars, s.length ?? 14)), color, lineWidth, kind: "line" }] };
    }
  }
}
