import type { Timeframe } from "../config";
import type { IndicatorKind, IndicatorSettings } from "../indicators/registry";
import type { ConditionType } from "./conditions";

export type { ConditionType } from "./conditions";

/** Only "Option Alpha" today; the shape is generic so another platform is
 * just another string + its own payload-shaping conventions, if it ever needs one. */
export type AutomationPlatform = "Option Alpha";

export interface AlertConnection {
  id: string;
  userId: string;
  platform: AutomationPlatform;
  label: string;
  /** AES-256-GCM ciphertext, "iv:tag:ciphertext" (all base64). Never sent to the client. */
  webhookUrlEncrypted: string;
  /** e.g. "https://app.optionalpha.com/hook/••••••17" - safe to show anywhere. */
  maskedUrl: string;
  active: boolean;
  createdAt: number;
}

/** What the client ever sees of a connection. */
export type AlertConnectionView = Omit<AlertConnection, "webhookUrlEncrypted">;

export interface IndicatorOperand {
  mode: "indicator";
  kind: IndicatorKind;
  settings: IndicatorSettings;
  /** Which of the indicator's output lines to read (e.g. "signal" for MACD). Defaults to its primary line. */
  lineKey?: string;
}

export interface ValueOperand {
  mode: "value";
  value: number;
}

export type RuleOperand = IndicatorOperand | ValueOperand;

export interface AlertRule {
  id: string;
  userId: string;
  connectionId: string;
  symbol: string;
  timeframe: Timeframe;
  name: string;
  operandA: IndicatorOperand;
  condition: ConditionType;
  operandB: RuleOperand;
  message?: string;
  enabled: boolean;
  lastTriggeredAt: number | null;
  /** Internal dedupe: the bar-close time this rule was last evaluated against, so a
   * scheduler tick that lands mid-bar never double-fires within the same candle. */
  lastEvaluatedBarTime: number | null;
  createdAt: number;
}

export interface AlertTriggerLog {
  id: string;
  ruleId: string;
  firedAt: number;
  payload: string;
  statusCode: number | null;
  success: boolean;
  error?: string;
  attempt: number;
  /** True for a manually-fired "Send Test", so the log can tell a real
   * trigger apart from someone validating the rule. Absent on older/real logs. */
  isTest?: boolean;
}
