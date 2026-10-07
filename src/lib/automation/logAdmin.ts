import "server-only";
import { DEDUPE_WINDOW_SECONDS } from "./config";
import { isKnownBot } from "./bots";
import { decisionsStore, runsStore, signalsStore } from "./store";

/**
 * Removes one entry of a bot's Log from the records: the signal, what the engine decided about it and its step-by-step run
 * (or, for something done by hand, the decision and its run). Unlike "Clear log", which only hides, this deletes.
 *
 * The one entry that can't go is a signal still inside the duplicate-protection window: the engine remembers a signal for a
 * couple of minutes so a repeat of it is dropped, and deleting it would let the repeat through.
 */
export function deleteLogEntry(botId: string, entryKey: string, now: number = Date.now()): { removed: "signal" | "decision" } {
  if (!isKnownBot(botId)) throw new Error("Unknown bot.");

  const signal = signalsStore.get(entryKey);
  if (signal && signal.botId === botId) {
    if (now - signal.receivedAt < (DEDUPE_WINDOW_SECONDS + 60) * 1000) {
      throw new Error("This signal is too recent to delete: the bot still remembers it to drop a repeat. Try again in a few minutes.");
    }
    decisionsStore.removeWhere((d) => d.signalId === signal.id);
    runsStore.removeWhere((r) => r.id === signal.id);
    signalsStore.remove(signal.id);
    return { removed: "signal" };
  }

  const decision = decisionsStore.get(entryKey);
  if (decision && decision.botId === botId && decision.signalId === null) {
    const runId = String(decision.detail?.runId ?? "");
    if (runId) runsStore.remove(runId);
    decisionsStore.remove(decision.id);
    return { removed: "decision" };
  }
  throw new Error("Log entry not found.");
}
