import "server-only";
import { botDisplayName, ensureBotRecord, getBotLimits, getBotStaticConfig, isBuiltInBot, listBotIds, missingSettingsOf } from "./bots";
import { ERROR_FAILSAFE_THRESHOLD } from "./config";
import { countTodayErrors } from "./errors";
import { computeStats } from "./pnl";
import { activePositionsForBot, countTodayNewPositions, sumActiveAllocationRisk } from "./safeguards";
import { positionsStore } from "./store";
import type { BotStaticConfig } from "./types";

export interface BotSummary {
  id: string;
  name: string;
  mode: "paper";
  builtIn: boolean;
  enabled: boolean;
  archived: boolean;
  needsAttention: boolean;
  needsAttentionReason: string | null;
  configError: string | null;
  /** For a built-in bot: each required setting that is still unset, and why it matters. */
  missingSettings: { key: string; why: string }[] | null;
  group: string | null;
  tags: string[];
  accountId: string | null;
  closedPositions: number;
  activePositionCount: number;
  totalPositionLimit: number;
  newPositionsToday: number;
  dailyNewPositionLimit: number;
  errorCountToday: number;
  errorFailsafeThreshold: number;
  atRisk: number;
  allocation: number | null;
  /** Realized P/L from priced closes only; null while nothing is priced. */
  closedPL: number | null;
  closedPct: number | null;
  /** Unrealized change needs live option prices Phase 1 doesn't have. */
  change: null;
  changePct: null;
}

export function summarizeBot(id: string, now = Date.now()): BotSummary {
  let config: BotStaticConfig | null = null;
  let configError: string | null = null;
  let missingSettings: { key: string; why: string }[] | null = null;
  try {
    config = getBotStaticConfig(id);
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
    missingSettings = missingSettingsOf(err);
  }
  const record = ensureBotRecord(id);
  const limits = getBotLimits(id);
  const stats = computeStats(positionsStore.query((p) => p.botId === id));
  return {
    id,
    name: config?.name ?? record.name ?? record.draftInputs?.name ?? botDisplayName(id),
    mode: "paper",
    builtIn: isBuiltInBot(id),
    enabled: record.enabled,
    archived: !!record.archived,
    needsAttention: record.needsAttention,
    needsAttentionReason: record.needsAttentionReason,
    configError,
    missingSettings,
    group: record.group ?? null,
    tags: record.tags ?? [],
    accountId: config?.accountId ?? record.draftInputs?.accountId ?? null,
    closedPositions: stats.finished,
    activePositionCount: activePositionsForBot(id).length,
    totalPositionLimit: limits.totalPositionLimit,
    newPositionsToday: countTodayNewPositions(id, now, record.dailyResetAt),
    dailyNewPositionLimit: limits.dailyNewPositionLimit,
    errorCountToday: countTodayErrors(id, now),
    errorFailsafeThreshold: ERROR_FAILSAFE_THRESHOLD,
    atRisk: config ? sumActiveAllocationRisk(id, config.widthPoints, config.openingCreditEstimate) : 0,
    allocation: config?.allocationLimit ?? record.safeguards?.allocationLimit ?? record.draftInputs?.allocationLimit ?? null,
    closedPL: stats.closedPL,
    closedPct: stats.closedPL != null && config ? stats.closedPL / config.allocationLimit : null,
    change: null,
    changePct: null,
  };
}

export const summarizeAllBots = (now = Date.now()) => listBotIds().map((id) => summarizeBot(id, now));

/** Every account any bot trades on, for the New Bot account picker. */
export function listAccounts(): string[] {
  const accounts = new Set<string>(["paper-1"]);
  for (const b of summarizeAllBots()) if (b.accountId) accounts.add(b.accountId);
  return [...accounts].sort();
}
