import { DEFAULT_CHART_TYPE, DEFAULT_SYMBOL, DEFAULT_TIMEFRAME, type ChartType, type Timeframe } from "./config";
import type { ActiveIndicator } from "./indicators/registry";

const KEY = "spx-predict:chart:v2";

export interface ChartPrefs {
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  indicators: ActiveIndicator[];
  exchangeTime: boolean; // true = exchange (ET), false = local device time
}

export const DEFAULT_CHART_PREFS: ChartPrefs = {
  symbol: DEFAULT_SYMBOL,
  timeframe: DEFAULT_TIMEFRAME,
  chartType: DEFAULT_CHART_TYPE,
  indicators: [],
  exchangeTime: true,
};

export function loadChartPrefs(): ChartPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_CHART_PREFS;
    return { ...DEFAULT_CHART_PREFS, ...(JSON.parse(raw) as Partial<ChartPrefs>) };
  } catch {
    return DEFAULT_CHART_PREFS;
  }
}

export function saveChartPrefs(prefs: ChartPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable, state stays in memory */
  }
}
