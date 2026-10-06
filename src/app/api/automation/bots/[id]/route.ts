import { NextRequest, NextResponse } from "next/server";
import { getGlobalWindow } from "@/lib/automation/appSettings";
import { botDisplayName, deleteBot, ensureBotRecord, getBotLimits, getBotStaticConfig, isBuiltInBot, isKnownBot, listBotIds, missingSettingsOf, updateBot, type BotPatch } from "@/lib/automation/bots";
import {
  CLOSE_CONFIRM_TIMEOUT_SECONDS,
  DEDUPE_WINDOW_SECONDS,
  ERROR_FAILSAFE_THRESHOLD,
  ORDER_FILL_TIMEOUT_SECONDS,
  TRADING_HOURS,
  getFlipCooldownSeconds,
  isDryRun,
} from "@/lib/automation/config";
import { countTodayErrors } from "@/lib/automation/errors";
import { computeStats } from "@/lib/automation/pnl";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { activePositionsForBot, countTodayNewPositions, sumActiveAllocationRisk } from "@/lib/automation/safeguards";
import { MOCK_PRICING_SIMULATED } from "@/lib/automation/sharedExecutor";
import { botsStore, decisionsStore, ordersStore, positionsStore, runsStore, signalsStore } from "@/lib/automation/store";
import { DEFAULT_ALERTS, type BotStaticConfig } from "@/lib/automation/types";

const LOG_LIMIT = 300;

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Everything the bot page shows, in one read-only payload. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  if (!isKnownBot(id)) return badRequest("Unknown bot.", 404);

  const now = Date.now();
  const record = ensureBotRecord(id);

  let config: BotStaticConfig | null = null;
  let configError: string | null = null;
  let missingSettings: { key: string; why: string }[] | null = null;
  try {
    config = getBotStaticConfig(id);
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
    missingSettings = missingSettingsOf(err);
  }

  const positions = positionsStore.query((p) => p.botId === id).sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
  const positionIds = new Set(positions.map((p) => p.id));
  const atRisk = config ? sumActiveAllocationRisk(id, config.widthPoints, config.openingCreditEstimate) : 0;
  const stats = computeStats(positions);
  const limits = getBotLimits(id);

  // Accounts and groups already in use, for the header dropdowns.
  const accounts = new Set<string>();
  const groups = new Set<string>();
  for (const botId of listBotIds()) {
    try {
      accounts.add(getBotStaticConfig(botId).accountId);
    } catch {
      // Waiting for its inputs: its account is in the placeholder, if it has one.
      const placeholder = botsStore.get(botId)?.draftInputs?.accountId;
      if (placeholder) accounts.add(placeholder);
    }
    const g = botsStore.get(botId)?.group;
    if (g) groups.add(g);
  }

  return NextResponse.json({
    now,
    bot: {
      id,
      name: config?.name ?? record.name ?? botDisplayName(id),
      builtIn: isBuiltInBot(id),
      enabled: record.enabled,
      killSwitch: !!record.killSwitch,
      archived: !!record.archived,
      needsAttention: record.needsAttention,
      needsAttentionReason: record.needsAttentionReason,
      configError,
      missingSettings,
      /** Present only while the bot is waiting for its trading inputs. */
      draft: record.config ? null : (record.draftInputs ?? null),
      accountId: config?.accountId ?? record.draftInputs?.accountId ?? null,
      allocation: config?.allocationLimit ?? record.safeguards?.allocationLimit ?? record.draftInputs?.allocationLimit ?? null,
      group: record.group ?? null,
      tags: record.tags ?? [],
      notes: record.notes ?? "",
      triggers: record.triggers ?? { bullish: true, bearish: true },
      alerts: { ...DEFAULT_ALERTS, ...record.alerts },
      safeguards: record.safeguards ?? {},
      logClearedAt: record.logClearedAt ?? 0,
      dailyResetAt: record.dailyResetAt ?? 0,
    },
    config,
    limits: {
      maxPositionsPerType: limits.maxPositionsPerType,
      dayTradingAllowed: limits.dayTradingAllowed,
      totalPositionLimit: limits.totalPositionLimit,
      dailyNewPositionLimit: limits.dailyNewPositionLimit,
      errorFailsafeThreshold: ERROR_FAILSAFE_THRESHOLD,
      dedupeWindowSeconds: DEDUPE_WINDOW_SECONDS,
      flipCooldownSeconds: getFlipCooldownSeconds(),
      orderFillTimeoutSeconds: ORDER_FILL_TIMEOUT_SECONDS,
      closeConfirmTimeoutSeconds: CLOSE_CONFIRM_TIMEOUT_SECONDS,
      hours: { start: clock(getGlobalWindow().startMinutes), end: clock(getGlobalWindow().endMinutes), timezone: TRADING_HOURS.timezone },
      dryRun: isDryRun(),
    },
    counts: {
      errorsToday: countTodayErrors(id, now),
      newPositionsToday: countTodayNewPositions(id, now, record.dailyResetAt),
      activePositions: activePositionsForBot(id).length,
    },
    capital: config
      ? {
          allocation: config.allocationLimit,
          atRisk,
          available: config.allocationLimit - atRisk,
          netLiquid: stats.closedPL != null ? config.allocationLimit + stats.closedPL : null,
        }
      : null,
    stats,
    mockPricing: MOCK_PRICING_SIMULATED,
    options: { accounts: [...accounts].sort(), groups: [...groups].sort() },
    positions,
    orders: ordersStore.query((o) => positionIds.has(o.positionId)),
    signals: signalsStore.query((s) => s.botId === id).slice(-LOG_LIMIT).reverse(),
    decisions: decisionsStore.query((d) => d.botId === id).slice(-LOG_LIMIT * 3).reverse(),
    runs: runsStore.query((r) => r.botId === id).slice(-LOG_LIMIT * 2).reverse(),
  });
}

/** Edit labels, notes, inputs, safeguards, trigger switches, alert prefs, account or archive state. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  if (!isKnownBot(id)) return badRequest("Unknown bot.", 404);
  return guarded(async () => {
    const body = (await readJson(req)) as BotPatch;
    const bot = updateBot(id, body);
    return NextResponse.json({ bot });
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  return guarded(async () => {
    deleteBot(id);
    return NextResponse.json({ ok: true });
  });
}
