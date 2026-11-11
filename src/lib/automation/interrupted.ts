import "server-only";
import { withBotLock } from "./botLock";
import { botDisplayName, listBotIds } from "./bots";
import { logDecision } from "./decisions";
import { describeLegs, typeName } from "./runTrace";
import { botsStore, decisionsStore, positionsStore, runsStore, signalsStore, webhooksStore } from "./store";
import type { Signal } from "./types";

/**
 * A signal's run saves its step-by-step record (a Run) when it ends, whatever the outcome. A signal that was accepted long ago
 * and has no Run means the run never finished: the server stopped or restarted partway. The case that matters most is a flip
 * that closed one side and never opened the other, because the bot would otherwise carry on as if nothing had happened.
 *
 * The bot doesn't open the missing side by itself: the price has moved on, and the next signal may already say otherwise. It says
 * so in the Log, raises an error alert, and marks the bot as needing attention.
 */

/** Longer than any real run (the flip's two fill waits come to a few minutes), so a slow run is never taken for a dead one. */
export const INTERRUPTED_AFTER_MS = 10 * 60_000;
/** How far back to look. */
const LOOKBACK_MS = 2 * 24 * 60 * 60_000;

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

function describe(signal: Signal): { reason: string; closedPositionId?: string } {
  const direction = signal.signal === "bullish" ? "bullish" : "bearish";
  const closed = positionsStore.query((p) => p.botId === signal.botId && p.closeSignalId === signal.id)[0];
  const opened = positionsStore.query((p) => p.botId === signal.botId && p.openSignalId === signal.id)[0];
  if (closed && !opened) {
    const wanted = direction === "bullish" ? "short_put_spread" : "short_call_spread";
    return {
      reason: `A flip was interrupted: the ${direction} signal of ${timeOf(signal.receivedAt)} closed ${describeLegs(closed)}, but the ${typeName(wanted)} was never opened (the server may have restarted). The bot has not opened it by itself. Check your positions, then open it by hand or wait for the next signal.`,
      closedPositionId: closed.id,
    };
  }
  return { reason: `The ${direction} signal of ${timeOf(signal.receivedAt)} was received but its run never finished (the server may have restarted). Check this bot's positions and orders.` };
}

/** Looks for runs that never finished and says so, once each. Returns how many it found. Quiet when there are none. */
export async function checkInterruptedRuns(now: number = Date.now()): Promise<number> {
  let found = 0;
  for (const botId of listBotIds()) {
    // Taken inside the bot's lock: a run that is only slow is still holding it, so it has finished (and saved its Run) by the time this looks.
    found += await withBotLock(botId, async () => {
      let n = 0;
      const candidates = signalsStore.query((s) => s.botId === botId && s.status === "accepted" && now - s.receivedAt >= INTERRUPTED_AFTER_MS && now - s.receivedAt <= LOOKBACK_MS);
      for (const signal of candidates) {
        if (runsStore.get(signal.id)) continue; // it finished
        if (decisionsStore.query((d) => d.signalId === signal.id && d.outcome === "run_interrupted").length > 0) continue; // already said
        const { reason, closedPositionId } = describe(signal);
        logDecision({ signalId: signal.id, botId, outcome: "run_interrupted", reason: `${botDisplayName(botId)}: ${reason}`, detail: { receivedAt: signal.receivedAt, ...(closedPositionId ? { closedPositionId } : {}) }, now });
        botsStore.update(botId, { needsAttention: true, needsAttentionReason: reason });
        n++;
      }

      // A call that was answered but never reached the engine: the webhook's minute was taken and saved, and no signal followed (the
      // server stopped between the answer and the signal being saved). Without this such a call would vanish without a trace.
      for (const hook of webhooksStore.query((w) => w.botId === botId && w.lastTriggeredAt !== null)) {
        const claimedAt = hook.lastTriggeredAt!;
        if (now - claimedAt < INTERRUPTED_AFTER_MS || now - claimedAt > LOOKBACK_MS) continue;
        // Any bot's signal counts: a webhook that was moved to another bot answered its earlier calls under the bot it was on then, and those calls did reach an engine.
        const followed = signalsStore.query((s) => s.signal === hook.direction && s.receivedAt >= claimedAt - 1000 && (s.raw as { webhook?: string } | null)?.webhook === hook.name).length > 0;
        if (followed) continue;
        if (decisionsStore.query((d) => d.outcome === "run_interrupted" && d.detail?.webhookId === hook.id && d.detail?.claimedAt === claimedAt).length > 0) continue;
        const reason = `The ${hook.direction} webhook "${hook.name}" was called at ${timeOf(claimedAt)} and answered, but the call never reached the bot (the server may have stopped just after answering). Nothing was opened or closed for it. Check your positions; the next signal will run as usual.`;
        logDecision({ signalId: null, botId, outcome: "run_interrupted", reason: `${botDisplayName(botId)}: ${reason}`, detail: { webhookId: hook.id, claimedAt }, now });
        botsStore.update(botId, { needsAttention: true, needsAttentionReason: reason });
        n++;
      }
      return n;
    });
  }
  return found;
}
