export type ConditionType = "crossing_up" | "crossing_down" | "greater_than" | "less_than" | "crosses_value";

export interface ConditionInput {
  prevA: number;
  currA: number;
  prevB: number;
  currB: number;
}

/**
 * All five TradingView-style alert conditions, as one pure function so the
 * scheduler and the tests exercise identical logic. `B` can be another
 * indicator's series or a constant (constant just means prevB === currB) -
 * the crossing math doesn't care which.
 */
export function evaluateCondition(condition: ConditionType, { prevA, currA, prevB, currB }: ConditionInput): boolean {
  switch (condition) {
    case "crossing_up":
      return prevA <= prevB && currA > currB;
    case "crossing_down":
      return prevA >= prevB && currA < currB;
    case "greater_than":
      return currA > currB;
    case "less_than":
      return currA < currB;
    case "crosses_value":
      return (prevA <= prevB && currA > currB) || (prevA >= prevB && currA < currB);
    default:
      return false;
  }
}
