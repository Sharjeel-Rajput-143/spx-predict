import { LIVE_BOT_ID } from "@/lib/automation/bybitLiveLimits";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_TIMEOUT_CHOICES, getAlertEmail, getAppSettings, getGlobalWindow, updateAppSettings, type AppSettingsPatch } from "@/lib/automation/appSettings";
import { botDisplayName, getBotStaticConfig, listBotIds } from "@/lib/automation/bots";
import { TRADING_HOURS, isAuthRequired, isDryRun, isTestMode } from "@/lib/automation/config";
import { guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { executorStatus } from "@/lib/automation/sharedExecutor";
import { botsStore } from "@/lib/automation/store";
import { listAccounts } from "@/lib/automation/summary";
import { withStorage } from "@/lib/automation/withStorage";

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Everything the Settings page shows, in one read-only payload. Never includes the webhook secret - only whether it is set. */
function snapshot() {
  const settings = getAppSettings();
  const window = getGlobalWindow();
  const email = getAlertEmail();

  const bots = listBotIds().map((id) => {
    let underlying: string | null = null;
    let accountId: string | null = null;
    try {
      const c = getBotStaticConfig(id);
      underlying = c.underlying;
      accountId = c.accountId;
    } catch {
      accountId = botsStore.get(id)?.draftInputs?.accountId ?? null;
    }
    return { id, name: botDisplayName(id), underlying, accountId, archived: !!botsStore.get(id)?.archived };
  });

  return {
    settings,
    window: { start: clock(window.startMinutes), end: clock(window.endMinutes), source: window.source, timezone: TRADING_HOURS.timezone },
    email: { enabled: email.enabled, to: email.to, senderWired: false },
    sessionTimeoutChoices: SESSION_TIMEOUT_CHOICES,
    signInRequired: isAuthRequired(),
    executor: { ...executorStatus(), dryRun: isDryRun(), testMode: isTestMode() },
    accounts: listAccounts().map((id) => ({ id, bots: bots.filter((b) => b.accountId === id).map((b) => b.name) })),
    webhook: {
      path: "/api/webhook/tradingview",
      secretSet: Boolean(process.env.WEBHOOK_SECRET),
      // The live bot is reached only through the mirror: it is never offered as a bot to attach a webhook to or to send a test alert to.
      bots: bots.filter((b) => !b.archived && b.id !== LIVE_BOT_ID).map((b) => ({ id: b.id, name: b.name, underlying: b.underlying })),
    },
  };
}

async function handleGET(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return NextResponse.json(snapshot());
}

async function handlePATCH(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const body = await readJson(req);
    updateAppSettings(body as AppSettingsPatch);
    return NextResponse.json(snapshot());
  });
}

export const GET = withStorage(handleGET);
export const PATCH = withStorage(handlePATCH);
