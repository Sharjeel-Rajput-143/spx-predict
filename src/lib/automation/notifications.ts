import "server-only";
import crypto from "node:crypto";
import { getAppSettings } from "./appSettings";
import { botDisplayName } from "./bots";
import { notificationsStore } from "./store";
import type { AlertKind, Decision, NotificationSeverity } from "./types";

/**
 * The bell in the app's header. A notification is written from the same events as an activity alert (alerts.ts calls this for every
 * decision), but it is its own record, so it does not depend on a bot's four alert switches:
 *
 *  - an ERROR always raises one: a failed or rejected close, an open that was rejected or never filled, an unsafe account, a broker
 *    mismatch, a lost order, a stopped run;
 *  - a TRADE (opened, closed) and a WARNING (a safeguard stopped a signal) raise one only if Settings > Notifications ticks them;
 *  - the same alert is listed once: when it comes in again inside the quiet window it is counted (`repeats`), not listed again;
 *  - only the latest 200 are kept.
 * Nothing here can place, change or stop a trade, and nothing here throws into the trade path.
 */

export const NOTIFICATION_CAP = 200;
/** The same alert coming in again inside this long is counted, not listed again. */
export const QUIET_WINDOW_MS = 60 * 60_000;
const MESSAGE_LENGTH = 240;
/** What a call to the list returns at most. */
export const LIST_LIMIT = 50;

const SEVERITY: Record<AlertKind, NotificationSeverity> = { error: "error", warning: "warning", open: "trade", close: "trade" };
export const severityOfAlert = (kind: AlertKind): NotificationSeverity => SEVERITY[kind];

/** Whether this severity is wanted: errors always, the others as Settings says. */
export function wantsNotification(severity: NotificationSeverity): boolean {
  if (severity === "error") return true;
  const prefs = getAppSettings().notifications;
  return severity === "trade" ? prefs.trades : prefs.warnings;
}

function clean(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MESSAGE_LENGTH ? `${flat.slice(0, MESSAGE_LENGTH - 1)}…` : flat;
}

/** The decision's own words, without the bot's name in front (the list shows the bot's name beside it). */
function messageOf(decision: Decision): string {
  const name = botDisplayName(decision.botId);
  const reason = decision.reason.startsWith(`${name}: `) ? decision.reason.slice(name.length + 2) : decision.reason;
  return clean(reason);
}

const positionIdOf = (decision: Decision): string | undefined => {
  const id = (decision.detail as { positionId?: unknown } | undefined)?.positionId;
  return typeof id === "string" && id ? id : undefined;
};

/** Where the entry points: the bot's positions when a position is concerned, else its Log. Never an address from outside the app. */
export function linkFor(botId: string, positionId: string | undefined): string {
  return `/automation/bots/${encodeURIComponent(botId)}?tab=${positionId ? "positions" : "log"}`;
}

/** Called for every decision row (alerts.ts). Quietly does nothing for decisions that raise no alert. */
export function recordNotification(decision: Decision, kind: AlertKind): void {
  const severity = severityOfAlert(kind);
  if (!wantsNotification(severity)) return;
  const now = decision.createdAt;
  const message = messageOf(decision);
  // An error with no signal of its own (a check, a retry) is the same error however many times it comes in; a trade or a warning belongs to its signal.
  const dedupeKey = [decision.botId, decision.outcome, severity === "error" ? "" : (decision.signalId ?? ""), message].join("|");

  const same = notificationsStore.query((n) => n.dedupeKey === dedupeKey && Math.abs(now - n.lastSeenAt) < QUIET_WINDOW_MS)[0];
  if (same) {
    notificationsStore.update(same.id, { repeats: same.repeats + 1, lastSeenAt: now });
    return;
  }

  const positionId = positionIdOf(decision);
  const stored = notificationsStore.insert({
    id: `note-${now}-${crypto.randomUUID()}`,
    botId: decision.botId,
    severity,
    outcome: decision.outcome,
    message,
    signalId: decision.signalId,
    ...(positionId ? { positionId } : {}),
    link: linkFor(decision.botId, positionId),
    createdAt: now,
    lastSeenAt: now,
    repeats: 1,
    dedupeKey,
    readAt: null,
  });
  trimToCap(stored.userId);
}

/** Keeps the latest NOTIFICATION_CAP of ONE owner's, dropping their oldest. (The engine runs with nobody signed in and sees everyone's, so the owner is named.) */
function trimToCap(userId: string | undefined): void {
  const all = notificationsStore.query((n) => n.userId === userId);
  if (all.length <= NOTIFICATION_CAP) return;
  const keep = new Set(
    all
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, NOTIFICATION_CAP)
      .map((n) => n.id),
  );
  notificationsStore.removeWhere((n) => n.userId === userId && !keep.has(n.id));
}

export interface NotificationView {
  id: string;
  severity: NotificationSeverity;
  botId: string;
  botName: string;
  message: string;
  outcome: string;
  link: string;
  positionId: string | null;
  createdAt: number;
  repeats: number;
  read: boolean;
}

/** The newest first, what the bell shows, with how many are unread in all. */
export function listNotifications(limit: number = LIST_LIMIT): { notifications: NotificationView[]; unread: number; total: number } {
  const all = notificationsStore.all().sort((a, b) => b.createdAt - a.createdAt);
  return {
    notifications: all.slice(0, limit).map((n) => ({
      id: n.id,
      severity: n.severity,
      botId: n.botId,
      botName: botDisplayName(n.botId),
      message: n.message,
      outcome: n.outcome,
      link: n.link,
      positionId: n.positionId ?? null,
      createdAt: n.createdAt,
      repeats: n.repeats,
      read: n.readAt !== null,
    })),
    unread: all.filter((n) => n.readAt === null).length,
    total: all.length,
  };
}

/** Marks these read (already-read ones are left alone). Returns how many changed. */
export function markRead(ids: string[], now: number = Date.now()): number {
  let changed = 0;
  for (const id of new Set(ids)) {
    const n = notificationsStore.get(id);
    if (n && n.readAt === null) {
      notificationsStore.update(id, { readAt: now });
      changed++;
    }
  }
  return changed;
}

export function markAllRead(now: number = Date.now()): number {
  return markRead(notificationsStore.query((n) => n.readAt === null).map((n) => n.id), now);
}

/** Removes these (or all of this user's) notifications. Returns how many. */
export function clearNotifications(ids?: string[]): number {
  if (!ids) return notificationsStore.removeWhere(() => true);
  const wanted = new Set(ids);
  return notificationsStore.removeWhere((n) => wanted.has(n.id));
}

