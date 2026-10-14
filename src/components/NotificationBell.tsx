"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePolling } from "./automation/usePolling";
import { Toasts, type ToastItem } from "./automation/bot/primitives";
import { IconBell } from "./icons";
import { cn } from "@/lib/format";

/**
 * The bell in the header: an unread count, and a list of what happened (errors, and as Settings says, warnings and trades), each with a
 * link to the bot's positions or Log. The list is asked for every 20 seconds (never while the tab is hidden), so a new one shows without a
 * reload, and a new ERROR also pops up a message. Nothing here can place, change or stop a trade.
 */

export interface NotificationItem {
  id: string;
  severity: "error" | "warning" | "trade";
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

export const POLL_MS = 20_000;
const TOAST_MS = 10_000;

const SEVERITY_LABEL = { error: "Error", warning: "Warning", trade: "Trade" } as const;
const SEVERITY_CLASS = {
  error: "bg-down-soft text-down",
  warning: "bg-amber-500/10 text-amber-500",
  trade: "bg-accent/10 text-accent",
} as const;

/** "just now", "5 min ago", "2 h ago", else the day and the New York time. */
export function formatWhen(ms: number, now: number = Date.now()): string {
  const age = now - ms;
  if (age < 45_000) return "just now";
  if (age < 3_600_000) return `${Math.max(1, Math.round(age / 60_000))} min ago`;
  if (age < 6 * 3_600_000) return `${Math.round(age / 3_600_000)} h ago`;
  return `${new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
}

/** Who gets a bell: someone who is signed in, or anyone where sign-in isn't required. Nobody while that is still being found out. */
export function bellShownFor(auth: { authRequired: boolean; signedIn: boolean } | null): boolean {
  return auth !== null && (!auth.authRequired || auth.signedIn);
}

/** The errors in a fresh list that deserve a pop-up: unread, and not seen in an earlier list. The first list ever loaded is old news (`known` is null), so nothing pops up for it. Oldest first. */
export function newErrors(known: ReadonlySet<string> | null, items: NotificationItem[]): NotificationItem[] {
  if (known === null) return [];
  return items.filter((n) => n.severity === "error" && !n.read && !known.has(n.id)).reverse();
}

const linkLabel = (n: NotificationItem) => (n.link.includes("tab=positions") ? "View position" : "View log");

/** The list itself, with what can be done to it. Pure: the bell below supplies the data and the actions. */
export function NotificationPanel({
  items,
  unread,
  total,
  now,
  confirmClear,
  onOpen,
  onMarkRead,
  onMarkAll,
  onClear,
}: {
  items: NotificationItem[];
  unread: number;
  total: number;
  now: number;
  /** True while the Clear button is waiting for its second click. */
  confirmClear: boolean;
  onOpen: (n: NotificationItem) => void;
  onMarkRead: (id: string) => void;
  onMarkAll: () => void;
  onClear: () => void;
}) {
  return (
    <div role="dialog" aria-label="Notifications" className="w-full overflow-hidden rounded-xl border border-line bg-surface shadow-lg xl:w-[400px]">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="text-sm font-semibold">Notifications{unread > 0 && <span className="ml-2 text-xs font-medium text-down">{unread} unread</span>}</div>
        <div className="flex items-center gap-1">
          <button onClick={onMarkAll} disabled={unread === 0} className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40">
            Mark all read
          </button>
          <button onClick={onClear} disabled={total === 0} className={cn("rounded-md px-2 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-40", confirmClear ? "text-down" : "text-muted hover:text-fg")}>
            {confirmClear ? "Click again to clear" : "Clear"}
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">Nothing yet. Errors always show here; warnings and trades can be switched on in Settings.</p>
      ) : (
        <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
          {items.map((n) => (
            <li key={n.id} className={cn("flex gap-3 px-4 py-3", !n.read && "bg-accent/5")}>
              <span aria-hidden className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-accent")} />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={cn("rounded px-1.5 py-0.5 font-medium", SEVERITY_CLASS[n.severity])}>{SEVERITY_LABEL[n.severity]}</span>
                  <span className="text-muted">{n.botName}</span>
                  <span className="text-faint" title={new Date(n.createdAt).toISOString()}>
                    {formatWhen(n.createdAt, now)}
                  </span>
                  {n.repeats > 1 && <span className="text-faint">×{n.repeats}</span>}
                </div>
                <p className={cn("break-words text-sm", n.read ? "text-muted" : "font-medium")}>{n.message}</p>
                <div className="flex items-center gap-3 text-xs">
                  <Link href={n.link} onClick={() => onOpen(n)} className="font-medium text-accent hover:underline">
                    {linkLabel(n)}
                  </Link>
                  {!n.read && (
                    <button onClick={() => onMarkRead(n.id)} className="text-muted hover:text-fg">
                      Mark read
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Snapshot {
  notifications: NotificationItem[];
  unread: number;
  total: number;
}

export function NotificationBell() {
  const [snap, setSnap] = useState<Snapshot>({ notifications: [], unread: 0, total: 0 });
  const [open, setOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef<Set<string> | null>(null);
  const toastId = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  const toast = useCallback((text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, tone: "error", text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_MS);
  }, []);

  /** Takes in a fresh list; an error that has not been seen before pops up (the first list ever loaded is old news). */
  const take = useCallback(
    (next: Snapshot, announce: boolean) => {
      setSnap(next);
      setNow(Date.now());
      const known = seen.current;
      seen.current = new Set([...(known ?? []), ...next.notifications.map((n) => n.id)]);
      if (!announce) return;
      for (const n of newErrors(known, next.notifications)) toast(`${n.botName}: ${n.message}`);
    },
    [toast],
  );

  const load = useCallback(async () => {
    const res = await fetch("/api/automation/notifications", { cache: "no-store" });
    if (!res.ok) return; // not signed in, or the server is busy: the bell stays as it was, the next look tries again
    take((await res.json()) as Snapshot, true);
  }, [take]);
  usePolling(load, POLL_MS);

  const send = useCallback(
    async (method: "PATCH" | "DELETE", body: Record<string, unknown>) => {
      try {
        const res = await fetch("/api/automation/notifications", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (res.ok) take((await res.json()) as Snapshot, false);
      } catch {
        /* the list is unchanged; the person can try again */
      }
    },
    [take],
  );

  const markRead = (id: string) => {
    setSnap((s) => ({ ...s, unread: Math.max(0, s.unread - (s.notifications.find((n) => n.id === id && !n.read) ? 1 : 0)), notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)) }));
    void send("PATCH", { ids: [id] });
  };
  const markAll = () => {
    setSnap((s) => ({ ...s, unread: 0, notifications: s.notifications.map((n) => ({ ...n, read: true })) }));
    void send("PATCH", { all: true });
  };
  const clear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    setSnap({ notifications: [], unread: 0, total: 0 });
    void send("DELETE", { all: true });
  };

  useEffect(() => {
    if (!confirmClear) return;
    const id = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(id);
  }, [confirmClear]);

  // Closes on a click outside, or Escape.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  // The list: on a phone it spans the screen under the header; on a desktop it hangs from the bell.
  const count = snap.unread > 99 ? "99+" : String(snap.unread);
  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={snap.unread > 0 ? `Notifications, ${snap.unread} unread` : "Notifications"}
        aria-expanded={open}
        className="relative grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <IconBell width={18} height={18} />
        {snap.unread > 0 && <span className="absolute -right-0.5 -top-0.5 grid min-w-[18px] place-items-center rounded-full bg-down px-1 text-[10px] font-semibold leading-[18px] text-white">{count}</span>}
      </button>
      {open && (
        <div className="fixed inset-x-2 top-14 z-50 xl:absolute xl:inset-x-auto xl:right-0 xl:top-full xl:mt-2">
          <NotificationPanel items={snap.notifications} unread={snap.unread} total={snap.total} now={now} confirmClear={confirmClear} onOpen={(n) => { if (!n.read) markRead(n.id); setOpen(false); }} onMarkRead={markRead} onMarkAll={markAll} onClear={clear} />
        </div>
      )}
      <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
