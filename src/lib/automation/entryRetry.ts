import "server-only";
import { withBotLock } from "./botLock";
import { botDisplayName, getBotStaticConfig, listBotIds } from "./bots";
import { isDryRun } from "./config";
import { logDecision } from "./decisions";
import { processSignal, receiveAndSaveSignal, type ProcessSignalOptions } from "./engine";
import { resolveHookPrice } from "./hookPrice";
import { activePositionsForBot } from "./safeguards";
import { sharedExecutor } from "./sharedExecutor";
import { botsStore, decisionsStore, positionsStore, signalsStore } from "./store";
import { easternDateKey, hoursConfigFor, isWithinTradingHours } from "./tradingHours";
import type { BrokerExecutor, Signal, SignalDirection } from "./types";

/**
 * Retrying a missed open - Option Alpha's scanner looks for a trade to open every minute; this bot decides once, when an alert arrives,
 * so an alert whose open was dropped would otherwise wait for the next alert, which may be hours away. Once a minute this looks at each
 * bot and finishes what the last alert asked for, and only that.
 *
 * It tries again only when ALL of these hold:
 *  - the bot's latest real alert (not one of its own retries) came today;
 *  - what that alert's run ended with was a temporary reason: it came outside the trading window, the broker rejected the order, the
 *    order timed out unfilled, or no live price was there at the time;
 *  - no position was ever opened for that alert, and nothing is held on either side (a close that failed, or an order whose outcome is
 *    unknown, is never "fixed" by opening something);
 *  - the bot is on, the kill switch is off, it isn't flagged for a person, and its trigger for that direction is on;
 *  - it is inside the trading window now, and there is a fresh live price.
 * It never retries after an error whose outcome is unknown (the order may have reached the broker), stops after three failed orders,
 * and never opens anything an alert did not ask for. A retry is an ordinary run: every guard (limits, strikes, overlap, allocation,
 * the criteria on the Open step) is applied to it exactly as to an alert, and it is logged as "Retrying a missed open".
 */

/** What an alert's run can end with and still be worth trying again. */
const RETRYABLE = new Set(["outside_hours", "open_rejected", "open_timeout_no_fill", "no_live_price", "no_price"]);
/** The ones that mean the broker was asked and said no, or never answered: only a few of those. */
const FAILED_ORDERS = new Set(["open_rejected", "open_timeout_no_fill"]);
export const MAX_FAILED_ORDERS = 3;
const MAX_RETRIES_PER_ALERT = 30;
const MIN_GAP_MS = 60_000;

const isRetry = (s: Pick<Signal, "raw">) => (s.raw as { origin?: unknown } | null)?.origin === "retry";
const retryOf = (s: Pick<Signal, "raw">) => (s.raw as { retryOf?: unknown } | null)?.retryOf;

export interface EntryRetryOptions extends Partial<Omit<ProcessSignalOptions, "executor" | "now">> {
  executor?: BrokerExecutor;
  /** The underlying's live price, or null when there isn't a fresh one. Default: the app's live feed. */
  price?: (underlying: string) => Promise<number | null>;
}

export interface EntryRetryResult {
  botId: string;
  /** Why nothing was done, when nothing was. */
  skipped?: string;
  /** True when a retry was run (whatever it ended with, which is in the Log). */
  retried: boolean;
}

const HIDDEN = "nothing_to_retry";

type Plan =
  | { skipped: string }
  | { root: Signal; direction: SignalDirection; ended: string; attempt: number; underlying: string };

/** Everything that decides whether to retry, except the price. Reads only, so it is cheap to run twice. */
function plan(botId: string, now: number): Plan {
  const skip = (why: string): Plan => ({ skipped: why });

  // The bot's latest real alert: an accepted one, or one the webhook could not price at the time. Its own retries don't count.
  const real = signalsStore
    .query((s) => s.botId === botId && !isRetry(s) && (s.status === "accepted" || (s.status === "rejected" && s.rejectReason === "no_price")))
    .sort((a, b) => a.receivedAt - b.receivedAt);
  const root = real.at(-1);
  if (!root) return skip(HIDDEN);
  const direction = root.signal as SignalDirection;
  if (easternDateKey(root.receivedAt) !== easternDateKey(now)) return skip(HIDDEN);

  const retries = signalsStore.query((s) => s.botId === botId && isRetry(s) && retryOf(s) === root.id);
  const chain = new Set([root.id, ...retries.map((s) => s.id)]);

  // Something was opened for this alert at some point (or is half-way): done, or a person's to check.
  if (positionsStore.query((p) => p.openSignalId !== null && chain.has(p.openSignalId) && p.status !== "rejected").length > 0) return skip(HIDDEN);
  // Anything held on either side: a retry opens nothing next to it, and never stands in for a close.
  if (activePositionsForBot(botId).length > 0) return skip(HIDDEN);

  // How the alert's run ended: the last thing logged for it or its retries (not our own "retrying" notes).
  const logged = decisionsStore
    .query((d) => d.signalId !== null && chain.has(d.signalId) && d.outcome !== "entry_retry")
    .sort((a, b) => a.createdAt - b.createdAt);
  const ended = logged.at(-1)?.outcome ?? (root.status === "rejected" ? "no_price" : null);
  if (ended === null || !RETRYABLE.has(ended)) return skip(HIDDEN);
  if (logged.filter((d) => FAILED_ORDERS.has(d.outcome)).length >= MAX_FAILED_ORDERS) return skip("too_many_failed_orders");
  if (retries.length >= MAX_RETRIES_PER_ALERT) return skip("too_many_retries");

  // The bot must be in a state to trade by itself.
  const bot = botsStore.get(botId);
  if (!bot || !bot.enabled || bot.killSwitch || bot.needsAttention) return skip("bot_not_ready");
  if (bot.triggers && bot.triggers[direction] === false) return skip("trigger_off");
  if (isDryRun()) return skip("dry_run");
  let config;
  try {
    config = getBotStaticConfig(botId);
  } catch {
    return skip("not_set_up");
  }
  if (!isWithinTradingHours(now, hoursConfigFor(config.hours))) return skip("outside_hours");

  // At most one try a minute.
  const lastTry = Math.max(root.receivedAt, ...retries.map((s) => s.receivedAt));
  if (now - lastTry < MIN_GAP_MS) return skip("too_soon");

  return { root, direction, ended, attempt: retries.length + 1, underlying: config.underlying };
}

/**
 * One look at one bot. Quiet when there is nothing to do: it writes nothing unless it retries. The price is fetched with the bot's lock
 * NOT held (a lookup can take seconds, and a real alert must never wait behind it); everything is then checked again under the lock, and
 * the retry only goes ahead if nothing changed in between.
 */
export async function runEntryRetry(botId: string, now: number = Date.now(), options: EntryRetryOptions = {}): Promise<EntryRetryResult> {
  const first = await withBotLock(botId, async () => plan(botId, now));
  if ("skipped" in first) return { botId, skipped: first.skipped, retried: false };

  // A fresh live price is what the strikes are built from; none yet, and it waits for the next minute.
  const price = await (options.price ?? ((u: string) => resolveHookPrice(u, Date.now(), 3_000)))(first.underlying);
  if (price === null || !Number.isFinite(price) || price <= 0) return { botId, skipped: "no_price_yet", retried: false };

  return withBotLock(botId, async (): Promise<EntryRetryResult> => {
    const again = plan(botId, now);
    if ("skipped" in again) return { botId, skipped: again.skipped, retried: false };
    if (again.root.id !== first.root.id || again.attempt !== first.attempt) return { botId, skipped: "changed", retried: false };
    const { root, direction, ended, attempt } = again;
    const config = getBotStaticConfig(botId);
    const retry = receiveAndSaveSignal({
      botId,
      signal: direction,
      price,
      barTime: `retry-${root.id}-${attempt}`,
      interval: root.interval,
      raw: { origin: "retry", retryOf: root.id, symbol: config.underlying, ...(typeof (root.raw as { webhook?: unknown } | null)?.webhook === "string" ? { webhook: (root.raw as { webhook: string }).webhook } : {}) },
      now,
    });
    logDecision({
      signalId: retry.id,
      botId,
      outcome: "entry_retry",
      reason: `${botDisplayName(botId)}: retrying the ${direction} open that the alert at ${new Date(root.receivedAt).toISOString().slice(11, 16)} UTC asked for (it ended as "${ended}"). Attempt ${attempt}.`,
      detail: { retryOf: root.id, attempt, previous: ended, price },
      now,
    });
    await processSignal(retry, { executor: options.executor ?? sharedExecutor, now, ...options });
    return { botId, retried: true };
  });
}

/** Every bot, once. Called each minute by the scheduler on a server that stays up, and by /api/cron/scan from an outside scheduler. */
export async function runDueEntryRetries(now: number = Date.now(), options: EntryRetryOptions = {}): Promise<EntryRetryResult[]> {
  const results: EntryRetryResult[] = [];
  for (const botId of listBotIds()) {
    try {
      results.push(await runEntryRetry(botId, now, options));
    } catch (err) {
      console.error(`[automation] entry retry failed for ${botDisplayName(botId)}`, err);
    }
  }
  return results;
}
