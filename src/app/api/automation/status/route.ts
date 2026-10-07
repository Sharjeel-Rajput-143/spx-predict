import { NextRequest, NextResponse } from "next/server";
import { botDisplayName, ensureBotRecord, getBotLimits, getBotStaticConfig, listBotIds, missingSettingsOf } from "@/lib/automation/bots";
import { getAlertEmail, getGlobalWindow } from "@/lib/automation/appSettings";
import { ERROR_FAILSAFE_THRESHOLD, isDryRun, isTestMode } from "@/lib/automation/config";
import { countTodayErrors } from "@/lib/automation/errors";
import { SESSION_COOKIE_NAME, isValidSession } from "@/lib/automation/session";
import { activePositionsForBot, countTodayNewPositions, sumActiveAllocationRisk } from "@/lib/automation/safeguards";
import { executorStatus } from "@/lib/automation/sharedExecutor";
import { alertsStore, decisionsStore, ordersStore, positionsStore, signalsStore, storageProblem } from "@/lib/automation/store";
import { describeWindow, hoursConfigFor } from "@/lib/automation/tradingHours";
import { DEFAULT_ALERTS, type BotStaticConfig, type Decision } from "@/lib/automation/types";
import { getLastTick } from "@/lib/marketData/tickStore";
import { withStorage } from "@/lib/automation/withStorage";

function staticConfigSafe(id: string): { config: BotStaticConfig | null; error: string | null; missing: { key: string; why: string }[] | null } {
  try {
    return { config: getBotStaticConfig(id), error: null, missing: null };
  } catch (err) {
    // Required settings not set yet - still list the bot, flagged, rather than failing the whole page.
    return { config: null, error: err instanceof Error ? err.message : String(err), missing: missingSettingsOf(err) };
  }
}

/** A starting price for "Send test alert": the bot's last signal, else the live quote of its
 * underlying, else the middle of its sanity range. null = the person types one. */
function suggestedPrice(botId: string, config: BotStaticConfig | null): number | null {
  const last = signalsStore.query((s) => s.botId === botId && s.status === "accepted" && s.price > 0).at(-1)?.price;
  if (last) return last;
  if (config) {
    const live = getLastTick(config.underlying)?.price;
    if (live) return live;
    if (config.priceRange) return Math.round((config.priceRange.min + config.priceRange.max) / 2 / config.strikeIncrement) * config.strikeIncrement;
  }
  return null;
}

async function handleGET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!isValidSession(token)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const now = Date.now();
  const botIds = listBotIds();

  const bots = botIds.filter((id) => !ensureBotRecord(id).archived).map((id) => {
    const { config, error, missing } = staticConfigSafe(id);
    const record = ensureBotRecord(id);
    const limits = getBotLimits(id);
    const atRisk = config ? sumActiveAllocationRisk(id, config.widthPoints, config.openingCreditEstimate) : 0;
    const allocation = config?.allocationLimit ?? null;
    return {
      id,
      name: config?.name ?? botDisplayName(id),
      underlying: config?.underlying ?? null,
      enabled: record.enabled,
      killSwitch: !!record.killSwitch,
      needsAttention: record.needsAttention,
      needsAttentionReason: record.needsAttentionReason,
      configError: error,
      missingSettings: missing,
      errorCountToday: countTodayErrors(id, now),
      errorFailsafeThreshold: ERROR_FAILSAFE_THRESHOLD,
      newPositionsToday: countTodayNewPositions(id, now, record.dailyResetAt),
      dailyNewPositionLimit: limits.dailyNewPositionLimit,
      activePositionCount: activePositionsForBot(id).length,
      closedPositionCount: positionsStore.query((p) => p.botId === id && (p.status === "closed" || p.status === "expired")).length,
      atRisk,
      allocation,
      // What's left to open with: the allocation minus what active positions could lose.
      available: allocation != null ? Math.round((allocation - atRisk) * 100) / 100 : null,
      settings: config
        ? {
            quantity: config.quantity,
            widthPoints: config.widthPoints,
            strikeIncrement: config.strikeIncrement,
            putShortOffset: config.putShortOffset,
            callShortOffset: config.callShortOffset,
            strikeRounding: config.strikeRounding ?? "outward",
            openPricePercent: config.openPricePercent ?? 100,
            closePricePercent: config.closePricePercent ?? 100,
            smartPricing: config.smartPricing ?? "normal",
            window: describeWindow(hoursConfigFor(config.hours)),
            alerts: record.alerts ?? DEFAULT_ALERTS,
          }
        : null,
      totalPositionLimit: limits.totalPositionLimit,
      suggestedPrice: suggestedPrice(id, config),
    };
  });

  // Newest first. Active positions lead so they're what you see after an alert.
  const ACTIVE = ["opening", "open", "closing"];
  const positions = positionsStore
    .all()
    .sort((a, b) => Number(ACTIVE.includes(b.status)) - Number(ACTIVE.includes(a.status)) || (b.openedAt ?? 0) - (a.openedAt ?? 0))
    .slice(0, 100);

  const positionById = new Map(positionsStore.all().map((p) => [p.id, p]));
  const orders = ordersStore
    .all()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100)
    .map((o) => {
      const p = positionById.get(o.positionId);
      return { ...o, botId: p?.botId ?? null, positionType: p?.type ?? null, shortStrike: p?.shortStrike ?? null, longStrike: p?.longStrike ?? null, underlying: p?.underlying ?? null, venue: p?.venue ?? "mock", test: p?.test ?? false };
    });

  const decisionsBySignal = new Map<string, Decision[]>();
  for (const d of decisionsStore.all()) {
    if (!d.signalId) continue;
    const list = decisionsBySignal.get(d.signalId) ?? [];
    list.push(d);
    decisionsBySignal.set(d.signalId, list);
  }
  const signals = signalsStore
    .all()
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, 50)
    .map((s) => ({
      id: s.id,
      botId: s.botId,
      signal: s.signal,
      price: s.price,
      status: s.status,
      rejectReason: s.rejectReason ?? null,
      receivedAt: s.receivedAt,
      test: (s.raw as { test?: unknown } | null)?.test === true,
      symbol: (s.raw as { symbol?: unknown } | null)?.symbol ?? null,
      decisions: (decisionsBySignal.get(s.id) ?? []).sort((a, b) => a.createdAt - b.createdAt).map((d) => ({
        id: d.id,
        outcome: d.outcome,
        reason: d.reason,
        createdAt: d.createdAt,
        // Target price, rounding mode and chosen strikes, in words ("Target 21,003.69 (...), rounded down to 5 -> short ...").
        strikePlan: (d.detail.strikePlan as { text?: string } | undefined)?.text ?? null,
      })),
    }));

  return NextResponse.json({
    now,
    executor: { ...executorStatus(), dryRun: isDryRun(), testMode: isTestMode() },
    storageProblem: storageProblem(),
    bots,
    positions,
    orders,
    signals,
    alerts: alertsStore.all().sort((a, b) => b.createdAt - a.createdAt).slice(0, 50),
    alertEmail: { enabled: getAlertEmail().enabled, to: getAlertEmail().to },
  });
}

export const GET = withStorage(handleGET);
