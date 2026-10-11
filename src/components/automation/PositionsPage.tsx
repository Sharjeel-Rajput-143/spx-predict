"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AutomationLogin } from "@/components/automation/AutomationLogin";
import { PositionsView } from "@/components/automation/bot/PositionsTab";
import { Toasts, type ToastItem } from "@/components/automation/bot/primitives";
import { Card } from "@/components/ui";
import { cn } from "@/lib/format";
import { ACTIVE_POSITION_STATUSES, type Order, type Position, type Signal } from "@/lib/automation/types";
import { usePolling } from "./usePolling";

interface PositionsData {
  now: number;
  bots: { id: string; name: string; estimate: number | null; accountId: string | null }[];
  positions: Position[];
  orders: Order[];
  signals: Signal[];
}

type Filter = "open" | "closed" | "expired" | "rejected";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
  { key: "expired", label: "Expired" },
  { key: "rejected", label: "Rejected" },
];

const matches = (p: Position, f: Filter) => (f === "open" ? ACTIVE_POSITION_STATUSES.includes(p.status) : p.status === f);
const POLL_MS = 5000;

/** Positions across every bot - the all-bots counterpart of a bot's own Positions tab. */
export function PositionsPage() {
  const [data, setData] = useState<PositionsData | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Set<Filter>>(new Set());
  const [botId, setBotId] = useState("all");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const notify = useCallback((tone: ToastItem["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const load = useCallback(() => {
    return fetch("/api/automation/positions")
      .then((r) => {
        if (r.status === 401) {
          setSignedOut(true);
          return null;
        }
        if (!r.ok) throw new Error("Failed to load.");
        return r.json();
      })
      .then((json: PositionsData | null) => {
        if (!json) return;
        setSignedOut(false);
        setData(json);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, []);

  usePolling(load, POLL_MS);

  const visible = useMemo(
    () =>
      (data?.positions ?? [])
        .filter((p) => botId === "all" || p.botId === botId)
        .filter((p) => active.size === 0 || [...active].some((f) => matches(p, f))),
    [data, active, botId],
  );

  if (signedOut) return <AutomationLogin next="/positions" />;
  if (error) return <Card className="p-4 text-sm text-down">{error}</Card>;
  if (!data) return <Card className="p-4 text-sm text-muted">Loading...</Card>;

  const byId = new Map(data.bots.map((b) => [b.id, b]));
  const toggle = (f: Filter) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Positions</h1>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            aria-pressed={active.has(key)}
            onClick={() => toggle(key)}
            className={cn(
              "rounded-lg border px-3.5 py-2 text-sm transition-colors",
              active.has(key) ? "border-accent bg-accent/10 text-accent" : "border-line bg-surface text-muted hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
        <select
          value={botId}
          onChange={(e) => setBotId(e.target.value)}
          aria-label="Bot"
          className="ml-auto rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-fg"
        >
          <option value="all">All bots</option>
          {data.bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      <PositionsView
        positions={visible}
        orders={data.orders}
        signals={data.signals}
        now={data.now}
        estimateFor={(id) => byId.get(id)?.estimate ?? undefined}
        botName={(id) => byId.get(id)?.name ?? id}
        botInfo={(id) => ({ id, name: byId.get(id)?.name ?? id, accountId: byId.get(id)?.accountId })}
        onChanged={load}
        notify={notify}
      />
      <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
