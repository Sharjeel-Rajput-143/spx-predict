import "server-only";
import crypto from "node:crypto";
import { ERROR_FAILSAFE_THRESHOLD } from "./config";
import { botsStore, errorsStore } from "./store";
import { botDisplayName, ensureBotRecord } from "./bots";
import { logDecision } from "./decisions";
import { easternDateKey } from "./tradingHours";

/** Inserts an error row tagged with today's America/New_York trading date,
 * then switches the bot off (needs attention) once that day's count reaches the
 * failsafe threshold, writing the reason to the bot log and raising an error alert.
 * Counting by trading date (rather than a stored counter) is what makes the count
 * start again the next trading day; the bot itself stays off until a person
 * switches it back on. */
export function recordError(botId: string, kind: string, detail: Record<string, unknown>, nowMs: number = Date.now()): void {
  const tradingDate = easternDateKey(nowMs);
  errorsStore.insert({
    id: `err-${nowMs}-${crypto.randomUUID()}`,
    botId,
    kind,
    detail,
    tradingDate,
    createdAt: nowMs,
  });

  const todayErrorCount = countTodayErrors(botId, nowMs);
  if (todayErrorCount >= ERROR_FAILSAFE_THRESHOLD) {
    const wasOn = ensureBotRecord(botId).enabled;
    botsStore.update(botId, {
      enabled: false,
      needsAttention: true,
      needsAttentionReason: `error_failsafe: ${todayErrorCount} errors today`,
    });
    // Said once, when the bot actually goes from on to off - not again for every later error.
    if (wasOn) {
      logDecision({
        signalId: null,
        botId,
        outcome: "error_failsafe",
        reason: `${botDisplayName(botId)} was switched off: ${todayErrorCount} errors in one trading day (the limit is ${ERROR_FAILSAFE_THRESHOLD}). The count starts again next trading day; switch the bot back on when you've checked it.`,
        detail: { errorsToday: todayErrorCount, threshold: ERROR_FAILSAFE_THRESHOLD, lastError: kind },
        now: nowMs,
      });
    }
  }
}

export function countTodayErrors(botId: string, nowMs: number = Date.now()): number {
  const tradingDate = easternDateKey(nowMs);
  return errorsStore.query((e) => e.botId === botId && e.tradingDate === tradingDate).length;
}
