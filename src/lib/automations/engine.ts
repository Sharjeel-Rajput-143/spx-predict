import { computeIndicator } from "../indicators/compute";
import type { Bar } from "../marketData/types";
import { evaluateCondition } from "./conditions";
import type { AlertRule, RuleOperand } from "./types";

/** The same computeIndicator() the chart's indicator overlays use, so a rule
 * evaluates against exactly the values the user would see on their own chart. */
function operandSeries(op: RuleOperand, bars: Bar[]): (number | null)[] {
  if (op.mode === "value") return bars.map(() => op.value);
  const computed = computeIndicator({ id: "rule-operand", kind: op.kind, settings: op.settings, visible: true }, bars);
  const line = computed.lines.find((l) => l.key === op.lineKey) ?? computed.lines[0];
  return line.values;
}

export interface EvaluationResult {
  triggered: boolean;
  barTime: number;
  valueA: number;
  valueB: number;
}

/** Evaluates a rule against the two most recent finalized bars (spec 3.2:
 * once per bar close, so we only ever need "the bar that just closed" vs
 * "the one before it" for crossing detection). Returns null when there isn't
 * enough data yet (indicator warm-up, or fewer than 2 bars). */
export function evaluateRule(rule: Pick<AlertRule, "operandA" | "condition" | "operandB">, bars: Bar[]): EvaluationResult | null {
  if (bars.length < 2) return null;

  const seriesA = operandSeries(rule.operandA, bars);
  const seriesB = operandSeries(rule.operandB, bars);
  const i = bars.length - 1;
  const prevA = seriesA[i - 1];
  const currA = seriesA[i];
  const prevB = seriesB[i - 1];
  const currB = seriesB[i];

  if (prevA == null || currA == null || prevB == null || currB == null) return null;
  if ([prevA, currA, prevB, currB].some(Number.isNaN)) return null;

  return {
    triggered: evaluateCondition(rule.condition, { prevA, currA, prevB, currB }),
    barTime: bars[i].t,
    valueA: currA,
    valueB: currB,
  };
}
