import { INDICATOR_DEFS } from "../indicators/registry";
import type { AlertRule, RuleOperand } from "./types";

const CONDITION_LABEL: Record<AlertRule["condition"], string> = {
  crossing_up: "crossing up",
  crossing_down: "crossing down",
  greater_than: "greater than",
  less_than: "less than",
  crosses_value: "crossing",
};

function describeOperand(op: RuleOperand): string {
  if (op.mode === "value") return String(op.value);
  const def = INDICATOR_DEFS[op.kind];
  const params = def.params
    .map((p) => op.settings[p.key])
    .filter((v) => v != null)
    .join(",");
  const base = params ? `${def.label}(${params})` : def.label;
  return op.lineKey && op.lineKey !== "value" ? `${base} ${op.lineKey}` : base;
}

/** e.g. "EMA(9) crossing up EMA(20) on SPX 5m" - used in the rules list and webhook payloads. */
export function describeRule(rule: Pick<AlertRule, "operandA" | "condition" | "operandB" | "symbol" | "timeframe">): string {
  return `${describeOperand(rule.operandA)} ${CONDITION_LABEL[rule.condition]} ${describeOperand(rule.operandB)} on ${rule.symbol} ${rule.timeframe}`;
}
