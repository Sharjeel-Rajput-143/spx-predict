import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { BYBIT_UNDERLYING } from "./executorKind";
import "server-only";
import { getBotStaticConfig, listBotIds } from "./bots";
import { closedTrades, dayStatus, isBybitPosition, type ClosedTradeRow, type DayStatus } from "./bybitDay";
import type { BybitClosedTrade, BybitExecutor } from "./bybitExecutor";
import { isKilled } from "./bybitRisk";
import { botsStore, positionsStore, signalsStore } from "./store";
import { pullbackSettings } from "./pullbackExit";
import { easternDateKey } from "./tradingHours";

/**
 * What the Bybit page on the site shows, worked out in one place so the page and the tests agree. The open trade is read straight from Bybit's position data
 * (side, entry, mark price, size, unrealised profit or loss, the stops), so what the site shows is what Bybit shows. The trade history is Bybit's own list of closed
 * trades (its closed-pnl records: every trade on the account, net of fees) with how each one closed. The daily-loss-limit figures come from the bot's own records,
 * because that is what the limit is enforced on.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface OpenTradeView {
  side: "Long" | "Short";
  size: number;
  /** Bybit's average entry price. */
  entryPrice: number | null;
  /** Bybit's mark price. */
  currentPrice: number | null;
  /** Bybit's unrealised profit or loss, in dollars. */
  pnl: number | null;
  /** The same as a percent of the entry value. */
  pnlPercent: number | null;
  /** What the position is worth at the mark price, in dollars. */
  valueUsd: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** What the trade would make or lose, in dollars, if Bybit's stop loss / take profit fires at its price. */
  ifStopLoss: number | null;
  ifTakeProfit: number | null;
  /** Set once the stop loss was moved to breakeven: where, and when. Null until then (and when breakeven is off). */
  breakeven: { price: number; at: number } | null;
  /** The trade was opened with the Open UP / Open DOWN button, not by a signal. */
  manual: boolean;
}

export interface HistoryRow {
  orderId: string;
  side: "Long" | "Short";
  size: number;
  entryPrice: number | null;
  exitPrice: number | null;
  /** Bybit's closed profit and loss, net of fees. */
  pnl: number;
  pnlPercent: number | null;
  fees: number | null;
  openFee: number | null;
  closeFee: number | null;
  /** The profit or loss before fees (the result plus the fees). */
  grossPnl: number;
  leverage: number | null;
  entryValue: number | null;
  exitValue: number | null;
  /** When the bot opened the trade, when it recorded it (null for a trade the bot did not open). */
  openedAt: number | null;
  /** signal_flip, stop_loss, take_profit, daily_limit, kill_switch, closed_at_broker (by hand at Bybit), liquidation, ... or null when it can't be told. */
  closedBy: string | null;
  /** Whether the bot recorded this trade itself. */
  byBot: boolean;
  /** The trade was opened with the Open UP / Open DOWN button, not by a signal. */
  manual: boolean;
  closedAt: number;
}

export interface BybitView {
  symbol: string;
  positionSize: number;
  /** "24 hours a day, every day" or the window, for the header. */
  mode: string;
  killSwitch: boolean;
  /** The open trade at Bybit, or null when the account is flat. */
  open: OpenTradeView | null;
  /** Why Bybit's position could not be read right now (the panel then says so instead of showing stale numbers). */
  openError: string | null;
  /** Our records and the account disagree (a trade we think is open that Bybit does not hold, or the other way round). */
  mismatch: string | null;
  /** Every trade Bybit lists as closed since the history was last cleared, newest first. */
  history: HistoryRow[];
  historyError: string | null;
  /** When the history was last cleared, or null. */
  historyClearedAt: number | null;
  /** When "Reset today" was pressed today (the Today figure counts from then), else null. */
  todayResetAt: number | null;
  historyTotals: { count: number; wins: number; losses: number; total: number; todayResult: number };
  /** The bot's own closed trades (what the daily loss limit is counted on). */
  closed: ClosedTradeRow[];
  closedCount: number;
  totals: { day: string; dayResult: number; realizedToday: number; openLoss: number; running: number; limit: number; room: number; reached: boolean; tripped: boolean };
  /** The pullback exit rule in force for THIS bot (the demo bot's own on the demo page, the live bot's own on the live twin; null for any other bot). */
  pullback?: { enabled: boolean; fallUsd: number; minPeakUsd: number } | null;
  asOf: number;
}

/** Whether the trade was opened by the Open UP / Open DOWN button: its opening signal is marked `manualOpen` (manualOpen.ts). */
const openedByHand = (openSignalId: string | null | undefined): boolean => !!openSignalId && (signalsStore.get(openSignalId)?.raw as { manualOpen?: unknown } | null)?.manualOpen === true;

/** The bot whose orders go to this Bybit executor: the one on the underlying it trades. */
export function bybitBotId(bybit: Pick<BybitExecutor, "tradingWindowFor">): string | null {
  return (
    listBotIds().find((id) => {
      if (id === LIVE_BOT_ID) return false; // this page and executor are the demo ones
      try {
        return !!bybit.tradingWindowFor(getBotStaticConfig(id).underlying);
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** Hides the history so far from the list and restarts "total since cleared". Deletes nothing and never touches the daily loss limit. */
export function clearBybitHistory(botId: string, now: number = Date.now()): void {
  botsStore.update(botId, { bybitHistoryClearedAt: now });
  historyCache.delete(botId);
}

/** Restarts the "Today" figure on the Bybit page from now. Display only: nothing is deleted, and the daily loss limit (counted on the bot's own records) is not touched. */
export function resetBybitToday(botId: string, now: number = Date.now()): void {
  botsStore.update(botId, { bybitTodayResetAt: now });
  historyCache.delete(botId);
}

const historyCache = new Map<string, { at: number; trades: BybitClosedTrade[] | null; error: string | null }>();
const HISTORY_CACHE_MS = 10_000;

export async function buildBybitView(bybit: BybitExecutor, botId: string, symbol: string, now: number = Date.now(), options: { cacheHistory?: boolean } = {}): Promise<BybitView> {
  const unit = bybit.positionSize;
  let open: OpenTradeView | null = null;
  let openError: string | null = null;
  let heldSide: "Buy" | "Sell" | null = null;
  let openPnl: number | null = null;
  try {
    const held = await bybit.getAccountPosition();
    heldSide = held.side;
    if (held.side) {
      const sign = held.side === "Buy" ? 1 : -1;
      const entry = held.avgPrice;
      const value = entry !== null ? entry * held.size : null;
      open = {
        side: held.side === "Buy" ? "Long" : "Short",
        size: held.size,
        entryPrice: entry,
        currentPrice: held.markPrice,
        pnl: held.unrealisedPnl,
        pnlPercent: held.unrealisedPnl !== null && value ? round2((held.unrealisedPnl / value) * 100) : null,
        valueUsd: held.markPrice !== null ? round2(held.markPrice * held.size) : null,
        stopLoss: held.stopLoss,
        takeProfit: held.takeProfit,
        ifStopLoss: held.stopLoss !== null && entry !== null ? round2((held.stopLoss - entry) * held.size * sign) : null,
        ifTakeProfit: held.takeProfit !== null && entry !== null ? round2((held.takeProfit - entry) * held.size * sign) : null,
        breakeven: positionsStore.query((p) => p.botId === botId && isBybitPosition(p) && p.status === "open" && (p.type === "short_put_spread" ? "Buy" : "Sell") === held.side && !!p.breakevenStop)[0]?.breakevenStop ?? null,
        manual: positionsStore.query((p) => p.botId === botId && isBybitPosition(p) && p.status === "open").some((p) => openedByHand(p.openSignalId)),
      };
    }
    openPnl = held.unrealisedPnl;
  } catch (err) {
    openError = err instanceof Error ? err.message : String(err);
  }
  const ours = positionsStore.query((p) => p.botId === botId && isBybitPosition(p) && (p.status === "open" || p.status === "opening" || p.status === "closing"));
  let mismatch: string | null = null;
  if (!openError) {
    if (ours.length > 0 && heldSide === null) mismatch = "The bot has a trade open in its records that the Bybit account does not hold. It may have just been closed at Bybit; this clears itself within seconds.";
    else if (ours.length === 0 && heldSide !== null) mismatch = "This trade was not opened by the bot (it was placed by hand or by a script at Bybit). It is shown live from Bybit, and the bot will not open another trade until it is closed.";
  }

  // The history: Bybit's own closed trades, minus what was cleared.
  const clearedAt = botsStore.get(botId)?.bybitHistoryClearedAt ?? null;
  let trades: BybitClosedTrade[] | null = null;
  let historyError: string | null = null;
  const cached = options.cacheHistory ? historyCache.get(botId) : undefined;
  if (cached && now - cached.at < HISTORY_CACHE_MS) {
    trades = cached.trades;
    historyError = cached.error;
  } else {
    try {
      trades = await bybit.getClosedTrades(100);
    } catch (err) {
      historyError = err instanceof Error ? err.message : String(err);
    }
    if (options.cacheHistory) historyCache.set(botId, { at: now, trades, error: historyError });
  }
  const recorded = new Map(
    positionsStore
      // Only THIS bot's own records say which of Bybit's trades were the bot's (the demo page never claims a live trade, nor the live page a demo one). A live close
      // reference is "bybitlive-close-<id>", a demo one "bybit-close-<id>".
      .query((p) => p.botId === botId && isBybitPosition(p) && p.status === "closed" && !!p.brokerOrderRef)
      .map((p) => [p.brokerOrderRef!.replace(/^bybit(?:live)?-close-/, ""), p] as const),
  );
  const today = easternDateKey(now);
  const all = (trades ?? []).map((t): HistoryRow => {
    const record = recorded.get(t.orderId);
    const value = t.entryPrice !== null ? t.entryPrice * t.size : null;
    return {
      orderId: t.orderId,
      side: t.side,
      size: t.size,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      pnl: round2(t.pnl),
      pnlPercent: value ? round2((t.pnl / value) * 100) : null,
      fees: t.fees,
      openFee: t.openFee,
      closeFee: t.closeFee,
      grossPnl: round2(t.pnl + (t.fees ?? 0)),
      leverage: t.leverage,
      entryValue: t.entryValue,
      exitValue: t.exitValue,
      openedAt: record?.openedAt ?? null,
      closedBy: record?.closeReason ?? (t.kind === "user" ? "closed_at_broker" : t.kind),
      byBot: !!record,
      manual: !!record && openedByHand(record.openSignalId),
      closedAt: t.closedAt,
    };
  });
  const history = clearedAt === null ? all : all.filter((r) => r.closedAt > clearedAt);
  const todayResetAt = botsStore.get(botId)?.bybitTodayResetAt ?? null;
  const resetIsToday = todayResetAt !== null && easternDateKey(todayResetAt) === today;
  const todayClosed = all.filter((r) => easternDateKey(r.closedAt) === today && (!resetIsToday || r.closedAt > todayResetAt!)).reduce((s, r) => s + r.pnl, 0);
  const historyTotals = {
    count: history.length,
    wins: history.filter((r) => r.pnl > 0).length,
    losses: history.filter((r) => r.pnl < 0).length,
    total: round2(history.reduce((s, r) => s + r.pnl, 0)),
    todayResult: round2(todayClosed + (openPnl ?? 0)),
  };

  const status: DayStatus = dayStatus(botId, bybit.dailyMaxLossUsd, now, openPnl, unit);
  const { rows, runningTotal, count } = closedTrades(botId, unit);
  const window = bybit.tradingWindowFor(BYBIT_UNDERLYING);
  return {
    symbol,
    positionSize: unit,
    mode: bybit.alwaysOn ? "24 hours a day, every day" : window ? `${window.start} to ${window.end} New York time, Monday to Friday` : "trading window",
    killSwitch: isKilled(botId),
    open,
    openError,
    mismatch,
    history,
    historyError,
    historyClearedAt: clearedAt,
    todayResetAt: resetIsToday ? todayResetAt : null,
    historyTotals,
    closed: rows,
    closedCount: count,
    totals: {
      day: status.day,
      dayResult: round2(status.realized + (openPnl ?? 0)),
      realizedToday: status.realized,
      openLoss: status.openLoss,
      running: runningTotal,
      limit: status.limit,
      room: status.room,
      reached: status.reached,
      tripped: status.tripped,
    },
    pullback: (({ enabled, fallUsd, minPeakUsd }) => ({ enabled, fallUsd, minPeakUsd }))(pullbackSettings(botId)),
    asOf: now,
  };
}
