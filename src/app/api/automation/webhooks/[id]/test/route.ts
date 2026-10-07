import { NextRequest, NextResponse } from "next/server";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { executorStatus, sharedExecutor } from "@/lib/automation/sharedExecutor";
import { decisionsStore, webhooksStore } from "@/lib/automation/store";
import { ingestWebhook } from "@/lib/automation/webhookIngest";
import { resolveHookPrice } from "@/lib/automation/hookPrice";
import { isAttached, webhookUnderlying } from "@/lib/automation/webhooks";

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
    if (!isAttached(hook)) return badRequest("Attach this webhook to a trigger first: a test call needs to know which bot and signal it is.", 409);
    const status = executorStatus();
    if (!(status.venue === "mock" || (status.venue === "tradier" && status.sandbox === true))) {
      return badRequest("A test call is only possible on the mock executor or the Tradier sandbox - never against real money.", 409);
    }
    const body = await readJson(req);
    // Like the real call, a test needs no price: left blank it runs on the live quote. A typed price overrides it.
    const typed = body.price === undefined || body.price === null ? null : body.price;
    if (typed !== null && (typeof typed !== "number" || !Number.isFinite(typed) || typed <= 0)) return badRequest("The price must be a positive number, or left blank to use the live quote.");
    const underlying = webhookUnderlying(hook.botId);
    const price = await resolveHookPrice(typed, underlying);
    if (price === null) return badRequest(`No live ${underlying ?? ""} quote right now. Try again in a moment, or type a price to test with.`.replace("  ", " "), 409);

    const result = ingestWebhook(
      { bot: hook.botId, signal: hook.direction, ...(underlying ? { symbol: underlying } : {}), price, bar_time: `test-${hook.id}-${new Date().toISOString()}`, interval: "test", webhook: hook.name },
      { executor: sharedExecutor, trusted: true, test: true },
    );
    if (result.status !== 200 || !result.signalId) return NextResponse.json(result.body, { status: result.status });
    const finished = await Promise.race([result.processing!.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), WAIT_FOR_DECISION_MS))]);
    const signalId = result.signalId;
    return NextResponse.json({ signalId, price, finished, venue: status.venue, decisions: decisionsStore.query((d) => d.signalId === signalId).map((d) => ({ outcome: d.outcome, reason: d.reason })) });
  });
}
