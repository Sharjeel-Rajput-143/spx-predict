import "server-only";
import crypto from "node:crypto";
import { botDisplayName } from "./bots";
import { getAlertEmail } from "./appSettings";
import { recordNotification } from "./notifications";
import { alertsStore, botsStore, signalsStore } from "./store";
import { DEFAULT_ALERTS, type AlertKind, type Decision, type DecisionOutcome } from "./types";

/** Which decisions raise an activity alert, and as what. Routine skips (bot off,
 * outside hours, trigger off, same side already held, dry run) raise none. */
const KIND_BY_OUTCOME: Partial<Record<DecisionOutcome, AlertKind>> = {
  opened: "open",
  closed: "close",
  monitor_closed: "close",
  exit_closed: "close",

  // Something went wrong or needs a person.
  error_failsafe: "error",
  run_interrupted: "error",
  executor_error: "error",
  config_error: "error",
  invalid_strikes: "error",
  webhook_text_mismatch: "error",
  open_rejected: "error",
  open_timeout_no_fill: "error",
  close_rejected: "error",
  close_timeout: "error",
  close_partial_fill: "error",

  // A safeguard stopped a signal the bot would otherwise have acted on.
  no_live_price: "warning",
  symbol_mismatch: "warning",
  price_out_of_range: "warning",
  allocation_limit_reached: "warning",
  total_position_limit_reached: "warning",
  daily_limit_reached: "warning",
  overlapping_strikes: "warning",
  size_too_small: "warning",
  day_trading_blocked: "warning",
  cooldown_active: "warning",
};

export const alertKindFor = (outcome: DecisionOutcome): AlertKind | null => KIND_BY_OUTCOME[outcome] ?? null;

/** Email is wanted when it's on, this kind is ticked (opened/closed, or warnings and errors), and it isn't a test trade the settings exclude. */
function wantsEmail(kind: AlertKind, signalId: string | null): boolean {
  const email = getAlertEmail();
  if (!email.enabled) return false;
  if (!(kind === "open" || kind === "close" ? email.onTrade : email.onWarningError)) return false;
  const test = signalId ? (signalsStore.get(signalId)?.raw as { test?: unknown } | undefined)?.test === true : false;
  return !test || email.includeTest;
}

/** Called for every decision row. Records an alert when the bot has that kind
 * switched on (Settings > Alerts; all four are on by default). Email, when it is
 * enabled, is queued on the same row - nothing is sent. */
export function recordActivityAlert(decision: Decision): void {
  const kind = alertKindFor(decision.outcome);
  if (!kind) return;
  // The bell has its own rules (errors always; trades and warnings as Settings says) and is not switched by the bot's four alert switches.
  try {
    recordNotification(decision, kind);
  } catch (err) {
    console.error("[automation] could not record a notification", err);
  }
  const settings = botsStore.get(decision.botId)?.alerts ?? DEFAULT_ALERTS;
  if (!settings[kind]) return;

  alertsStore.insert({
    id: `alert-${decision.createdAt}-${crypto.randomUUID()}`,
    botId: decision.botId,
    kind,
    outcome: decision.outcome,
    message: `${botDisplayName(decision.botId)}: ${decision.reason}`,
    signalId: decision.signalId,
    createdAt: decision.createdAt,
    email: wantsEmail(kind, decision.signalId) ? "queued" : "off",
  });
}
