import "server-only";
import { isBybitPosition, sumBybitRealizedToday } from "./bybitDay";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { BYBIT_UNDERLYING } from "./executorKind";
import { bybitExecutor, liveBybitExecutor } from "./sharedExecutor";
import { positionsStore } from "./store";

/**
 * What the bot page's Safeguards card shows for the bot that trades Bybit. The engine's own daily loss limit (DAILY_LOSS_LIMIT, for the option bots) is off for this
 * bot; the limit that really protects it is the Bybit executor's DAILY_MAX_LOSS_USD, counted on the bot's own trades after fees. The card used to show the engine's
 * figure ("Off") while the real limit was working, so it is now given the real one. Read only: this changes no limit and no rule.
 */
export interface BybitSafeguardsView {
  /** DAILY_MAX_LOSS_USD, in dollars. */
  limit: number;
  /** Today's realized result of the bot's Bybit trades, after fees (wins and losses together). */
  realized: number;
  closedToday: number;
}

/** The real limit and today's result, or null when this is not the Bybit bot or Bybit is not the broker (so the card shows the engine's figures as before). */
export function bybitSafeguards(botId: string, underlying: string | undefined, now: number): BybitSafeguardsView | null {
  if (underlying !== BYBIT_UNDERLYING) return null;
  let bybit: ReturnType<typeof bybitExecutor>;
  try {
    bybit = botId === LIVE_BOT_ID ? liveBybitExecutor() : bybitExecutor();
  } catch {
    return null; // a display must never break the page
  }
  if (!bybit) return null;
  const mine = positionsStore.query((p) => p.botId === botId && isBybitPosition(p));
  return { limit: bybit.dailyMaxLossUsd, ...sumBybitRealizedToday(mine, now, bybit.positionSize) };
}
