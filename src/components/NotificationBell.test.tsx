import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GeneralSection, type SettingsData } from "./automation/settings/sections";
import { NotificationBell, NotificationPanel, POLL_MS, bellShownFor, formatWhen, newErrors, type NotificationItem } from "./NotificationBell";

// The bell's screens and the rules behind its live updates. Server-render checks only: no browser, no network.

const NOW = Date.UTC(2026, 9, 6, 14, 40);
const MIN = 60_000;
const item = (over: Partial<NotificationItem> = {}): NotificationItem => ({
  id: `n-${Math.random().toString(36).slice(2)}`, severity: "error", botId: "ndx_ema_bias", botName: "NDX Bias Bot", message: "Closing order rejected: Insufficient margin",
  outcome: "close_rejected", link: "/automation/bots/ndx_ema_bias?tab=log", positionId: null, createdAt: NOW - 5 * MIN, repeats: 1, read: false, ...over,
});
const noop = () => undefined;
const panel = (items: NotificationItem[], over: Partial<Parameters<typeof NotificationPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <NotificationPanel items={items} unread={items.filter((n) => !n.read).length} total={items.length} now={NOW} confirmClear={false} onOpen={noop} onMarkRead={noop} onMarkAll={noop} onClear={noop} {...over} />,
  );

describe("how long ago", () => {
  it("just now, minutes, hours, then the day and the New York time", () => {
    expect(formatWhen(NOW - 10_000, NOW)).toBe("just now");
    expect(formatWhen(NOW - 3 * MIN, NOW)).toBe("3 min ago");
    expect(formatWhen(NOW - 50 * MIN, NOW)).toBe("50 min ago");
    expect(formatWhen(NOW - 2 * 60 * MIN, NOW)).toBe("2 h ago");
    expect(formatWhen(Date.UTC(2026, 9, 3, 18, 5), NOW)).toBe("Oct 3, 2:05 PM ET");
  });
});

describe("the list", () => {
  it("says there is nothing yet, and what always shows", () => {
    const out = panel([]);
    expect(out).toContain("Nothing yet");
    expect(out).toContain("Errors always show here");
    expect(out).toContain('role="dialog"');
  });

  it("shows for each one the severity, the bot, how long ago, the message, and a link to the log or the position", () => {
    const out = panel([
      item({ message: "Closing order rejected: Insufficient margin" }),
      item({ severity: "warning", message: "No live NDX price", link: "/automation/bots/ndx_ema_bias?tab=log", createdAt: NOW - 90 * MIN }),
      item({ severity: "trade", message: "Opened short put spread 20970/20960", link: "/automation/bots/ndx_ema_bias?tab=positions", positionId: "pos-1", read: true }),
    ]);
    for (const text of ["Error", "Warning", "Trade", "NDX Bias Bot", "5 min ago", "2 h ago", "Closing order rejected: Insufficient margin", "No live NDX price", "Opened short put spread 20970/20960"]) expect(out, text).toContain(text);
    expect(out).toContain('href="/automation/bots/ndx_ema_bias?tab=positions"');
    expect(out).toContain("View position");
    expect(out).toContain("View log");
  });

  it("an unread one is marked and can be marked read; a read one cannot", () => {
    const out = panel([item({ message: "Unread one" }), item({ message: "Read one", read: true })]);
    expect((out.match(/Mark read/g) ?? []).length).toBe(1);
    expect(out).toContain("1 unread");
    expect(out).toContain("bg-accent/5");
  });

  it("says how many times the same alert came in again", () => {
    expect(panel([item({ repeats: 4 })])).toContain("×4");
    expect(panel([item({ repeats: 1 })])).not.toContain("×");
  });

  it("Mark all read is off with nothing unread, and Clear is off with nothing to clear; Clear asks twice", () => {
    const allRead = panel([item({ read: true })]);
    expect(allRead).toMatch(/<button[^>]*\sdisabled=""[^>]*>Mark all read</);
    expect(panel([item()])).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Mark all read</);
    expect(panel([])).toMatch(/<button[^>]*\sdisabled=""[^>]*>Clear</);
    expect(panel([item()])).toContain(">Clear<");
    expect(panel([item()], { confirmClear: true })).toContain("Click again to clear");
  });

  it("a message with markup in it is shown as text, never as markup", () => {
    const out = panel([item({ message: "<img src=x onerror=alert(1)> <script>boom()</script>" })]);
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;img");
  });
});

describe("new errors pop up, the rest do not", () => {
  const a = item({ id: "a" });
  const b = item({ id: "b", message: "newer" });
  it("the first list ever loaded is old news: no pop-up for anything already there", () => {
    expect(newErrors(null, [a, b])).toEqual([]);
  });

  it("an error not seen before and unread pops up, oldest first; one already seen does not", () => {
    expect(newErrors(new Set(["a"]), [b, a]).map((n) => n.id)).toEqual(["b"]);
    const c = item({ id: "c" });
    expect(newErrors(new Set(["x"]), [c, b, a]).map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(newErrors(new Set(["a", "b"]), [b, a])).toEqual([]);
  });

  it("warnings, trades and errors already read never pop up", () => {
    const list = [item({ id: "w", severity: "warning" }), item({ id: "t", severity: "trade" }), item({ id: "r", read: true })];
    expect(newErrors(new Set(), list)).toEqual([]);
  });
});

describe("who gets the bell, and how often it looks", () => {
  it("someone signed in, or anyone where sign-in isn't needed; nobody while it isn't known, and nobody signed out", () => {
    expect(bellShownFor(null)).toBe(false);
    expect(bellShownFor({ authRequired: true, signedIn: false })).toBe(false);
    expect(bellShownFor({ authRequired: true, signedIn: true })).toBe(true);
    expect(bellShownFor({ authRequired: false, signedIn: false })).toBe(true);
  });

  it("asks within the 30 seconds the page promises", () => {
    expect(POLL_MS).toBeLessThanOrEqual(30_000);
  });

  it("closed, it is a bell button with no list, and nothing unread before the first answer", () => {
    const out = renderToStaticMarkup(<NotificationBell />);
    expect(out).toContain('aria-label="Notifications"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('role="dialog"');
  });
});

const settings = (bell: { trades: boolean; warnings: boolean }): SettingsData => ({
  settings: { tradingWindow: null, emailAlerts: { enabled: false, to: "", onTrade: true, onWarningError: true, includeTest: true }, notifications: bell, sessionTimeoutMinutes: 60 },
  window: { start: "09:35", end: "15:55", source: "environment", timezone: "America/New_York" },
  email: { enabled: false, to: null, senderWired: false },
  sessionTimeoutChoices: [30, 60, 120],
  signInRequired: true,
  executor: { kind: "mock", venue: "mock", error: null, dryRun: false, testMode: true },
  accounts: [],
  webhook: { path: "/api/webhook/tradingview", secretSet: true, bots: [] },
});

describe("Settings > Notifications", () => {
  const section = (bell: { trades: boolean; warnings: boolean }) => {
    const out = renderToStaticMarkup(<GeneralSection data={settings(bell)} save={async () => null} />);
    const start = out.indexOf("The bell in the header");
    return out.slice(start, out.indexOf("Email notifications", start));
  };

  it("errors are always on and can't be switched off; warnings and trades follow their tick boxes", () => {
    const out = section({ trades: false, warnings: true });
    expect(out).toContain("Errors (always on)");
    expect(out).toContain("Warnings: a safeguard stopped a signal");
    expect(out).toContain("Trades: a position was opened or closed");
    expect((out.match(/ant-checkbox-wrapper-checked/g) ?? []).length).toBe(2); // errors + warnings
    expect((out.match(/ant-checkbox-wrapper-disabled/g) ?? []).length).toBe(1); // errors only
    expect((section({ trades: true, warnings: true }).match(/ant-checkbox-wrapper-checked/g) ?? []).length).toBe(3);
    expect((section({ trades: false, warnings: false }).match(/ant-checkbox-wrapper-checked/g) ?? []).length).toBe(1);
  });

  it("says the same alert is listed once, the latest 200 are kept, and the Needs attention banner stays", () => {
    const out = section({ trades: false, warnings: true });
    expect(out).toContain("listed once");
    expect(out).toContain("latest 200");
    expect(out).toContain("Needs attention");
  });
});
