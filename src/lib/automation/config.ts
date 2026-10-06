import "server-only";

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}".`);
  return n;
}

export function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export function requiredEnvString(name: string, why: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required and not set. ${why}`);
  return raw;
}

export function requiredEnvNumber(name: string, why: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") throw new Error(`${name} is required and not set. ${why}`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}".`);
  return n;
}

export const DEDUPE_WINDOW_SECONDS = envNumber("DEDUPE_WINDOW_SECONDS", 120);
export const MAX_POSITIONS_PER_TYPE = envNumber("MAX_POSITIONS_PER_TYPE", 1);
export const TOTAL_POSITION_LIMIT = envNumber("TOTAL_POSITION_LIMIT", 1);
export const DAILY_NEW_POSITION_LIMIT = envNumber("DAILY_NEW_POSITION_LIMIT", 10);
export const ERROR_FAILSAFE_THRESHOLD = envNumber("ERROR_FAILSAFE_THRESHOLD", 10);
export const ORDER_FILL_TIMEOUT_SECONDS = envNumber("ORDER_FILL_TIMEOUT_SECONDS", 120);
export const CLOSE_CONFIRM_TIMEOUT_SECONDS = envNumber("CLOSE_CONFIRM_TIMEOUT_SECONDS", 120);

/** Internal polling cadence, not part of the spec's config list - short
 * enough in production to notice a fill quickly, overridable in tests so a
 * 120s timeout doesn't mean a 120s test. */
export const ORDER_POLL_INTERVAL_MS = envNumber("AUTOMATION_ORDER_POLL_INTERVAL_MS", 2000);

/** Minimum seconds a position must have been held before a flip may close it.
 * 0 (the default) disables the cooldown; it exists to cut whipsaw losses on
 * choppy days once someone decides they want it. */
export function getFlipCooldownSeconds(): number {
  return envNumber("FLIP_COOLDOWN_SECONDS", 0);
}

/** "HH:MM" (24h) -> minutes since midnight. `label` names the setting in the error. */
export function parseClockMinutes(raw: string, label: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`${label} must be HH:MM (24h, America/New_York), got "${raw}".`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function envClockMinutes(name: string, fallback: string): number {
  return parseClockMinutes(envString(name, fallback), name);
}

/** Weekdays only; the window is inclusive at both ends and read in
 * America/New_York. Override with AUTOMATION_HOURS_START / _END ("HH:MM"). */
export const TRADING_HOURS = {
  timezone: "America/New_York",
  startMinutes: envClockMinutes("AUTOMATION_HOURS_START", "09:35"),
  endMinutes: envClockMinutes("AUTOMATION_HOURS_END", "15:55"),
};

export const EOD_SWEEP_HOUR_ET = 16;
export const EOD_SWEEP_MINUTE_ET = 5;
/** The sweep time a bot gets when it doesn't set its own (4:05pm ET). */
export const DEFAULT_EOD_SWEEP_MINUTES = EOD_SWEEP_HOUR_ET * 60 + EOD_SWEEP_MINUTE_ET;

export function getWebhookSecret(): string {
  return requiredEnvString("WEBHOOK_SECRET", "Set it in .env.local before any TradingView alert can reach the webhook.");
}

/** Sign-in is required whenever a status-page password is configured. With none
 * set it's skipped for local development - but never in a production build,
 * where a missing password means access is denied rather than open. */
export function isAuthRequired(): boolean {
  if (isAuthDisabled()) return false;
  return Boolean(process.env.AUTOMATION_STATUS_PASSWORD) || process.env.NODE_ENV === "production";
}

/** Sign-in can be switched off on purpose with AUTOMATION_AUTH_DISABLED=true (a demo, or a private network).
 * Then anyone who can reach the address can use every admin page, so the app shows a warning banner - and it
 * is refused outright when real money is in play (Tradier production), where this setting is ignored. */
export function isAuthDisabled(): boolean {
  if (process.env.AUTOMATION_AUTH_DISABLED !== "true") return false;
  const realMoney = process.env.EXECUTOR?.trim().toLowerCase() === "tradier" && process.env.TRADIER_ALLOW_PRODUCTION === "true";
  return !realMoney;
}

export function getStatusPagePassword(): string {
  return requiredEnvString("AUTOMATION_STATUS_PASSWORD", "Set it in .env.local to protect the bot status page.");
}

export function isDryRun(): boolean {
  return envString("AUTOMATION_DRY_RUN", "false") === "true";
}

/** Testing mode lets the admin page's Send test alert run outside trading hours
 * (the clock check is skipped and says so in the trace). Real webhook alerts
 * are never affected. Off unless AUTOMATION_TEST_MODE=true. */
export function isTestMode(): boolean {
  return envString("AUTOMATION_TEST_MODE", "false") === "true";
}
