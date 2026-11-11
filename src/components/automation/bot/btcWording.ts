import { BYBIT_UNDERLYING } from "@/lib/automation/executorKind";
import type { Decision, Position } from "@/lib/automation/types";

/**
 * Plain wording for the BTC Bybit Bot's pages. The bot keeps its trades in the same records as the option bots (a long is stored as a "short put spread", a
 * short as a "short call spread"), but nothing about a BTC trade is a spread, so the pages say long and short, and say how a trade ended in words. Display
 * only: nothing here is read by the engine.
 */

/** True for the bot that trades Bybit's BTC perpetual, from what its page was given. */
export const isBtcUnderlying = (underlying: string | null | undefined): boolean => underlying === BYBIT_UNDERLYING;

/** A trade the Bybit executor made. */
export const isBtcPosition = (p: Pick<Position, "venue">): boolean => p.venue === "bybit";

/** A long is stored as a short put spread (bullish), a short as a short call spread (bearish). */
export const btcSide = (type: Position["type"]): "long" | "short" => (type === "short_put_spread" ? "long" : "short");

/** "Long BTC" / "Short BTC": what the Overview's Type column says for a BTC trade instead of "Short put spread". */
export const btcTypeLabel = (type: Position["type"]): string => (btcSide(type) === "long" ? "Long BTC" : "Short BTC");

/** What the Overview's Legs column says for a BTC trade: there are no legs, it is one perpetual position. */
export const BTC_LEGS_LABEL = "BTCUSDT perpetual";

/** "Open long" / "Close short" for an order of a BTC trade (the Overview's Orders table); plain "Open" / "Close" when the trade is not known. */
export function btcOrderLabel(kind: "open" | "close", type: Position["type"] | null): string {
  const verb = kind === "open" ? "Open" : "Close";
  return type ? `${verb} ${btcSide(type)}` : verb;
}

/** How a trade ended, by the stored reason. The first four are the ones the bot itself produces most. */
export const HOW_CLOSED: Record<string, string> = {
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  breakeven_stop: "Breakeven stop",
  signal_flip: "Signal flip",
  breakeven_close: "Breakeven close",
  pullback_exit: "Pullback exit",
  chain_stop: "Chain stop",
  daily_limit: "Daily loss limit",
  kill_switch: "Kill switch",
  end_of_day: "End of day",
  liquidation: "Liquidation",
  closed_at_broker: "By hand at Bybit",
  manual: "By hand",
  exit_rule: "Exit rule",
  monitor: "Close monitor",
};

/** "Take profit" for take_profit; an unknown code is shown as words rather than hidden. */
export function howClosed(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return HOW_CLOSED[reason] ?? reason.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** What the Activity list says for a decision about a BTC trade: "Opened short", "Closed short, take profit", "Breakeven stop". */
export function btcActivity(decision: Pick<Decision, "outcome" | "reason">, position: Pick<Position, "type" | "closeReason">, outcomeLabel: string): { title: string; reason?: string } {
  const side = btcSide(position.type);
  if (decision.outcome === "opened") return { title: `Opened ${side}` };
  if (decision.outcome === "closed") {
    const how = howClosed(position.closeReason);
    return { title: `Closed ${side}${how ? `, ${how.toLowerCase()}` : ""}` };
  }
  // Anything else (a refusal, a breakeven move, a limit) keeps its own label and says why underneath.
  return { title: decision.outcome === "breakeven_stop" ? outcomeLabel : `${outcomeLabel}: ${side}`, reason: decision.reason };
}

/** The same in one line for the pop-up that appears when a new decision arrives. */
export function btcToastSuffix(decision: Pick<Decision, "outcome">, position: Pick<Position, "type">): string {
  return decision.outcome === "breakeven_stop" ? "" : ` - ${btcSide(position.type)}`;
}

/**
 * The name of a log entry the bot or Bybit made by themselves (no signal and no person behind it): by how it happened, not "Manual close" or "Manual position".
 * Null when it is not one of those, so the caller keeps its own naming. A close pressed by hand on the site carries `manual: true` and stays "Manual close".
 */
export function systemEntryLabel(decision: Pick<Decision, "outcome" | "detail">): string | null {
  const detail = decision.detail ?? {};
  if (detail.manual === true) return null;
  if (detail.stopWatchdog === true) return "Stop watchdog";
  if (decision.outcome === "breakeven_stop") return "Breakeven stop";
  if (typeof detail.closeReason === "string" && detail.closeReason) return howClosed(detail.closeReason);
  if (typeof detail.risk === "string" && detail.risk) return howClosed(detail.risk);
  if (decision.outcome === "executor_error" && detail.sync === true) return "Broker check";
  return null;
}
