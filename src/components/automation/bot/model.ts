import type { PositionStats } from "@/lib/automation/pnl";
import type { BotAlerts, BotSafeguards, BotStaticConfig, Decision, Order, Position, Run, Signal } from "@/lib/automation/types";

/** Shape of GET /api/automation/bots/[id]. */
export interface BotDetailData {
  now: number;
  bot: {
    id: string;
    name: string;
    builtIn: boolean;
    enabled: boolean;
    killSwitch?: boolean;
    archived: boolean;
    needsAttention: boolean;
    needsAttentionReason: string | null;
    configError: string | null;
    missingSettings: { key: string; why: string }[] | null;
    /** Name/account/allocation of a bot still waiting for its trading inputs. */
    draft: Partial<BotStaticConfig> | null;
    accountId: string | null;
    allocation: number | null;
    group: string | null;
    tags: string[];
    notes: string;
    triggers: { bullish: boolean; bearish: boolean };
    alwaysOn?: { bullish: boolean; bearish: boolean };
    positionChecks?: import("@/lib/automation/positionChecks").PositionChecks;
    openSettings?: Partial<Record<"bullish" | "bearish", import("@/lib/automation/openSettings").OpenSettings>>;
    closeSettings?: Partial<Record<"bullish" | "bearish", { memo?: string; tags?: string[]; pricing?: import("@/lib/automation/closePricing").ClosePricing; quantity?: import("@/lib/automation/closePricing").CloseQuantity }>>;
    monitors?: Partial<Record<"bullishClose" | "bearishClose", { enabled: boolean; memo?: string; tags?: string[] }>>;
    alerts: BotAlerts;
    safeguards: BotSafeguards;
    logClearedAt: number;
    dailyResetAt: number;
  };
  config: BotStaticConfig | null;
  limits: {
    maxPositionsPerType: number;
    dayTradingAllowed: boolean;
    totalPositionLimit: number;
    dailyNewPositionLimit: number;
    errorFailsafeThreshold: number;
    dedupeWindowSeconds: number;
    flipCooldownSeconds: number;
    orderFillTimeoutSeconds: number;
    closeConfirmTimeoutSeconds: number;
    hours: { start: string; end: string; timezone: string };
    dryRun: boolean;
  };
  counts: { errorsToday: number; newPositionsToday: number; activePositions: number };
  capital: { allocation: number; atRisk: number; available: number; netLiquid: number | null } | null;
  stats: PositionStats;
  /** True when the mock executor is making up close prices (never real). */
  mockPricing: boolean;
  options: { accounts: string[]; groups: string[] };
  positions: Position[];
  orders: Order[];
  signals: Signal[];
  decisions: Decision[];
  /** Step-by-step records of each run, newest first. Older entries have none. */
  runs: Run[];
}

export type Tone = "ok" | "skip" | "warn" | "error";

/** Own wording for every decision outcome, and how loudly to show it. */
export const OUTCOMES: Record<string, { label: string; tone: Tone }> = {
  opened: { label: "Opened position", tone: "ok" },
  closed: { label: "Closed position", tone: "ok" },
  dry_run: { label: "Dry run", tone: "skip" },
  automations_off: { label: "Bot off", tone: "skip" },
  kill_switch: { label: "Kill switch", tone: "warn" },
  monitor_closed: { label: "Monitor closed position", tone: "ok" },
  webhook_attached: { label: "Webhook attached", tone: "ok" },
  webhook_changed: { label: "Webhook changed", tone: "ok" },
  webhook_detached: { label: "Webhook detached", tone: "skip" },
  bot_off_close_only: { label: "Bot off, close only", tone: "skip" },
  outside_hours: { label: "Outside hours", tone: "skip" },
  duplicate_signal: { label: "Duplicate", tone: "skip" },
  already_in_position: { label: "Already in position", tone: "skip" },
  close_in_flight: { label: "Close in flight", tone: "skip" },
  cooldown_active: { label: "Cooldown", tone: "skip" },
  trigger_disabled: { label: "Trigger off", tone: "skip" },
  day_trading_blocked: { label: "Day trading off", tone: "warn" },
  total_position_limit_reached: { label: "Position limit", tone: "warn" },
  daily_limit_reached: { label: "Daily limit", tone: "warn" },
  allocation_limit_reached: { label: "Allocation limit", tone: "warn" },
  overlapping_strikes: { label: "Strikes overlap", tone: "warn" },
  webhook_text_mismatch: { label: "Alert text doesn't match", tone: "error" },
  entry_criteria_not_met: { label: "Entry criteria not met", tone: "skip" },
  position_criteria_not_met: { label: "Position criteria not met", tone: "skip" },
  size_too_small: { label: "Size under 1 contract", tone: "warn" },
  exit_closed: { label: "Closed by exit options", tone: "ok" },
  no_live_price: { label: "No live price", tone: "warn" },
  invalid_strikes: { label: "Invalid strikes", tone: "error" },
  close_rejected: { label: "Close rejected", tone: "error" },
  close_timeout: { label: "Close timed out", tone: "error" },
  close_partial_fill: { label: "Close partial", tone: "error" },
  open_rejected: { label: "Open rejected", tone: "error" },
  open_timeout_no_fill: { label: "Open timed out", tone: "error" },
  executor_error: { label: "Executor error", tone: "error" },
  config_error: { label: "Config missing", tone: "error" },
  error_failsafe: { label: "Bot switched off", tone: "error" },
  run_interrupted: { label: "Run interrupted", tone: "error" },
  eod_sweep: { label: "End-of-day sweep", tone: "ok" },
};

export function outcomeInfo(outcome: string): { label: string; tone: Tone } {
  return OUTCOMES[outcome] ?? { label: outcome, tone: "skip" };
}

export const TYPE_LABEL: Record<string, string> = {
  short_put_spread: "Short put spread",
  short_call_spread: "Short call spread",
};

const TZ = "America/New_York";

export const etTime = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit" });

export const etShortTime = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

export const etDateTime = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

export function etDayKey(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
}

export function etDayLabel(ms: number, now: number): string {
  const key = etDayKey(ms);
  if (key === etDayKey(now)) return "Today";
  if (key === etDayKey(now - 86_400_000)) return "Yesterday";
  return new Date(ms).toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" });
}

/** Groups rows (already newest-first) into [dayLabel, rows] runs. */
export function groupByDay<T>(rows: T[], at: (row: T) => number, now: number): [string, T[]][] {
  const groups: [string, T[]][] = [];
  let lastKey = "";
  for (const row of rows) {
    const key = etDayKey(at(row));
    if (key !== lastKey) {
      groups.push([etDayLabel(at(row), now), []]);
      lastKey = key;
    }
    groups[groups.length - 1][1].push(row);
  }
  return groups;
}

export const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const usd2 = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
export const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Signed dollars, e.g. +$1,234 / -$300 - "—" when unknown. */
export function plText(n: number | null | undefined, digits = 0): string {
  if (n == null) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n < 0 ? "-" : n > 0 ? "+" : ""}$${abs}`;
}

export function pctText(ratio: number | null | undefined, digits = 1, signed = true): string {
  if (ratio == null) return "—";
  const v = (ratio * 100).toFixed(digits);
  return `${signed && ratio > 0 ? "+" : ""}${v}%`;
}

/** Green for gains, red for losses, neutral for zero/unknown. */
export function plClass(n: number | null | undefined): string {
  return n == null || n === 0 ? "" : n > 0 ? "text-up" : "text-down";
}

export const NO_PRICE_TIP =
  "Profit and loss comes from the prices the executor reports when an order fills. The Phase 1 mock executor reports none, so this stays blank until a real broker (Phase 2) - or simulated pricing, for demos - supplies them.";
