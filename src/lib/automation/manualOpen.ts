import "server-only";
import { withBotLock } from "./botLock";
import { BTC_BOT_ID } from "./bots";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { isKilled } from "./bybitRisk";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { resolveHookPrice } from "./hookPrice";
import { requirePassingCheck, type LiveControlDeps } from "./liveControl";
import { readLiveSettings } from "./liveSettings";
import { activePositionsForBot } from "./safeguards";
import { sharedExecutor } from "./sharedExecutor";
import { botsStore, decisionsStore } from "./store";
import type { BrokerExecutor } from "./types";

/**
 * THE MANUAL "Open UP" / "Open DOWN" BUTTONS. One function for both pages; `botId` says which bot's page was clicked and the trade is opened on THAT bot only. It is never copied to the other
 * bot: the mirror (liveMirror.ts) runs from the webhook route only, and nothing here calls it.
 *
 * The trade goes through the very same engine as a TradingView signal (a signal of the bot's own, marked `manual`, then processSignal under the bot's lock), so every rule of a signal trade holds:
 * 0.001 BTC, the stop loss, take profit and breakeven lock set at Bybit by the unchanged executor, one position, the trades-a-day count, the daily loss limit, the kill switch.
 * The live bot adds: the one "Are you sure?" confirm, the live toggle ON, a live key, and an account check that passes right now. There is no entry retry for a manual open (entryRetry.ts).
 * A refusal always comes back as a sentence in plain words, never a code.
 */

export type ManualOpenResult = { ok: true; message: string; signalId: string } | { ok: false; status: number; error: string };

export interface ManualOpenDeps {
  executor: BrokerExecutor;
  /** The live price of the underlying, or null when there is none. */
  price: (underlying: string) => Promise<number | null>;
  now: () => number;
  live: LiveControlDeps | undefined;
}

const defaultDeps = (): ManualOpenDeps => ({ executor: sharedExecutor, price: (u) => resolveHookPrice(u, Date.now(), 3000), now: Date.now, live: undefined });
const refuse = (error: string, status = 409): ManualOpenResult => ({ ok: false, status, error });

export async function openByHand(botId: string, direction: unknown, options: { confirmed?: unknown } = {}, deps: ManualOpenDeps = defaultDeps()): Promise<ManualOpenResult> {
  try {
    if (botId !== BTC_BOT_ID && botId !== LIVE_BOT_ID) return refuse("Only the BTC bots have the Open UP and Open DOWN buttons.", 404);
    if (direction !== "up" && direction !== "down") return refuse('Send direction "up" or "down".', 400);
    const live = botId === LIVE_BOT_ID;
    if (live) {
      if (options.confirmed !== true) return refuse("Confirm that real money is involved to open a live trade.", 400);
      if (!readLiveSettings().enabled) return refuse("Live trading is OFF, so no live trade can be opened. Turn the Live trading toggle ON first.");
    }
    if (!botsStore.get(botId)) return refuse("This bot has no record yet, so it cannot open a trade.");
    if (isKilled(botId)) return refuse("The kill switch is on for this bot: no new trade can be opened. Turn it off first.");
    if (activePositionsForBot(botId).length > 0) return refuse("A trade is already running. Open UP and Open DOWN work only when no trade is running.");
    if (live) {
      const pre = await requirePassingCheck(deps.live);
      if (!pre.ok) return refuse(pre.error, pre.status);
    }
    const now = deps.now();
    const price = await deps.price("BTC");
    if (price === null || !Number.isFinite(price)) return refuse("There is no live BTC price right now, so nothing was sent. Try again in a moment.");
    const signalName = direction === "up" ? "bullish" : "bearish";
    const saved = receiveAndSaveSignal({
      botId,
      signal: signalName,
      price,
      barTime: `manual-${now}-${Math.random().toString(36).slice(2, 8)}`,
      interval: "manual",
      raw: { source: "manual", manualOpen: true, symbol: "BTC" },
      now,
    });
    await withBotLock(botId, () => processSignal(saved, { executor: deps.executor }));
    const decisions = decisionsStore.query((d) => d.signalId === saved.id);
    if (decisions.some((d) => d.outcome === "opened")) return { ok: true, signalId: saved.id, message: `Opened a ${direction === "up" ? "long (UP)" : "short (DOWN)"} trade${live ? " on the live account" : ""}.` };
    const why = decisions.filter((d) => d.reason).at(-1)?.reason;
    return refuse(why ? `Nothing was opened: ${why}` : "Nothing was opened. The Log says why.");
  } catch (err) {
    return refuse(`Nothing was opened: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}
