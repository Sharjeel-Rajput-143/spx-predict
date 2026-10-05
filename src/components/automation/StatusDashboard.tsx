"use client";

import { useCallback, useEffect, useState } from "react";
import { cn, formatTime } from "@/lib/format";
import { Card, SectionTitle, Stat } from "@/components/ui";

interface BotSummary {
  id: string;
  name: string;
  enabled: boolean;
  needsAttention: boolean;
  needsAttentionReason: string | null;
  configError: string | null;
  errorCountToday: number;
  errorFailsafeThreshold: number;
  newPositionsToday: number;
  dailyNewPositionLimit: number;
  activePositionCount: number;
  totalPositionLimit: number;
}

interface PositionRow {
  id: string;
  botId: string;
  type: string;
  status: string;
  shortStrike: number;
  longStrike: number;
  requestedQuantity: number;
  filledQuantity: number;
  expiry: string;
}

interface DecisionRow {
  id: string;
  botId: string;
  outcome: string;
  reason: string;
  createdAt: number;
}

interface SignalRow {
  id: string;
  botId: string;
  signal: string;
  status: string;
  rejectReason?: string;
  receivedAt: number;
}

interface StatusResponse {
  bots: BotSummary[];
  activePositions: PositionRow[];
  decisions: DecisionRow[];
  signals: SignalRow[];
}

const POLL_MS = 5000;

export function StatusDashboard() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/automation/status")
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 401 ? "Session expired - refresh the page to sign in again." : "Failed to load.");
        return r.json();
      })
      .then((json: StatusResponse) => {
        setData(json);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const toggleBot = (botId: string) => {
    setPending(botId);
    fetch(`/api/automation/bots/${botId}/toggle`, { method: "POST" })
      .then(load)
      .finally(() => setPending(null));
  };

  if (error) return <Card className="p-4 text-sm text-down">{error}</Card>;
  if (!data) return <Card className="p-4 text-sm text-muted">Loading...</Card>;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data.bots.map((bot) => (
          <Card key={bot.id} className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">{bot.name}</div>
                <div className="text-xs text-faint">{bot.id}</div>
              </div>
              <button
                onClick={() => toggleBot(bot.id)}
                disabled={pending === bot.id}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  bot.enabled ? "bg-up-soft text-up" : "bg-surface-2 text-muted",
                )}
              >
                {bot.enabled ? "On" : "Off"} - click to {bot.enabled ? "disable" : "enable"}
              </button>
            </div>

            {bot.configError && (
              <div className="rounded-lg bg-down-soft px-3 py-2 text-xs text-down">{bot.configError}</div>
            )}
            {bot.needsAttention && (
              <div className="rounded-lg bg-down-soft px-3 py-2 text-xs text-down">
                Needs attention{bot.needsAttentionReason ? `: ${bot.needsAttentionReason}` : ""}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <Stat label="Positions" value={`${bot.activePositionCount}/${bot.totalPositionLimit}`} />
              <Stat label="New today" value={`${bot.newPositionsToday}/${bot.dailyNewPositionLimit}`} />
              <Stat label="Errors today" value={`${bot.errorCountToday}/${bot.errorFailsafeThreshold}`} />
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-4">
        <SectionTitle>Active positions</SectionTitle>
        {data.activePositions.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <Table
            headers={["Bot", "Type", "Status", "Strikes", "Qty", "Expiry"]}
            rows={data.activePositions.map((p) => [
              p.botId,
              p.type,
              p.status,
              `${p.shortStrike}/${p.longStrike}`,
              `${p.filledQuantity}/${p.requestedQuantity}`,
              p.expiry,
            ])}
          />
        )}
      </Card>

      <Card className="p-4">
        <SectionTitle>Last 50 decisions</SectionTitle>
        {data.decisions.length === 0 ? (
          <p className="text-sm text-muted">None yet.</p>
        ) : (
          <Table
            headers={["Time", "Bot", "Outcome", "Reason"]}
            rows={data.decisions.map((d) => [formatTime(d.createdAt), d.botId, d.outcome, d.reason])}
          />
        )}
      </Card>

      <Card className="p-4">
        <SectionTitle>Last 50 signals received</SectionTitle>
        {data.signals.length === 0 ? (
          <p className="text-sm text-muted">None yet.</p>
        ) : (
          <Table
            headers={["Time", "Bot", "Signal", "Status"]}
            rows={data.signals.map((s) => [
              formatTime(s.receivedAt),
              s.botId,
              s.signal,
              s.status === "rejected" ? `rejected (${s.rejectReason})` : s.status,
            ])}
          />
        )}
      </Card>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-faint">
            {headers.map((h) => (
              <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-line">
              {row.map((cell, j) => (
                <td key={j} className="whitespace-nowrap px-2 py-1.5 text-fg">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
