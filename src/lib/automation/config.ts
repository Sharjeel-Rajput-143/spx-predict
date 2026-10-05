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

/** "HH:MM" -> minutes since midnight. */
function envClockMinutes(name: string, fallback: string): number {
  const raw = envString(name, fallback);
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`${name} must be HH:MM (24h, America/New_York), got "${raw}".`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
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

export function getWebhookSecret(): string {
  return requiredEnvString("WEBHOOK_SECRET", "Set it in .env.local before any TradingView alert can reach the webhook.");
}

/** Sign-in is required whenever a status-page password is configured. With none
 * set it's skipped for local development - but never in a production build,
 * where a missing password means access is denied rather than open. */
export function isAuthRequired(): boolean {
  return Boolean(process.env.AUTOMATION_STATUS_PASSWORD) || process.env.NODE_ENV === "production";
}

export function getStatusPagePassword(): string {
  return requiredEnvString("AUTOMATION_STATUS_PASSWORD", "Set it in .env.local to protect the bot status page.");
}

export function isDryRun(): boolean {
  return envString("AUTOMATION_DRY_RUN", "false") === "true";
}
