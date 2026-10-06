import { NextRequest, NextResponse } from "next/server";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { executorStatus, sharedExecutor } from "@/lib/automation/sharedExecutor";
import { decisionsStore, webhooksStore } from "@/lib/automation/store";
import { ingestWebhook } from "@/lib/automation/webhookIngest";
import { webhookUnderlying } from "@/lib/automation/webhooks";

const WAIT_FOR_DECISION_MS = 45_000;

/** "Test call": sends this webhook's signal through the real path, as TradingView's call would - the engine's
 * decisions, the executor, the order. On the Tradier SANDBOX that places a real order on the paper account; on the
 * mock, nothing leaves this machine. Never against a production account. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  return guarded(async () => {
    const hook = webhooksStore.get(id);
    if (!hook) return badRequest("Webhook not found.", 404);
    const status = executorStatus();
    if (!(status.venue === "mock" || (status.venue === "tradier" && status.sandbox === true))) {
      return badRequest("A test call is only possible on the mock executor or the Tradier sandbox - never against real money.", 409);
    }
    const body = await readJson(req);
    const price = body.price;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return badRequest("Enter the price to send (a positive number).");

    const underlying = webhookUnderlying(hook.botId);
    const result = ingestWebhook(
      { bot: hook.botId, signal: hook.direction, ...(underlying ? { symbol: underlying } : {}), price, bar_time: `test-${hook.id}-${new Date().toISOString()}`, interval: "test", webhook: hook.name },
      { executor: sharedExecutor, trusted: true, test: true },
    );
    if (result.status !== 200 || !result.signalId) return NextResponse.json(result.body, { status: result.status });
    const finished = await Promise.race([result.processing!.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), WAIT_FOR_DECISION_MS))]);
    const signalId = result.signalId;
    return NextResponse.json({ signalId, finished, venue: status.venue, decisions: decisionsStore.query((d) => d.signalId === signalId).map((d) => ({ outcome: d.outcome, reason: d.reason })) });
  });
}
