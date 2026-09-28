export type IndicatorKind =
  | "sma"
  | "ema"
  | "wma"
  | "bollinger"
  | "vwap"
  | "supertrend"
  | "rsi"
  | "macd"
  | "stochastic"
  | "atr";

export type PriceSource = "close" | "open" | "high" | "low" | "hl2";

export interface IndicatorSettings {
  length?: number;
  length2?: number;
  length3?: number;
  mult?: number;
  source?: PriceSource;
  color?: string;
  color2?: string;
  lineWidth?: number;
}

export interface ActiveIndicator {
  id: string;
  kind: IndicatorKind;
  settings: IndicatorSettings;
  visible: boolean;
}

interface ParamDef {
  key: "length" | "length2" | "length3" | "mult";
  label: string;
  min: number;
  max: number;
  step?: number;
}

export interface IndicatorDef {
  kind: IndicatorKind;
  label: string;
  category: "overlay" | "oscillator";
  requiresVolume?: boolean;
  params: ParamDef[];
  sourceSelectable?: boolean;
  defaultSettings: IndicatorSettings;
  /** Formats the current value(s) for the legend, e.g. "12.34" or "1.2 / 0.8 / 0.4". */
  formatValue: (values: (number | null)[]) => string;
}

const PALETTE = ["#2962ff", "#ff9800", "#ab47bc", "#26a69a", "#ef5350", "#42a5f5", "#8d6e63"];
let paletteCursor = 0;
function nextColor() {
  const c = PALETTE[paletteCursor % PALETTE.length];
  paletteCursor++;
  return c;
}

function fmt(n: number | null, decimals = 2) {
  return n == null || Number.isNaN(n) ? "-" : n.toFixed(decimals);
}

/** The output line keys compute.ts produces for each indicator, in order -
 * used wherever a caller (e.g. an automation rule) needs to pick which
 * specific line to read, such as MACD's signal line vs. the MACD line itself. */
export const INDICATOR_LINE_KEYS: Record<IndicatorKind, { key: string; label: string }[]> = {
  sma: [{ key: "value", label: "Value" }],
  ema: [{ key: "value", label: "Value" }],
  wma: [{ key: "value", label: "Value" }],
  bollinger: [
    { key: "upper", label: "Upper band" },
    { key: "middle", label: "Middle band" },
    { key: "lower", label: "Lower band" },
  ],
  vwap: [{ key: "value", label: "Value" }],
  supertrend: [{ key: "value", label: "Value" }],
  rsi: [{ key: "value", label: "Value" }],
  macd: [
    { key: "macd", label: "MACD line" },
    { key: "signal", label: "Signal line" },
    { key: "histogram", label: "Histogram" },
  ],
  stochastic: [
    { key: "k", label: "%K" },
    { key: "d", label: "%D" },
  ],
  atr: [{ key: "value", label: "Value" }],
};

export const INDICATOR_DEFS: Record<IndicatorKind, IndicatorDef> = {
  sma: {
    kind: "sma",
    label: "SMA",
    category: "overlay",
    params: [{ key: "length", label: "Length", min: 1, max: 500 }],
    sourceSelectable: true,
    defaultSettings: { length: 20, source: "close", lineWidth: 1.5 },
    formatValue: ([v]) => fmt(v),
  },
  ema: {
    kind: "ema",
    label: "EMA",
    category: "overlay",
    params: [{ key: "length", label: "Length", min: 1, max: 500 }],
    sourceSelectable: true,
    defaultSettings: { length: 20, source: "close", lineWidth: 1.5 },
    formatValue: ([v]) => fmt(v),
  },
  wma: {
    kind: "wma",
    label: "WMA",
    category: "overlay",
    params: [{ key: "length", label: "Length", min: 1, max: 500 }],
    sourceSelectable: true,
    defaultSettings: { length: 20, source: "close", lineWidth: 1.5 },
    formatValue: ([v]) => fmt(v),
  },
  bollinger: {
    kind: "bollinger",
    label: "Bollinger Bands",
    category: "overlay",
    params: [
      { key: "length", label: "Length", min: 2, max: 500 },
      { key: "mult", label: "StdDev", min: 0.1, max: 10, step: 0.1 },
    ],
    sourceSelectable: true,
    defaultSettings: { length: 20, mult: 2, source: "close", lineWidth: 1 },
    formatValue: ([u, m, l]) => `${fmt(u)} / ${fmt(m)} / ${fmt(l)}`,
  },
  vwap: {
    kind: "vwap",
    label: "VWAP",
    category: "overlay",
    requiresVolume: true,
    params: [],
    defaultSettings: { lineWidth: 1.5 },
    formatValue: ([v]) => fmt(v),
  },
  supertrend: {
    kind: "supertrend",
    label: "Supertrend",
    category: "overlay",
    params: [
      { key: "length", label: "ATR length", min: 1, max: 100 },
      { key: "mult", label: "Multiplier", min: 0.1, max: 20, step: 0.1 },
    ],
    defaultSettings: { length: 10, mult: 3, lineWidth: 2 },
    formatValue: ([v]) => fmt(v),
  },
  rsi: {
    kind: "rsi",
    label: "RSI",
    category: "oscillator",
    params: [{ key: "length", label: "Length", min: 1, max: 200 }],
    sourceSelectable: true,
    defaultSettings: { length: 14, source: "close", lineWidth: 1.5 },
    formatValue: ([v]) => fmt(v),
  },
  macd: {
    kind: "macd",
    label: "MACD",
    category: "oscillator",
    params: [
      { key: "length", label: "Fast", min: 1, max: 200 },
      { key: "length2", label: "Slow", min: 1, max: 200 },
      { key: "length3", label: "Signal", min: 1, max: 200 },
    ],
    sourceSelectable: true,
    defaultSettings: { length: 12, length2: 26, length3: 9, source: "close", lineWidth: 1.5 },
    formatValue: ([m, s, h]) => `${fmt(m)} / ${fmt(s)} / ${fmt(h)}`,
  },
  stochastic: {
    kind: "stochastic",
    label: "Stochastic",
    category: "oscillator",
    params: [
      { key: "length", label: "%K length", min: 1, max: 200 },
      { key: "length2", label: "%K smoothing", min: 1, max: 50 },
      { key: "length3", label: "%D length", min: 1, max: 50 },
    ],
    defaultSettings: { length: 14, length2: 3, length3: 3, lineWidth: 1.5 },
    formatValue: ([k, d]) => `${fmt(k)} / ${fmt(d)}`,
  },
  atr: {
    kind: "atr",
    label: "ATR",
    category: "oscillator",
    params: [{ key: "length", label: "Length", min: 1, max: 200 }],
    defaultSettings: { length: 14, lineWidth: 1.5 },
    formatValue: ([v]) => fmt(v),
  },
};

export function createIndicator(kind: IndicatorKind): ActiveIndicator {
  const def = INDICATOR_DEFS[kind];
  const settings = { ...def.defaultSettings };
  if (settings.color === undefined && def.params.length >= 0) settings.color = nextColor();
  if (kind === "bollinger") settings.color2 = nextColor();
  if (kind === "stochastic" || kind === "macd") settings.color2 = nextColor();
  return {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    settings,
    visible: true,
  };
}
