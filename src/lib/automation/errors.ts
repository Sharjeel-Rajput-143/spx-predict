import "server-only";
import crypto from "node:crypto";
import { ERROR_FAILSAFE_THRESHOLD } from "./config";
import { botsStore, errorsStore } from "./store";
import { ensureBotRecord } from "./bots";
import { easternDateKey } from "./tradingHours";

/** Inserts an error row tagged with today's America/New_York trading date,
 * then flips the bot off + needs_attention once that day's count reaches the
 * failsafe threshold. Counting by trading date (rather than a stored counter)
 * is what makes it reset automatically the next trading day. */
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
    ensureBotRecord(botId);
    botsStore.update(botId, {
      enabled: false,
      needsAttention: true,
      needsAttentionReason: `error_failsafe: ${todayErrorCount} errors today`,
    });
  }
}

export function countTodayErrors(botId: string, nowMs: number = Date.now()): number {
  const tradingDate = easternDateKey(nowMs);
  return errorsStore.query((e) => e.botId === botId && e.tradingDate === tradingDate).length;
}
