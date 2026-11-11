"use client";

import { useCallback, useState, type KeyboardEvent, type ReactNode } from "react";
import { Card } from "@/components/ui";
import { cn } from "@/lib/format";
import type { BybitView, HistoryRow, OpenTradeView } from "@/lib/automation/bybitView";
import { Modal } from "./bot/primitives";
import { usePolling } from "./usePolling";

const REFRESH_MS = 3000;
/** Trades shown per page in the history. */
export const PAGE_SIZE = 20;

/** "+$1.23" for a profit, "-$1.23" for a loss, "$0.00" for neither: a profit always has a plus sign and a loss a minus sign. */
export function signedDollars(n: number): string {
  const body = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}$${body}`;
}
/** "+0.30%" / "-0.30%". */
export const signedPercent = (n: number): string => `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n).toFixed(2)}%`;
/** Green for a profit, red for a loss. */
export const plTone = (n: number | null): string => (n === null ? "text-faint" : n > 0 ? "text-up" : n < 0 ? "text-down" : "text-fg");

const price = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

/** How a trade ended, in words, and whether the label is good news, bad news or neutral. */
export const CLOSED_BY: Record<string, { label: string; tone: "good" | "bad" | "neutral" }> = {
  signal_flip: { label: "Signal flip", tone: "neutral" },
  stop_loss: { label: "Stop loss", tone: "bad" },
  breakeven_stop: { label: "Breakeven stop", tone: "neutral" },
  breakeven_close: { label: "Breakeven close", tone: "neutral" },
  pullback_exit: { label: "Pullback exit", tone: "neutral" },
  chain_stop: { label: "Chain stop", tone: "neutral" },
  take_profit: { label: "Take profit", tone: "good" },
  daily_limit: { label: "Daily limit", tone: "bad" },
  kill_switch: { label: "Kill switch", tone: "bad" },
  end_of_day: { label: "End of day", tone: "neutral" },
  manual: { label: "Close position button", tone: "neutral" },
  exit_rule: { label: "Exit rule", tone: "neutral" },
  monitor: { label: "Close monitor", tone: "neutral" },
  liquidation: { label: "Liquidated", tone: "bad" },
  closed_at_broker: { label: "By hand at Bybit", tone: "neutral" },
};
/** One page of a list: the rows on it, which page that is (kept within the list), how many pages there are, and the numbers for "Showing 21-40 of 57". */
export function paginate<T>(rows: readonly T[], page: number, size: number = PAGE_SIZE): { rows: T[]; page: number; pages: number; from: number; to: number; total: number } {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const at = Math.min(Math.max(1, Math.floor(Number.isFinite(page) ? page : 1)), pages);
  const start = (at - 1) * size;
  return { rows: rows.slice(start, start + size), page: at, pages, from: total === 0 ? 0 : start + 1, to: Math.min(total, start + size), total };
}

/** The page numbers a pager shows: the first, the last, and a few around the current one, with null where numbers are skipped. */
export function pageWindow(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const out: (number | null)[] = [];
  let last = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - last > 1) out.push(null);
    out.push(n);
    last = n;
  }
  return out;
}

/** What each way of closing means, in a sentence, for the trade's details. */
export const CLOSED_BY_EXPLAINED: Record<string, string> = {
  signal_flip: "A confirmed signal for the other side arrived, so the bot closed this trade (reduce only) before opening the new side.",
  stop_loss: "Bybit's own stop loss fired: the price reached the stop, and Bybit closed the trade by itself, even if this site had been down.",
  breakeven_stop: "The trade had gone far enough into profit that the bot moved its stop loss to just past the entry price. The price then came back to that stop, and Bybit closed the trade by itself: a small result near zero instead of a full stop loss.",
  pullback_exit: "The trade was in profit and then its profit fell the set amount below its best (the pullback exit), so the bot closed it at market (reduce only). Its stop loss and take profit stayed at Bybit until the close filled.",
  chain_stop: "A chain trade lost the small set amount, so the bot closed it at market (reduce only). This tight stop is kept by the bot; Bybit's normal stop stayed under it.",
  breakeven_close: "The trade was in profit and the bot tried to move its stop to breakeven, but the price was already past that stop, so the bot closed the trade at market (reduce only) to keep the profit.",
  take_profit: "Bybit's own take profit fired: the price reached the target, and Bybit closed the trade by itself.",
  daily_limit: "The day's loss reached the daily loss limit, so the bot closed every open trade and blocked new ones for the rest of the day.",
  kill_switch: "The kill switch was turned on, so the bot closed the open trade and stopped all new orders.",
  end_of_day: "The end-of-day sweep closed it before the trading window ended.",
  manual: "Someone pressed Close position on this site.",
  exit_rule: "One of the trade's exit rules closed it.",
  monitor: "A close monitor closed it.",
  liquidation: "Bybit liquidated the position (the margin ran out).",
  closed_at_broker: "It was closed with an order placed at Bybit itself (by hand or by a script), not by this site's bot.",
};

/** "2 min 5 s", "1 h 3 min", "2 d 4 h". */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Kept for the older name. */
export const CLOSED_BY_LABEL: Record<string, string> = Object.fromEntries(Object.entries(CLOSED_BY).map(([k, v]) => [k, v.label]));

export interface Reply {
  active: boolean;
  view?: BybitView | null;
  error?: string;
  /** The live bot's reply when there is no live key: nothing was asked of Bybit. */
  noKey?: boolean;
  reason?: string;
}

/** What the Open UP / Open DOWN buttons need from their surroundings (the panel draws them; the container below talks to the server). */
export interface OpenControls {
  /** The live page: a click first asks "Are you sure? real money". The demo page opens at once. */
  live: boolean;
  busy: boolean;
  /** The last answer (the opened trade, or the refusal in plain words), or null. */
  message: { ok: boolean; text: string } | null;
  /** The direction waiting for its confirm click (live only), or null. */
  asking: "up" | "down" | null;
  onAsk(direction: "up" | "down"): void;
  onCancel(): void;
  onOpen(direction: "up" | "down"): void;
}

/** The Bybit page: the open trade live from Bybit, the day's numbers, and the trade history. Refreshes every few seconds. `live` is the LIVE account's twin of the page (real money, live data only). */
export function BybitPanel({ inactiveNote, live = false }: { inactiveNote?: string; live?: boolean } = {}) {
  const [reply, setReply] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [openBusy, setOpenBusy] = useState(false);
  const [openMessage, setOpenMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState<"up" | "down" | null>(null);

  const load = useCallback(() => {
    return fetch(live ? "/api/automation/live/trades" : "/api/automation/bybit")
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 401 ? "Session expired - refresh the page to sign in again." : "Failed to load the Bybit page.");
        return r.json();
      })
      .then((json: Reply) => {
        setReply(json);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [live]);
  usePolling(load, REFRESH_MS);

  const clear = useCallback(async () => {
    if (!window.confirm("Clear the trade history?\n\nThe list is hidden and the \"total since cleared\" starts again from $0.\nNothing is deleted at Bybit, and today's daily loss limit is NOT reset.")) return;
    setClearing(true);
    try {
      const r = await fetch("/api/automation/bybit/clear", { method: "POST" });
      if (!r.ok) setError(r.status === 401 ? "Session expired - refresh the page to sign in again." : "Could not clear the history.");
      await load();
    } finally {
      setClearing(false);
    }
  }, [load]);

  const resetToday = useCallback(async () => {
    if (!window.confirm("Reset today's figure?\n\n\"Today\" starts again from $0 (the open trade's live profit or loss still counts).\nNothing is deleted, and the DAILY LOSS LIMIT is not reset: it is counted on the bot's own trades.")) return;
    setResetting(true);
    try {
      const r = await fetch("/api/automation/bybit/reset-today", { method: "POST" });
      if (!r.ok) setError(r.status === 401 ? "Session expired - refresh the page to sign in again." : "Could not reset today's figure.");
      await load();
    } finally {
      setResetting(false);
    }
  }, [load]);

  /** One click opens a trade on THIS page's bot only. The live page sends the confirm it asked for. A refusal comes back as a sentence. */
  const openTrade = useCallback(
    async (direction: "up" | "down") => {
      setOpenBusy(true);
      setAsking(null);
      setOpenMessage(null);
      try {
        const r = await fetch(live ? "/api/automation/live/open" : "/api/automation/bybit/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(live ? { direction, confirm: true } : { direction }),
        });
        const json = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        setOpenMessage(r.ok ? { ok: true, text: json.message ?? "Opened." } : { ok: false, text: json.error ?? `The server answered ${r.status}.` });
        await load();
      } catch (err) {
        setOpenMessage({ ok: false, text: `The server could not be reached: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        setOpenBusy(false);
      }
    },
    [live, load],
  );

  if (error && !reply) return <Card className="p-4 text-sm text-down">{error}</Card>;
  if (!reply) return <Card className="p-4 text-sm text-muted">Loading Bybit...</Card>;
  if (reply.noKey) return <Card className="p-4 text-sm text-muted">There is no live key yet, so there are no live trades to show. {reply.reason ?? ""}</Card>;
  if (!reply.active) return inactiveNote ? <Card className="p-4 text-sm text-muted">{inactiveNote}</Card> : null;
  if (!reply.view) return <Card className="p-4 text-sm text-down">{reply.error ?? "The Bybit page has nothing to show."}</Card>;
  return (
    <BybitPanelView
      v={reply.view}
      live={live}
      refreshFailed={error !== null}
      onClear={live ? undefined : clear}
      clearing={clearing}
      onResetToday={live ? undefined : resetToday}
      resetting={resetting}
      openControls={{ live, busy: openBusy, message: openMessage, asking, onAsk: setAsking, onCancel: () => setAsking(null), onOpen: (d) => void openTrade(d) }}
    />
  );
}

/** The page itself, from a view (exported so it can be tested without a network). */
export function BybitPanelView({ v, live = false, openControls, refreshFailed = false, onClear, clearing = false, onResetToday, resetting = false, openOrderId = null, initialPage = 1 }: { live?: boolean; openControls?: OpenControls; v: BybitView; refreshFailed?: boolean; onClear?: () => void; clearing?: boolean; onResetToday?: () => void; resetting?: boolean; openOrderId?: string | null; initialPage?: number }) {
  const [selected, setSelected] = useState<string | null>(openOrderId);
  const [pageWanted, setPageWanted] = useState(initialPage);
  const paged = paginate(v.history, pageWanted);
  const chosen = selected ? (v.history.find((r) => r.orderId === selected) ?? null) : null;
  const t = v.totals;
  const used = t.limit > 0 ? Math.min(100, Math.max(0, ((t.limit - t.room) / t.limit) * 100)) : 0;
  const openPnl = v.open?.pnl ?? null;
  return (
    <div className="space-y-4">
      {/* Status strip: what this is, and what is switched on */}
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="bybit-status">
        {live ? <Chip tone="bad">Bybit LIVE account (real money)</Chip> : <Chip tone="accent">Bybit DEMO account (paper money)</Chip>}
        <Chip>{v.symbol} perpetual</Chip>
        <Chip>{v.positionSize} BTC per trade</Chip>
        <Chip>Trades {v.mode}</Chip>
        {v.killSwitch ? <Chip tone="bad">Kill switch ON: no new trades</Chip> : <Chip>Kill switch off</Chip>}
        {t.reached && <Chip tone="bad">Daily loss limit reached: no new trades today</Chip>}
        {v.pullback && (
          <span data-testid="bybit-pullback">
            <Chip>
              {v.pullback.enabled
                ? `Pullback exit ON: closes a trade when its profit falls ${money(v.pullback.fallUsd)} below its best, once that best is at least ${money(v.pullback.minPeakUsd)}${v.pullback.minPeakUsd === 0 ? " (no minimum)" : ""}`
                : "Pullback exit OFF"}
            </Chip>
          </span>
        )}
        <span className="ml-auto text-faint">updates every {REFRESH_MS / 1000} seconds{refreshFailed ? " - the last update failed" : ""}</span>
      </div>

      {/* The four numbers that matter */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="bybit-totals">
        <Stat label="Open trade profit / loss" hint="Live, from Bybit">
          {v.open ? <span className={cn("text-2xl font-semibold tabular", plTone(openPnl))}>{openPnl === null ? "—" : signedDollars(openPnl)}</span> : <span className="text-2xl font-semibold text-faint">No open trade</span>}
        </Stat>
        <Stat label="Today" hint={v.todayResetAt ? `Closed trades + the open one since ${when(v.todayResetAt)} (${t.day})` : `Closed trades + the open one (${t.day})`}>
          <span className={cn("text-2xl font-semibold tabular", plTone(v.historyTotals.todayResult))}>{signedDollars(v.historyTotals.todayResult)}</span>
          {onResetToday && (
            <button type="button" onClick={onResetToday} disabled={resetting} data-testid="reset-today" className="ml-3 align-middle text-xs font-medium text-accent hover:underline disabled:opacity-50">
              {resetting ? "Resetting..." : "Reset"}
            </button>
          )}
        </Stat>
        <Stat label="Total since cleared" hint={v.historyClearedAt ? `Since ${when(v.historyClearedAt)}` : "All trades in the history"}>
          <span className={cn("text-2xl font-semibold tabular", plTone(v.historyTotals.total))}>{signedDollars(v.historyTotals.total)}</span>
        </Stat>
        <Stat label="Daily loss limit" hint="Counted on the bot's own trades">
          <span className={cn("text-2xl font-semibold tabular", t.room <= 0 ? "text-down" : "text-fg")}>{money(t.room)}</span>
          <span className="ml-1 text-sm text-faint">left of {money(t.limit)}</span>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-2">
            <div className={cn("h-full", used >= 100 ? "bg-down" : used >= 66 ? "bg-amber-500" : "bg-up")} style={{ width: `${used}%` }} />
          </div>
        </Stat>
      </div>
      {t.reached && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">The daily loss limit is reached: open trades were closed and no new trade is made until the next day (New York date).</p>}

      {/* The open trade */}
      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-fg">Open trade</h2>
        {v.openError && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">Bybit could not be read just now, so the open trade is not shown: {v.openError}</p>}
        {v.mismatch && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-600">{v.mismatch}</p>}
        {v.open ? <OpenTrade o={v.open} symbol={v.symbol} /> : !v.openError && <p className="text-sm text-muted">No open trade. The account is flat and the bot is waiting for the next confirmed signal.</p>}
        {!v.open && !v.openError && openControls && <OpenByHand c={openControls} size={v.positionSize} symbol={v.symbol} />}
        {v.open && openControls?.message && <p className={cn("rounded-lg px-3 py-2 text-sm", openControls.message.ok ? "bg-up-soft text-up" : "bg-down-soft text-down")} data-testid="open-message">{openControls.message.text}</p>}
      </Card>

      {/* The history */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-fg">Trade history</h2>
            <p className="text-xs text-muted">
              Bybit&apos;s own list of closed trades on this account, newest first (the latest 100 it lists), profit and loss after fees.
              {v.historyClearedAt ? ` Cleared ${when(v.historyClearedAt)}.` : ""}
            </p>
          </div>
          {onClear && (
            <button type="button" onClick={onClear} disabled={clearing || v.history.length === 0} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50">
              {clearing ? "Clearing..." : "Clear history"}
            </button>
          )}
        </div>
        {v.historyError && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">Bybit&apos;s trade history could not be read just now: {v.historyError}</p>}
        {v.history.length > 0 && (
          <p className="text-xs text-faint">Click a trade for its details.</p>
        )}
        {v.history.length > 0 && (
          <p className="text-sm text-muted" data-testid="bybit-history-summary">
            All {v.historyTotals.count} {v.historyTotals.count === 1 ? "trade" : "trades"}: <span className="text-up">{v.historyTotals.wins} won</span>, <span className="text-down">{v.historyTotals.losses} lost</span>, total{" "}
            <span className={cn("font-semibold tabular", plTone(v.historyTotals.total))}>{signedDollars(v.historyTotals.total)}</span>
          </p>
        )}
        {v.history.length === 0 ? (
          !v.historyError && <p className="text-sm text-muted">{v.historyClearedAt ? "The history was cleared. New trades will appear here." : "No closed trades yet. A flip, a stop loss, a take profit or a close lands here."}</p>
        ) : (
          <>
            <HistoryTable rows={paged.rows} onOpen={setSelected} />
            <Pager paged={paged} onPage={setPageWanted} />
          </>
        )}
      </Card>
      {chosen && (
        <Modal title="Trade details" onClose={() => setSelected(null)}>
          <TradeDetails r={chosen} symbol={v.symbol} />
        </Modal>
      )}
    </div>
  );
}

/** The small "Manual" label on a trade that was opened with the Open UP / Open DOWN button. */
export function ManualPill() {
  return (
    <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted" data-testid="bybit-manual-pill" title="Opened by hand with the Open UP / Open DOWN button, not by a signal">
      Manual
    </span>
  );
}

/** The Open UP / Open DOWN buttons: shown only while no trade is running. The demo page opens at once; the live page asks one "Are you sure? real money" click first. */
export function OpenByHand({ c, size, symbol }: { c: OpenControls; size: number; symbol: string }) {
  const word = (d: "up" | "down") => (d === "up" ? "UP (long)" : "DOWN (short)");
  return (
    <div className="space-y-2 border-t border-line pt-3" data-testid="open-by-hand">
      <div className="text-xs font-medium uppercase tracking-wide text-faint">Open a trade by hand</div>
      <p className="text-xs text-muted">
        {c.live
          ? `Opens ${size} BTC of ${symbol} on the LIVE account with REAL money, with the same stop loss, take profit and rules as a signal trade. It works only while Live trading is ON.`
          : `Opens ${size} BTC of ${symbol} on the demo account at once (paper money), with the same stop loss, take profit and rules as a signal trade.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => (c.live ? c.onAsk("up") : c.onOpen("up"))} disabled={c.busy} data-testid="open-up" className="rounded-lg bg-up px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
          Open UP
        </button>
        <button type="button" onClick={() => (c.live ? c.onAsk("down") : c.onOpen("down"))} disabled={c.busy} data-testid="open-down" className="rounded-lg bg-down px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
          Open DOWN
        </button>
      </div>
      {c.live && c.asking && (
        <div className="rounded-lg border border-down bg-down-soft px-3 py-3 text-sm text-down" role="alertdialog" aria-label="Are you sure?" data-testid="open-confirm-box">
          <div className="font-semibold">Are you sure?</div>
          <p className="mt-1">This opens a {word(c.asking)} trade with REAL money on Bybit, right now. Real money can be lost. Size is {size} BTC, with a stop loss at Bybit.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => c.onOpen(c.asking!)} disabled={c.busy} data-testid="open-confirm" className="rounded-lg bg-down px-5 py-2 text-sm font-semibold text-white disabled:opacity-40">
              Yes, open {word(c.asking)}
            </button>
            <button type="button" onClick={c.onCancel} data-testid="open-cancel" className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-fg hover:bg-surface-2">
              No, do not open
            </button>
          </div>
        </div>
      )}
      {c.message && <p className={cn("rounded-lg px-3 py-2 text-sm", c.message.ok ? "bg-up-soft text-up" : "bg-down-soft text-down")} data-testid="open-message">{c.message.text}</p>}
    </div>
  );
}

export function OpenTrade({ o, symbol }: { o: OpenTradeView; symbol: string }) {
  const long = o.side === "Long";
  return (
    <div className="space-y-3" data-testid="bybit-open">
      <p className="text-sm text-fg">
        You are <span className={cn("font-semibold", long ? "text-up" : "text-down")}>{long ? "LONG" : "SHORT"}</span> {o.size} BTC of {symbol}
        {o.manual && <ManualPill />}
        {o.valueUsd !== null ? <span className="text-muted"> (worth about {money(o.valueUsd)})</span> : null}. {long ? "You make money if the price rises." : "You make money if the price falls."}
      </p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Field label="Entry price">{price(o.entryPrice)}</Field>
        <Field label="Price now">{price(o.currentPrice)}</Field>
        <Field label="Profit / loss now">
          <span className={cn("text-lg font-semibold tabular", plTone(o.pnl))} data-testid="bybit-open-pl">
            {o.pnl === null ? "—" : signedDollars(o.pnl)}
          </span>
          {o.pnlPercent !== null && <span className={cn("ml-2 text-xs tabular", plTone(o.pnlPercent))}>{signedPercent(o.pnlPercent)}</span>}
        </Field>
        <Field label="Size">{o.size} BTC</Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-down-soft px-3 py-2 text-sm">
          <div className="text-xs font-medium text-down">{o.breakeven ? "Stop loss: moved to breakeven (set at Bybit)" : "Stop loss (set at Bybit)"}</div>
          <div className="tabular text-fg">{o.stopLoss === null ? "none" : price(o.stopLoss)}</div>
          {o.breakeven && (
            <div className="text-xs text-muted" data-testid="bybit-breakeven">
              Moved to breakeven at {price(o.breakeven.price)} on {when(o.breakeven.at)}, because the trade went into profit.
            </div>
          )}
          <div className="text-xs text-muted">{o.ifStopLoss === null ? "" : `Bybit closes the trade by itself if the price gets there: ${signedDollars(o.ifStopLoss)}`}</div>
        </div>
        <div className="rounded-lg bg-up-soft px-3 py-2 text-sm">
          <div className="text-xs font-medium text-up">Take profit (set at Bybit)</div>
          <div className="tabular text-fg">{o.takeProfit === null ? "none" : price(o.takeProfit)}</div>
          <div className="text-xs text-muted">{o.ifTakeProfit === null ? "" : `Bybit closes the trade by itself if the price gets there: ${signedDollars(o.ifTakeProfit)}`}</div>
        </div>
      </div>
    </div>
  );
}

/** "Showing 21-40 of 57" with Previous, the page numbers and Next. Shown only when there is more than one page. */
export function Pager({ paged, onPage }: { paged: ReturnType<typeof paginate>; onPage: (page: number) => void }) {
  if (paged.pages <= 1) return paged.total > 0 ? <p className="text-xs text-faint" data-testid="bybit-pager">Showing all {paged.total}</p> : null;
  const btn = "rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1" data-testid="bybit-pager">
      <span className="text-sm text-muted">
        Showing {paged.from}-{paged.to} of {paged.total}
      </span>
      <nav className="flex items-center gap-1" aria-label="History pages">
        <button type="button" className={btn} disabled={paged.page <= 1} onClick={() => onPage(paged.page - 1)}>
          Previous
        </button>
        {pageWindow(paged.page, paged.pages).map((n, i) =>
          n === null ? (
            <span key={`gap-${i}`} className="px-1 text-faint">
              …
            </span>
          ) : (
            <button key={n} type="button" aria-current={n === paged.page ? "page" : undefined} className={cn(btn, n === paged.page && "border-accent bg-accent/10 text-accent")} onClick={() => onPage(n)}>
              {n}
            </button>
          ),
        )}
        <button type="button" className={btn} disabled={paged.page >= paged.pages} onClick={() => onPage(paged.page + 1)}>
          Next
        </button>
      </nav>
    </div>
  );
}

/** What a history row does when it is clicked, or when Enter or Space is pressed on it (so the keyboard works too). Anything else does nothing. */
export function rowOpeners(orderId: string, onOpen: (orderId: string) => void): { onClick: () => void; onKeyDown: (e: Pick<KeyboardEvent, "key" | "preventDefault">) => void } {
  return {
    onClick: () => onOpen(orderId),
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onOpen(orderId);
      }
    },
  };
}

export function HistoryTable({ rows, onOpen }: { rows: HistoryRow[]; onOpen: (orderId: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="bybit-history">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-faint">
            {["Closed", "Side", "Size", "Entry", "Exit", "Result", "How it closed"].map((h) => (
              <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const how = r.closedBy ? (CLOSED_BY[r.closedBy] ?? { label: r.closedBy, tone: "neutral" as const }) : null;
            return (
              <tr
                key={r.orderId}
                className="cursor-pointer border-t border-line transition-colors hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
                role="button"
                tabIndex={0}
                aria-label={`Show the details of this ${r.side} trade`}
                data-testid="bybit-history-row"
                {...rowOpeners(r.orderId, onOpen)}
                title={`Click for the details · Bybit order ${r.orderId}${r.fees !== null ? ` · fees $${r.fees.toFixed(4)}` : ""}${r.byBot ? " · opened by the bot" : " · not opened by the bot"}`}
              >
                <td className="whitespace-nowrap px-2 py-1.5">{r.closedAt ? when(r.closedAt) : "—"}</td>
                <td className={cn("px-2 py-1.5 font-medium", r.side === "Long" ? "text-up" : "text-down")}>
                  {r.side}
                  {r.manual && <ManualPill />}
                </td>
                <td className="px-2 py-1.5 tabular">{r.size} BTC</td>
                <td className="px-2 py-1.5 tabular">{price(r.entryPrice)}</td>
                <td className="px-2 py-1.5 tabular">{price(r.exitPrice)}</td>
                <td className={cn("whitespace-nowrap px-2 py-1.5 font-semibold tabular", plTone(r.pnl))}>
                  {signedDollars(r.pnl)}
                  {r.pnlPercent !== null && <span className="ml-1.5 text-xs font-normal">{signedPercent(r.pnlPercent)}</span>}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {how ? <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", how.tone === "good" ? "bg-up-soft text-up" : how.tone === "bad" ? "bg-down-soft text-down" : "bg-surface-2 text-muted")}>{how.label}</span> : <span className="text-faint">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The popup for one closed trade: what happened, how it closed and why, and where the result comes from. */
export function TradeDetails({ r, symbol }: { r: HistoryRow; symbol: string }) {
  const how = r.closedBy ? (CLOSED_BY[r.closedBy] ?? { label: r.closedBy, tone: "neutral" as const }) : null;
  const sign = r.side === "Long" ? 1 : -1;
  const moved = r.entryPrice !== null && r.exitPrice !== null ? (r.exitPrice - r.entryPrice) * sign : null;
  const movedPct = moved !== null && r.entryPrice ? (moved / r.entryPrice) * 100 : null;
  return (
    <div className="space-y-4" data-testid="bybit-trade-details">
      <div>
        <div className="text-sm text-muted">
          <span className={cn("font-semibold", r.side === "Long" ? "text-up" : "text-down")}>{r.side === "Long" ? "LONG" : "SHORT"}</span> {r.size} BTC of {symbol}
        </div>
        <div className={cn("text-3xl font-semibold tabular", plTone(r.pnl))}>
          {signedDollars(r.pnl)}
          {r.pnlPercent !== null && <span className="ml-2 text-base font-medium">{signedPercent(r.pnlPercent)}</span>}
        </div>
        <div className="text-xs text-faint">the final result, after fees, as Bybit reports it</div>
      </div>

      <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
        <div className="mb-0.5 flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">How it closed</span>
          {how && <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", how.tone === "good" ? "bg-up-soft text-up" : how.tone === "bad" ? "bg-down-soft text-down" : "bg-surface text-muted")}>{how.label}</span>}
        </div>
        <p className="text-fg">{r.closedBy ? (CLOSED_BY_EXPLAINED[r.closedBy] ?? "Closed.") : "Bybit's records no longer show how this one was closed."}</p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <Row label="Closed">{r.closedAt ? when(r.closedAt) : "—"}</Row>
        {r.openedAt !== null && <Row label="Opened">{when(r.openedAt)}</Row>}
        {r.openedAt !== null && r.closedAt ? <Row label="Held for">{durationText(r.closedAt - r.openedAt)}</Row> : null}
        <Row label="Entry price">{price(r.entryPrice)}</Row>
        <Row label="Exit price">{price(r.exitPrice)}</Row>
        {moved !== null && (
          <Row label="Price moved for you">
            <span className={plTone(moved)}>
              {moved > 0 ? "+" : moved < 0 ? "-" : ""}${Math.abs(moved).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} per BTC{movedPct !== null ? ` (${signedPercent(movedPct)})` : ""}
            </span>
          </Row>
        )}
        {r.entryValue !== null && <Row label="Position value">{money(r.entryValue)} at entry{r.exitValue !== null ? `, ${money(r.exitValue)} at exit` : ""}</Row>}
        {r.leverage !== null && <Row label="Leverage">{r.leverage}x</Row>}
        <Row label="Profit before fees">
          <span className={plTone(r.grossPnl)}>{signedDollars(r.grossPnl)}</span>
        </Row>
        <Row label="Fees">{r.fees === null ? "—" : `-$${r.fees.toFixed(4)}${r.openFee !== null && r.closeFee !== null ? ` (opening $${r.openFee.toFixed(4)} + closing $${r.closeFee.toFixed(4)})` : ""}`}</Row>
        <Row label="Result after fees">
          <span className={cn("font-semibold", plTone(r.pnl))}>{signedDollars(r.pnl)}</span>
        </Row>
        <Row label="Opened by">{r.manual ? "Manual: the Open UP / Open DOWN button on this site" : r.byBot ? "This site's bot (a signal)" : "Not the bot (by hand or by a script at Bybit)"}</Row>
        <Row label="Bybit order id">
          <span className="break-all font-mono text-xs">{r.orderId}</span>
        </Row>
      </dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="tabular text-fg">{children}</dd>
    </>
  );
}

function Stat({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1">{children}</div>
      <div className="mt-1 text-xs text-faint">{hint}</div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-faint">{label}</div>
      <div className="tabular text-fg">{children}</div>
    </div>
  );
}

function Chip({ children, tone }: { children: ReactNode; tone?: "accent" | "bad" }) {
  return <span className={cn("rounded-full px-2.5 py-1 font-medium", tone === "accent" ? "bg-accent/10 text-accent" : tone === "bad" ? "bg-down-soft text-down" : "bg-surface-2 text-muted")}>{children}</span>;
}
