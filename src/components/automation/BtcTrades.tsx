"use client";

import { useCallback, useMemo, useState } from "react";
import { Card } from "@/components/ui";
import type { BybitView, HistoryRow } from "@/lib/automation/bybitView";
import { HistoryTable, OpenTrade, Pager, TradeDetails, paginate, signedDollars, plTone, type Reply } from "./BybitPanel";
import { Modal } from "./bot/primitives";
import { cn } from "@/lib/format";
import { usePolling } from "./usePolling";

/**
 * The BTC Bybit Bot's trades as Positions and the Calendar show them: BTC prices (entry and exit as Bybit filled them), the result after fees as Bybit reports it, and how each
 * trade closed (stop loss, take profit, breakeven stop, flip...), all labelled as the Bybit demo account. The same numbers as the Bybit page, from the same read of Bybit.
 */

export const BTC_LABEL = "Bybit demo · BTC";
/** The live bot's page says LIVE, never demo or paper money. */
export const LIVE_LABEL = "Bybit LIVE · BTC";

/** Where a page reads its trades: the demo bot's page reads the DEMO account's view, the live bot's page reads the LIVE account's view. Never the other one. */
export const bybitReplyUrl = (live: boolean): string => (live ? "/api/automation/live/trades" : "/api/automation/bybit");

/** The trades the bot itself opened (a trade placed by hand at Bybit is on the Bybit page, not among the bot's positions). */
export const botTrades = (v: BybitView): HistoryRow[] => v.history.filter((r) => r.byBot);

/** Net result per New York day, for the trades the bot opened. */
export function resultsByDay(rows: readonly HistoryRow[]): Map<string, { pnl: number; trades: number }> {
  const days = new Map<string, { pnl: number; trades: number }>();
  for (const r of rows) {
    if (!r.closedAt) continue;
    const key = new Date(r.closedAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const d = days.get(key) ?? { pnl: 0, trades: 0 };
    d.pnl = Math.round((d.pnl + r.pnl) * 100) / 100;
    d.trades += 1;
    days.set(key, d);
  }
  return days;
}

/** Polls the Bybit page's data. `reply` is null until the first answer; `active` false when Bybit is not the broker. */
export function useBybitReply(everyMs = 5000, live = false): { reply: Reply | null; error: string | null } {
  const [reply, setReply] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      fetch(bybitReplyUrl(live))
        .then((r) => {
          if (!r.ok) throw new Error(r.status === 401 ? "Session expired - refresh the page to sign in again." : "Could not read Bybit.");
          return r.json();
        })
        .then((json: Reply) => {
          setReply(json);
          setError(null);
        })
        .catch((err) => setError(err.message)),
    [live],
  );
  usePolling(load, everyMs);
  return { reply, error };
}

/** Positions: the BTC Bybit Bot's open trade and its closed trades. `live`: the LIVE bot's page, which reads the live account only. */
export function BtcTrades({ live = false }: { live?: boolean }) {
  const { reply, error } = useBybitReply(5000, live);
  return <BtcTradesBody reply={reply} error={error} live={live} />;
}

/** What the Positions tab shows for a given answer. Split from the hook so it can be tested without a network. */
export function BtcTradesBody({ reply, error, live = false }: { reply: Reply | null; error: string | null; live?: boolean }) {
  if (!reply) return error ? <Card className="p-4 text-sm text-down">{error}</Card> : null;
  if (live && (reply.noKey || !reply.active)) {
    return (
      <Card className="p-4">
        <h2 className="text-sm font-semibold">Live bot trades</h2>
        <p className="mt-1 text-sm text-muted" data-testid="live-no-trades">No live trades yet.{reply.noKey ? " There is no live key, so nothing can trade on the live account." : ""}</p>
      </Card>
    );
  }
  if (!reply.active || !reply.view) return live ? <Card className="p-4 text-sm text-muted">No live trades yet. {reply.error ?? ""}</Card> : null;
  return <BtcTradesView v={reply.view} refreshFailed={error !== null} live={live} />;
}

export function BtcTradesView({ v, refreshFailed = false, initialPage = 1, live = false }: { v: BybitView; refreshFailed?: boolean; initialPage?: number; live?: boolean }) {
  const label = live ? LIVE_LABEL : BTC_LABEL;
  const rows = useMemo(() => botTrades(v), [v]);
  const [page, setPage] = useState(initialPage);
  const [selected, setSelected] = useState<string | null>(null);
  const paged = paginate(rows, page);
  const chosen = selected ? (rows.find((r) => r.orderId === selected) ?? null) : null;
  const total = Math.round(rows.reduce((s, r) => s + r.pnl, 0) * 100) / 100;
  return (
    <Card className="overflow-hidden" data-testid="btc-trades">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{live ? "Live bot trades" : "BTC Bybit Bot trades"}</h2>
          <p className="text-xs text-muted">
            {label} ({v.symbol}, {live ? "real money" : "paper money"}). BTC prices and results after fees, as Bybit reports them. These are not option spreads.
          </p>
        </div>
        <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">{label}</span>
      </div>
      {refreshFailed && <p className="px-4 pt-2 text-xs text-down">The last refresh failed; this may be a few seconds old.</p>}
      <div className="space-y-2 px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Open trade</h3>
        {v.openError ? (
          <p className="text-sm text-down">Bybit could not be read just now: {v.openError}</p>
        ) : v.open ? (
          <OpenTrade o={v.open} symbol={v.symbol} />
        ) : (
          <p className="text-sm text-muted" data-testid="btc-flat">
            No open trade. The Bybit {live ? "live" : "demo"} account is flat.
          </p>
        )}
      </div>
      <div className="border-t border-line px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Closed trades</h3>
          {rows.length > 0 && (
            <span className="text-xs text-muted">
              {rows.length} trade{rows.length === 1 ? "" : "s"}, total <span className={cn("font-semibold tabular", plTone(total))}>{signedDollars(total)}</span> after fees
            </span>
          )}
        </div>
        {v.historyError ? (
          <p className="text-sm text-down">Bybit's trade history could not be read just now: {v.historyError}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">{live ? "No live trades yet." : "No closed trades yet."}</p>
        ) : (
          <>
            <HistoryTable rows={paged.rows} onOpen={setSelected} />
            <Pager paged={paged} onPage={setPage} />
          </>
        )}
      </div>
      {chosen && (
        <Modal title="Trade details" onClose={() => setSelected(null)}>
          <TradeDetails r={chosen} symbol={v.symbol} />
        </Modal>
      )}
    </Card>
  );
}
