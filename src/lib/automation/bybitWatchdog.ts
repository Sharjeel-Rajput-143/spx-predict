import "server-only";
import { WATCHDOG_INTERVAL_MS } from "./bybitExecutor";
import { getBotStaticConfig, listBotIds } from "./bots";
import { isDryRun } from "./config";
import { recordEntryProtected, recordUnprotected } from "./ledger";
import { logDecision } from "./decisions";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { BYBIT_UNDERLYING } from "./executorKind";
import { bybitExecutor } from "./sharedExecutor";
import { botsStore, positionsStore } from "./store";

/**
 * The stop-loss watchdog's connection to the app. The watchdog itself is BybitExecutor.watchdogStep (it needs only the Bybit account, not the bot's records, so ANY
 * position at Bybit is in scope); this file runs it every WATCHDOG_INTERVAL_MS (1.5 seconds, started with the server, see eodSweep.ts) and turns its alarms into what a
 * person sees:
 *   - a line in the BTC bot's Log (an "executor error" for a problem, which also rings the bell; "position resolved" when it is over),
 *   - the bot's red "needs attention" banner with the sentence in it.
 * It takes no bot lock: a signal that is being worked on must never delay a stop check, and every action the watchdog takes (setting a stop, a reduce-only close) is
 * safe next to the engine's own.
 */

export { WATCHDOG_INTERVAL_MS };

/** The bots that trade the Bybit BTC perpetual: where the alarms are written. */
export function btcBotIds(): string[] {
  // The live bot trades the same instrument but a different account: its alarms are the live watchdog's (bybitLiveWatchdog.ts), never the demo one's.
  return listBotIds().filter((id) => {
    if (id === LIVE_BOT_ID) return false;
    try {
      return getBotStaticConfig(id).underlying === BYBIT_UNDERLYING;
    } catch {
      return false;
    }
  });
}

/** True when the bot's own records say a Bybit position is held (open, being opened or being closed). */
export const hasRecordedBybitPosition = (): boolean => positionsStore.query((p) => p.venue === "bybit" && p.botId !== LIVE_BOT_ID && (p.status === "open" || p.status === "opening" || p.status === "closing")).length > 0;

export function raiseStopAlarm(alarm: { kind: "stop_problem" | "unreachable" | "resolved"; text: string }, now: number = Date.now()): void {
  // The ledger keeps every unprotected moment: it is what resets the live gate's clean-trade count. It never throws.
  recordUnprotected(alarm, now);
  const ids = btcBotIds();
  if (ids.length === 0) {
    console.error(`[bybit] STOP ALARM (${alarm.kind}) but no BTC bot to write it to: ${alarm.text}`);
    return;
  }
  for (const botId of ids) {
    if (alarm.kind === "resolved") {
      logDecision({ signalId: null, botId, outcome: "position_resolved", reason: `Stop watchdog: ${alarm.text}`, detail: { stopWatchdog: true, kind: alarm.kind }, now });
      continue;
    }
    const reason = `STOP LOSS ALARM: ${alarm.text}`;
    logDecision({ signalId: null, botId, outcome: "executor_error", reason, detail: { stopWatchdog: true, kind: alarm.kind }, now });
    botsStore.update(botId, { needsAttention: true, needsAttentionReason: reason });
  }
}

/** One look at the account. Quiet when Bybit is not the broker. Never throws. */
export async function watchdogTick(now: number = Date.now()): Promise<string | null> {
  if (isDryRun()) return null;
  const bybit = bybitExecutor();
  if (!bybit) return null;
  bybit.onAlarm ??= (a) => raiseStopAlarm(a);
  bybit.exposedHint ??= hasRecordedBybitPosition;
  bybit.onEntryProtected ??= recordEntryProtected;
  try {
    const r = await bybit.watchdogStep(now);
    if (r.startup && r.text) console.info(`[bybit] ${r.text}`);
    return r.state;
  } catch (err) {
    console.error("[bybit] stop-loss watchdog failed", err);
    return null;
  }
}
