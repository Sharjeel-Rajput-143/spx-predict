import "server-only";
import { TRADING_HOURS, envString, parseClockMinutes } from "./config";
import { ownerUserId } from "@/lib/auth/users";
import { settingsStore } from "./store";
import { currentUserId } from "./userContext";
import type { AppSettings } from "./types";

export const SESSION_TIMEOUT_CHOICES = [30, 60, 120, 240, 480, 1440] as const;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  tradingWindow: null,
  emailAlerts: { enabled: false, to: "", onTrade: true, onWarningError: true, includeTest: true },
  // Errors always raise a notification. Warnings are useful and rare, so on; every trade, twice on a flip, would be noise, so off.
  notifications: { trades: false, warnings: true },
  sessionTimeoutMinutes: 1440, // a day: signed in while in use, signed out after 24 hours of no use (and never kept past 24 hours from the sign-in)
};

/** The row of whoever is signed in (the owner's is "app", as it always was; anyone else's is "app:<userId>"). With nobody signed in (the engine) it is the owner's. */
function settingsRowId(): string {
  const me = currentUserId() ?? ownerUserId();
  return me === ownerUserId() ? "app" : `app:${me}`;
}

/** What the Settings page has saved, over the defaults. */
export function getAppSettings(): AppSettings {
  const row = settingsStore.get(settingsRowId());
  return {
    tradingWindow: row?.tradingWindow ?? DEFAULT_APP_SETTINGS.tradingWindow,
    emailAlerts: { ...DEFAULT_APP_SETTINGS.emailAlerts, ...(row?.emailAlerts ?? {}) },
    notifications: { ...DEFAULT_APP_SETTINGS.notifications, ...(row?.notifications ?? {}) },
    sessionTimeoutMinutes: row?.sessionTimeoutMinutes ?? DEFAULT_APP_SETTINGS.sessionTimeoutMinutes,
  };
}

export interface AppSettingsPatch {
  /** null returns to the environment's window. */
  tradingWindow?: { start: string; end: string } | null;
  emailAlerts?: Partial<AppSettings["emailAlerts"]>;
  notifications?: Partial<AppSettings["notifications"]>;
  sessionTimeoutMinutes?: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validates and saves part of the settings. Throws a message fit to show. */
export function updateAppSettings(patch: AppSettingsPatch): AppSettings {
  const current = getAppSettings();
  const next: AppSettings = { ...current, emailAlerts: { ...current.emailAlerts }, notifications: { ...current.notifications } };

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

  if (patch.notifications) {
    for (const key of ["trades", "warnings"] as const) {
      const v = patch.notifications[key];
      if (v === undefined) continue;
      if (typeof v !== "boolean") throw new Error(`Notification setting "${key}" must be on or off.`);
      next.notifications[key] = v;
    }
  }

  if (patch.sessionTimeoutMinutes !== undefined) {
    if (!(SESSION_TIMEOUT_CHOICES as readonly number[]).includes(patch.sessionTimeoutMinutes)) throw new Error(`Session timeout must be one of ${SESSION_TIMEOUT_CHOICES.join(", ")} minutes.`);
    next.sessionTimeoutMinutes = patch.sessionTimeoutMinutes;
  }

  const { tradingWindow, emailAlerts, notifications, sessionTimeoutMinutes } = next;
  const id = settingsRowId();
  if (settingsStore.get(id)) settingsStore.update(id, { tradingWindow, emailAlerts, notifications, sessionTimeoutMinutes });
  else settingsStore.insert({ id, tradingWindow, emailAlerts, notifications, sessionTimeoutMinutes });
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
