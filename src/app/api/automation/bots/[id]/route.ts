import { settleExpiredFromClose } from "@/lib/automation/settleExpired";
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
import { bybitSafeguards } from "@/lib/automation/bybitSafeguards";
import { pullbackSettings } from "@/lib/automation/pullbackExit";
import { countTodayErrors } from "@/lib/automation/errors";
import { realizedToday } from "@/lib/automation/lossLimit";
import { computeStats } from "@/lib/automation/pnl";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { activePositionsForBot, countTodayNewPositions, sumActiveAllocationRisk } from "@/lib/automation/safeguards";
import { MOCK_PRICING_SIMULATED } from "@/lib/automation/sharedExecutor";
import { easternDateKey } from "@/lib/automation/tradingHours";
import { botsStore, decisionsStore, ordersStore, positionsStore, runsStore, signalsStore } from "@/lib/automation/store";
import { DEFAULT_ALERTS, type BotStaticConfig } from "@/lib/automation/types";
import { deferWork, withStorage } from "@/lib/automation/withStorage";

const LOG_LIMIT = 300;

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Everything the bot page shows, in one read-only payload. */
async function handleGET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  // The bot that trades Bybit is protected by Bybit's own daily loss limit (DAILY_MAX_LOSS_USD, after fees), not the engine's: the page shows that one.
  const broker = bybitSafeguards(id, config?.underlying, now);

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
      alwaysOn: record.alwaysOn ?? { bullish: true, bearish: true },
      positionChecks: record.positionChecks ?? {},
      openSettings: record.openSettings ?? {},
      closeSettings: record.closeSettings ?? {},
      monitors: record.monitors ?? {},
      alerts: { ...DEFAULT_ALERTS, ...record.alerts },
      safeguards: record.safeguards ?? {},
      /** The pullback exit and chain settings in force for this bot (the two Bybit bots, each its own; null for every other bot). */
      pullback: id === "btc_bybit" || id === "btc_bybit_live" ? pullbackSettings(id) : null,
      chainRunning: record.chainState ? { trades: record.chainState.count } : null,
      logClearedAt: record.logClearedAt ?? 0,
      dailyResetAt: record.dailyResetAt ?? 0,
    },
    config,
    limits: {
      maxPositionsPerType: limits.maxPositionsPerType,
      dayTradingAllowed: limits.dayTradingAllowed,
      totalPositionLimit: limits.totalPositionLimit,
      dailyNewPositionLimit: limits.dailyNewPositionLimit,
      dailyLossLimit: limits.dailyLossLimit,
      /** The limit the Bybit executor enforces for the BTC bot (dollars), or null for every other bot. */
      brokerDailyLossLimit: broker ? broker.limit : null,
      errorFailsafeThreshold: ERROR_FAILSAFE_THRESHOLD,
      dedupeWindowSeconds: DEDUPE_WINDOW_SECONDS,
      flipCooldownSeconds: getFlipCooldownSeconds(),
      orderFillTimeoutSeconds: ORDER_FILL_TIMEOUT_SECONDS,
      closeConfirmTimeoutSeconds: CLOSE_CONFIRM_TIMEOUT_SECONDS,
      hours: { start: clock(getGlobalWindow().startMinutes), end: clock(getGlobalWindow().endMinutes), timezone: TRADING_HOURS.timezone },
      dryRun: isDryRun(),
    },
    dayLoss: (() => {
      if (broker) return { limit: broker.limit, realized: broker.realized, closedToday: broker.closedToday, unpriced: 0, lastCheck: null, afterFees: true };
      const today = realizedToday(id, now);
      const last = record.lossCheck && easternDateKey(record.lossCheck.at) === easternDateKey(now) ? record.lossCheck : null;
      return { limit: limits.dailyLossLimit, realized: today.realized, closedToday: today.closedToday, unpriced: today.unpriced, lastCheck: last };
    })(),
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
async function handlePATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

async function handleDELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  return guarded(async () => {
    deleteBot(id);
    return NextResponse.json({ ok: true });
  });
}

// After the answer: an expired position nobody worked out a result for (the sweep could not run) is settled from that day's closing
// price. It shows on the next refresh, so a slow price lookup never holds the page up.
export const GET = withStorage(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const response = await handleGET(req, ctx);
  const { id } = await ctx.params;
  return deferWork(response, () => settleExpiredFromClose({ botId: id }).catch(() => 0));
});
export const PATCH = withStorage(handlePATCH);
export const DELETE = withStorage(handleDELETE);
