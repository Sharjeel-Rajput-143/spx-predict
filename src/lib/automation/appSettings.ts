import "server-only";
import { TRADING_HOURS, envString, parseClockMinutes } from "./config";
import { settingsStore } from "./store";
import type { AppSettings } from "./types";

export const SESSION_TIMEOUT_CHOICES = [30, 60, 120, 240, 480] as const;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  tradingWindow: null,
  emailAlerts: { enabled: false, to: "", onTrade: true, onWarningError: true, includeTest: true },
  sessionTimeoutMinutes: 60,
};

/** What the Settings page has saved, over the defaults. */
export function getAppSettings(): AppSettings {
  const row = settingsStore.get("app");
  return {
    tradingWindow: row?.tradingWindow ?? DEFAULT_APP_SETTINGS.tradingWindow,
    emailAlerts: { ...DEFAULT_APP_SETTINGS.emailAlerts, ...(row?.emailAlerts ?? {}) },
    sessionTimeoutMinutes: row?.sessionTimeoutMinutes ?? DEFAULT_APP_SETTINGS.sessionTimeoutMinutes,
  };
}

export interface AppSettingsPatch {
  /** null returns to the environment's window. */
  tradingWindow?: { start: string; end: string } | null;
  emailAlerts?: Partial<AppSettings["emailAlerts"]>;
  sessionTimeoutMinutes?: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validates and saves part of the settings. Throws a message fit to show. */
export function updateAppSettings(patch: AppSettingsPatch): AppSettings {
  const current = getAppSettings();
  const next: AppSettings = { ...current, emailAlerts: { ...current.emailAlerts } };

  if (patch.tradingWindow !== undefined) {
    if (patch.tradingWindow === null) next.tradingWindow = null;
    else {
      const start = parseClockMinutes(String(patch.tradingWindow.start), "The window's start");
      const end = parseClockMinutes(String(patch.tradingWindow.end), "The window's end");
      if (start >= end) throw new Error("The trading window has to start before it ends.");
      next.tradingWindow = { start: patch.tradingWindow.start, end: patch.tradingWindow.end };
    }
  }

  if (patch.emailAlerts) {
    const e = patch.emailAlerts;
    for (const key of ["enabled", "onTrade", "onWarningError", "includeTest"] as const) {
      if (e[key] !== undefined) {
        if (typeof e[key] !== "boolean") throw new Error(`Email setting "${key}" must be on or off.`);
        next.emailAlerts[key] = e[key]!;
      }
    }
    if (e.to !== undefined) {
      const to = String(e.to).trim();
      if (to && !EMAIL.test(to)) throw new Error("That doesn't look like an email address.");
      next.emailAlerts.to = to;
    }
    if (next.emailAlerts.enabled && !next.emailAlerts.to) throw new Error("Enter the email address to send alerts to before switching email on.");
  }

  if (patch.sessionTimeoutMinutes !== undefined) {
    if (!(SESSION_TIMEOUT_CHOICES as readonly number[]).includes(patch.sessionTimeoutMinutes)) throw new Error(`Session timeout must be one of ${SESSION_TIMEOUT_CHOICES.join(", ")} minutes.`);
    next.sessionTimeoutMinutes = patch.sessionTimeoutMinutes;
  }

  const { tradingWindow, emailAlerts, sessionTimeoutMinutes } = next;
  if (settingsStore.get("app")) settingsStore.update("app", { tradingWindow, emailAlerts, sessionTimeoutMinutes });
  else settingsStore.insert({ id: "app", tradingWindow, emailAlerts, sessionTimeoutMinutes });
  return getAppSettings();
}

/** The default signal window, in minutes after midnight New York time: the one saved on the Settings page, else the environment's. */
export function getGlobalWindow(): { startMinutes: number; endMinutes: number; source: "settings" | "environment" } {
  const w = getAppSettings().tradingWindow;
  if (w) return { startMinutes: parseClockMinutes(w.start, "start"), endMinutes: parseClockMinutes(w.end, "end"), source: "settings" };
  return { startMinutes: TRADING_HOURS.startMinutes, endMinutes: TRADING_HOURS.endMinutes, source: "environment" };
}

/** Whether (and where) alert emails are wanted. Environment settings (ALERT_EMAIL_ENABLED + ALERT_EMAIL_TO)
 * still count; the Settings page's switches add to them. No mail sender is wired: this only decides what gets queued. */
export function getAlertEmail(): { enabled: boolean; to: string | null; onTrade: boolean; onWarningError: boolean; includeTest: boolean } {
  const s = getAppSettings().emailAlerts;
  const envOn = envString("ALERT_EMAIL_ENABLED", "false") === "true";
  const to = s.to || process.env.ALERT_EMAIL_TO?.trim() || null;
  return { enabled: (s.enabled || envOn) && to !== null, to, onTrade: s.onTrade, onWarningError: s.onWarningError, includeTest: s.includeTest };
}
