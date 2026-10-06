import { NextRequest, NextResponse } from "next/server";
import { getBotStaticConfig, isKnownBot } from "@/lib/automation/bots";
import { getWebhookSecret } from "@/lib/automation/config";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { executorStatus, sharedExecutor } from "@/lib/automation/sharedExecutor";
import { decisionsStore } from "@/lib/automation/store";
import { ingestWebhook } from "@/lib/automation/webhookIngest";

const WAIT_FOR_DECISION_MS = 20_000;

/** "Send test alert": builds the body a TradingView alert would carry and runs
 * it through the SAME code as the real webhook (secret check, validation,
 * dedupe, per-bot lock, the decision logic, the executor). The only
 * differences: the secret is added here on the server (the browser never sees
 * it), and the saved signal is flagged as a test so its trades are labelled. */
export async function POST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;

  return guarded(async () => {
    const status = executorStatus();
    // Test alerts place real (paper) orders on a broker's sandbox, but never on a production account.
    if (!(status.venue === "mock" || (status.venue === "tradier" && status.sandbox === true))) return badRequest("Test alerts are only available on the mock executor or the Tradier sandbox - never against real money.", 409);

    const body = await readJson(req);
    const { bot, signal, price } = body;
    if (typeof bot !== "string" || !isKnownBot(bot)) return badRequest("Unknown bot.", 404);
    if (signal !== "bullish" && signal !== "bearish") return badRequest('signal must be "bullish" or "bearish".');
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return badRequest("Enter the test price (a positive number).");

    // Same symbol the real alert sends for this bot; a bot still missing settings can't be tested.
    let symbol: string;
    try {
      symbol = getBotStaticConfig(bot).underlying;
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : "This bot isn't set up yet.", 409);
    }
    let secret: string;
    try {
      secret = getWebhookSecret();
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : "WEBHOOK_SECRET is not set.", 409);
    }

    const result = ingestWebhook(
      { secret, bot, signal, symbol, price, bar_time: `test-${new Date().toISOString()}-${Math.random().toString(36).slice(2, 6)}`, interval: "test" },
      { executor: sharedExecutor, test: true },
    );
    if (result.status !== 200 || !result.signalId) return NextResponse.json(result.body, { status: result.status });

    const finished = await Promise.race([result.processing!.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), WAIT_FOR_DECISION_MS))]);
    const signalId = result.signalId;
    return NextResponse.json({ signalId, finished, decisions: decisionsStore.query((d) => d.signalId === signalId) });
  });
}
