import "server-only";
import crypto from "node:crypto";
import { decisionsStore } from "./store";
import type { DecisionOutcome } from "./types";

export function logDecision(params: {
  signalId: string | null;
  botId: string;
  outcome: DecisionOutcome;
  reason: string;
  detail?: Record<string, unknown>;
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  decisionsStore.insert({
    id: `dec-${now}-${crypto.randomUUID()}`,
    signalId: params.signalId,
    botId: params.botId,
    outcome: params.outcome,
    reason: params.reason,
    detail: params.detail ?? {},
    createdAt: now,
  });
}
