import "server-only";
import { __resetSweepState } from "./eodSweep";
import { botsStore, decisionsStore, errorsStore, ordersStore, positionsStore, runsStore, signalsStore } from "./store";

/** What "Reset test data" removes. Bots, their settings and their on/off
 * state are kept - only what the engine recorded is cleared. */
export interface ResetSummary {
  signals: number;
  positions: number;
  orders: number;
  decisions: number;
  runs: number;
  errors: number;
}

export function resetTestData(): ResetSummary {
  const all = () => true;
  const summary: ResetSummary = {
    signals: signalsStore.removeWhere(all),
    positions: positionsStore.removeWhere(all),
    orders: ordersStore.removeWhere(all),
    decisions: decisionsStore.removeWhere(all),
    runs: runsStore.removeWhere(all),
    errors: errorsStore.removeWhere(all),
  };
  // A bot flagged needs-attention because of a test run goes back to clean; the daily counter and log view restart.
  for (const bot of botsStore.all()) {
    botsStore.update(bot.id, { needsAttention: false, needsAttentionReason: null, dailyResetAt: undefined, logClearedAt: undefined });
  }
  __resetSweepState();
  return summary;
}
