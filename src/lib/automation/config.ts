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
/** A live quote older than this (seconds) isn't used for strikes: the bot refuses to open instead. */
export const STRIKE_QUOTE_MAX_AGE_SECONDS = envNumber("STRIKE_QUOTE_MAX_AGE_SECONDS", 60);
export const ERROR_FAILSAFE_THRESHOLD = envNumber("ERROR_FAILSAFE_THRESHOLD", 10);
export const ORDER_FILL_TIMEOUT_SECONDS = envNumber("ORDER_FILL_TIMEOUT_SECONDS", 120);
export const CLOSE_CONFIRM_TIMEOUT_SECONDS = envNumber("CLOSE_CONFIRM_TIMEOUT_SECONDS", 120);

/** Internal polling cadence, not part of the spec's config list - short
 * enough in production to notice a fill quickly, overridable in tests so a
 * 120s timeout doesn't mean a 120s test. */
/** A serverless demo host answers within seconds, so it checks for a fill more often (the mock fills instantly). */
export const ORDER_POLL_INTERVAL_MS = envNumber("AUTOMATION_ORDER_POLL_INTERVAL_MS", process.env.VERCEL ? 250 : 2000);

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

/** Sign-in is required whenever a status-page password is configured. With none set it is skipped - in local
 * development, and on a production host running only the mock executor (a demo with nothing real behind it, where the app
 * shows a warning). It is NEVER skipped once a real broker is configured (EXECUTOR=tradier, sandbox or production): then a
 * missing password means access is denied rather than open. */
export function isAuthRequired(): boolean {
  if (isAuthDisabled()) return false;
  if (process.env.APP_LOGIN_PASSWORD || process.env.AUTOMATION_STATUS_PASSWORD) return true;
  return process.env.NODE_ENV === "production" && isBrokerConfigured();
}

/** True when sign-in is off in a production build: on purpose (AUTOMATION_AUTH_DISABLED=true) or because no password
 * was ever set. The app shows a warning on every page. */
export function isAuthOpenInProduction(): boolean {
  return process.env.NODE_ENV === "production" && !isAuthRequired();
}

/** Sign-in can be switched off on purpose with AUTOMATION_AUTH_DISABLED=true (a demo, or a private network). Then
 * anyone who can reach the address can use every admin page, so the app warns - and the setting is ignored when real
 * money is in play (Tradier production), where sign-in stays on. */
export function isAuthDisabled(): boolean {
  if (process.env.AUTOMATION_AUTH_DISABLED !== "true") return false;
  const realMoney = isBrokerConfigured() && process.env.TRADIER_ALLOW_PRODUCTION === "true";
  return !realMoney;
}

export function getStatusPagePassword(): string {
  const password = process.env.APP_LOGIN_PASSWORD || process.env.AUTOMATION_STATUS_PASSWORD;
  if (!password) throw new Error("APP_LOGIN_PASSWORD is required and not set. Set it in .env.local to protect the app.");
  return password;
}

export function isDryRun(): boolean {
  return envString("AUTOMATION_DRY_RUN", "false") === "true";
}

/** Testing mode lets the admin page's Send test alert run outside trading hours
 * (the clock check is skipped and says so in the trace). Real webhook alerts
 * are never affected. Off unless AUTOMATION_TEST_MODE=true. */
export function isTestMode(): boolean {
  const raw = process.env.AUTOMATION_TEST_MODE;
  if (raw !== undefined && raw !== "") return raw === "true";
  // Not set: test alerts may run any time on the mock executor (nothing real is behind it), never when a broker is configured.
  return !isBrokerConfigured();
}

export const isBrokerConfigured = () => process.env.EXECUTOR?.trim().toLowerCase() === "tradier";

/** A deployment on a serverless host (Vercel) that is only running the mock executor: a demo. It fills in the settings
 * nobody has given it, so the pages work with no environment variables at all. Never true locally and never with a broker. */
export const isDemoHost = () => Boolean(process.env.VERCEL) && !isBrokerConfigured();

let demoSecret: string | undefined;

export function getWebhookSecret(): string {
  const set = process.env.WEBHOOK_SECRET;
  if (set) return set;
  // A demo host with no secret set makes a throwaway one: Send test alert uses it internally, and nobody outside can know it.
  if (isDemoHost()) return (demoSecret ??= `demo-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);
  return requiredEnvString("WEBHOOK_SECRET", "Set it in .env.local before any TradingView alert can reach the webhook.");
}
