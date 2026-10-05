import { NextRequest, NextResponse } from "next/server";
import { ensureBotRecord, getBotStaticConfig, listBotIds } from "@/lib/automation/bots";
import { DAILY_NEW_POSITION_LIMIT, ERROR_FAILSAFE_THRESHOLD, TOTAL_POSITION_LIMIT } from "@/lib/automation/config";
import { countTodayErrors } from "@/lib/automation/errors";
import { SESSION_COOKIE_NAME, isValidSession } from "@/lib/automation/session";
import { activePositionsForBot, countTodayNewPositions, sumActiveAllocationRisk } from "@/lib/automation/safeguards";
import { decisionsStore, positionsStore, signalsStore } from "@/lib/automation/store";
import type { BotStaticConfig } from "@/lib/automation/types";

function staticConfigSafe(id: string): BotStaticConfig | null {
  try {
    return getBotStaticConfig(id);
  } catch {
    // Required env (e.g. the strike offsets) not set yet - still list the
    // bot, flagged, rather than failing the whole status page.
    return null;
  }
}

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!isValidSession(token)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const now = Date.now();
  const botIds = listBotIds();

  const bots = botIds.map((id) => {
    const staticConfig = staticConfigSafe(id);
    const record = ensureBotRecord(id);
    return {
      id,
      name: staticConfig?.name ?? id,
      enabled: record.enabled,
      needsAttention: record.needsAttention,
      needsAttentionReason: record.needsAttentionReason,
      configError: staticConfig ? null : "Required configuration is missing (see .env.example TODOs).",
      errorCountToday: countTodayErrors(id, now),
      errorFailsafeThreshold: ERROR_FAILSAFE_THRESHOLD,
      newPositionsToday: countTodayNewPositions(id, now),
      dailyNewPositionLimit: DAILY_NEW_POSITION_LIMIT,
      activePositionCount: activePositionsForBot(id).length,
      closedPositionCount: positionsStore.query((p) => p.botId === id && (p.status === "closed" || p.status === "expired")).length,
      atRisk: staticConfig ? sumActiveAllocationRisk(id, staticConfig.widthPoints, staticConfig.openingCreditEstimate) : 0,
      allocation: staticConfig?.allocationLimit ?? null,
      totalPositionLimit: TOTAL_POSITION_LIMIT,
    };
  });

  const activePositions = botIds.flatMap((id) => activePositionsForBot(id));
  const decisions = decisionsStore.all().slice(-50).reverse();
  const signals = signalsStore.all().slice(-50).reverse();

  return NextResponse.json({ bots, activePositions, decisions, signals });
}
