import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAlertEmail, getAppSettings, getGlobalWindow, updateAppSettings } from "./appSettings";
import { alertsStore } from "./store";
import { createSession, isValidSession } from "./session";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import { decisionsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";

setTestBotEnv();
setNdxTestEnv();

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("defaults", () => {
  it("email off, the environment's window, a one hour session", () => {
    expect(getAppSettings()).toEqual({ tradingWindow: null, emailAlerts: { enabled: false, to: "", onTrade: true, onWarningError: true, includeTest: true }, notifications: { trades: false, warnings: true }, sessionTimeoutMinutes: 60 });
    expect(getGlobalWindow()).toMatchObject({ startMinutes: 9 * 60 + 35, endMinutes: 15 * 60 + 55, source: "environment" });
    expect(getAlertEmail().enabled).toBe(false);
  });
});

describe("updateAppSettings", () => {
  it("saves a trading window, and null returns to the environment's", () => {
    updateAppSettings({ tradingWindow: { start: "10:00", end: "15:00" } });
    expect(getGlobalWindow()).toMatchObject({ startMinutes: 600, endMinutes: 900, source: "settings" });
    updateAppSettings({ tradingWindow: null });
    expect(getGlobalWindow().source).toBe("environment");
  });

  it("refuses a window that doesn't start before it ends, or isn't a time", () => {
    expect(() => updateAppSettings({ tradingWindow: { start: "15:00", end: "10:00" } })).toThrow(/start before it ends/);
    expect(() => updateAppSettings({ tradingWindow: { start: "9:61", end: "15:00" } })).toThrow(/HH:MM/);
    expect(getAppSettings().tradingWindow).toBeNull();
  });

  it("email needs an address before it can be switched on, and checks the address", () => {
    expect(() => updateAppSettings({ emailAlerts: { enabled: true } })).toThrow(/Enter the email address/);
    expect(() => updateAppSettings({ emailAlerts: { to: "not an email" } })).toThrow(/doesn't look like an email/);
    updateAppSettings({ emailAlerts: { enabled: true, to: "owner@example.invalid", includeTest: false } });
    expect(getAppSettings().emailAlerts).toMatchObject({ enabled: true, to: "owner@example.invalid", onTrade: true, includeTest: false });
  });

  it("only the listed session timeouts are allowed", () => {
    expect(() => updateAppSettings({ sessionTimeoutMinutes: 45 })).toThrow(/30, 60, 120, 240, 480/);
    updateAppSettings({ sessionTimeoutMinutes: 240 });
    expect(getAppSettings().sessionTimeoutMinutes).toBe(240);
  });

  it("a partial update leaves the rest alone", () => {
    updateAppSettings({ sessionTimeoutMinutes: 120 });
    updateAppSettings({ tradingWindow: { start: "10:00", end: "15:00" } });
    expect(getAppSettings()).toMatchObject({ sessionTimeoutMinutes: 120, tradingWindow: { start: "10:00", end: "15:00" } });
  });
});

describe("the saved window is what the engine enforces", () => {
  const run = async (now: number, barTime: string) => {
    const signal = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: "bullish", price: 21_003.7, barTime, interval: "5", raw: { symbol: "NDX" }, now });
    await processSignal(signal, { executor: new MockExecutor(), now, closeConfirmTimeoutMs: 50, orderFillTimeoutMs: 50, pollIntervalMs: 5 });
  };

  it("for a bot without its own window, and a bot's own window still wins", async () => {
    updateAppSettings({ tradingWindow: { start: "11:00", end: "15:00" } }); // BASE_NOW is 10:40am ET
    await run(BASE_NOW, "a");
    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["outside_hours"]);

    updateAppSettings({ tradingWindow: { start: "10:00", end: "15:00" } });
    await run(BASE_NOW + 200_000, "b");
    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["outside_hours", "opened"]);
  });
});

describe("email preferences decide what is queued", () => {
  it("environment settings still work, and the page's switches add to them", () => {
    vi.stubEnv("ALERT_EMAIL_ENABLED", "true");
    vi.stubEnv("ALERT_EMAIL_TO", "env@example.invalid");
    expect(getAlertEmail()).toMatchObject({ enabled: true, to: "env@example.invalid" });
    vi.stubEnv("ALERT_EMAIL_ENABLED", "");
    updateAppSettings({ emailAlerts: { enabled: true, to: "page@example.invalid" } });
    expect(getAlertEmail()).toMatchObject({ enabled: true, to: "page@example.invalid" });
  });

  const emit = async (direction: "bullish" | "bearish", barTime: string, now: number, extra: Record<string, unknown> = {}, symbol = "NDX", price = 21_003.7) => {
    const signal = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price, barTime, interval: "5", raw: { symbol, ...extra }, now });
    await processSignal(signal, { executor: new MockExecutor(), now, closeConfirmTimeoutMs: 50, orderFillTimeoutMs: 50, pollIntervalMs: 5 });
  };

  it("trade alerts and warning/error alerts can be switched separately", async () => {
    updateAppSettings({ emailAlerts: { enabled: true, to: "o@example.invalid", onTrade: false, onWarningError: true } });
    await emit("bullish", "a", BASE_NOW); // opened -> a trade alert, not wanted
    await emit("bullish", "b", BASE_NOW + 200_000, {}, "SPX"); // symbol_mismatch -> a warning, wanted
    expect(alertsStore.all().map((a) => [a.kind, a.email])).toEqual([["open", "off"], ["warning", "queued"]]);
  });

  it("test trades are left out when the setting says so", async () => {
    updateAppSettings({ emailAlerts: { enabled: true, to: "o@example.invalid", includeTest: false } });
    await emit("bullish", "t", BASE_NOW, { test: true });
    await emit("bearish", "r", BASE_NOW + 200_000);
    expect(alertsStore.all().map((a) => [a.outcome, a.email])).toEqual([["opened", "off"], ["closed", "queued"], ["opened", "queued"]]);
  });
});

describe("session timeout", () => {
  it("a sign-in expires after the saved timeout", () => {
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "pw");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE_NOW);
    updateAppSettings({ sessionTimeoutMinutes: 30 });
    const token = createSession();
    vi.setSystemTime(BASE_NOW + 29 * 60_000);
    expect(isValidSession(token)).toBe(true);
    vi.setSystemTime(BASE_NOW + 31 * 60_000);
    expect(isValidSession(token)).toBe(false);
    expect(isValidSession(token)).toBe(false); // and it stays gone
  });
});

describe("notification settings (the bell)", () => {
  it("warnings on and trades off to begin with, saved one at a time, and kept apart from the email settings", () => {
    expect(getAppSettings().notifications).toEqual({ trades: false, warnings: true });
    expect(updateAppSettings({ notifications: { trades: true } }).notifications).toEqual({ trades: true, warnings: true });
    expect(updateAppSettings({ notifications: { warnings: false } }).notifications).toEqual({ trades: true, warnings: false });
    expect(getAppSettings().notifications).toEqual({ trades: true, warnings: false });
    expect(getAppSettings().emailAlerts.enabled).toBe(false);
  });

  it("only on or off is accepted, and errors cannot be switched off (there is no such setting)", () => {
    expect(() => updateAppSettings({ notifications: { trades: "yes" as unknown as boolean } })).toThrow(/must be on or off/);
    const saved = updateAppSettings({ notifications: { errors: false } as never });
    expect(Object.keys(saved.notifications).sort()).toEqual(["trades", "warnings"]);
  });
});
