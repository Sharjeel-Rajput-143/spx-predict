import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { signalsStore, storageProblem, webhooksStore } from "@/lib/automation/store";
import { ingestWebhook, settleIfServerless } from "@/lib/automation/webhookIngest";
import { WEBHOOK_MIN_INTERVAL_MS, findWebhookByToken, isAttached, parseHookBody, webhookUnderlying } from "@/lib/automation/webhooks";
import { waitForTick } from "@/lib/marketData/tickStore";

/** A live quote older than this isn't a price to trade on. */
const MAX_QUOTE_AGE_MS = 5 * 60_000;
/** A server that has only just started has no quote yet; give its first one a few seconds. */
const FIRST_QUOTE_WAIT_MS = 6_000;

/** A named webhook's URL, the one TradingView is given. The secret is the URL itself, so the alert message
 * only needs to carry the price (or nothing, when there is a fresh live quote for the bot's underlying). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  // A host that can't keep records can't run the engine: say so before touching any of them.
  const storage = storageProblem();
  if (storage) return NextResponse.json({ error: storage }, { status: 503 });

  const { token } = await params;
  const hook = findWebhookByToken(token);
  // Unknown or switched-off URLs look exactly the same from outside.
  if (!hook || !hook.active) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // A webhook that isn't attached to a trigger has no bot or direction to run: refused until it is attached.
  if (!isAttached(hook)) return NextResponse.json({ error: "This webhook isn't attached to a trigger. Attach it from the bot's Bullish or Bearish trigger." }, { status: 409 });

  const now = Date.now();
  const raw = await req.text().catch(() => "");
  const payload = parseHookBody(raw);
  const underlying = webhookUnderlying(hook.botId);

  // Option Alpha ignores a webhook called again within a minute; so do we, and the log says so.
  if (hook.lastTriggeredAt !== null && now - hook.lastTriggeredAt < WEBHOOK_MIN_INTERVAL_MS) {
    signalsStore.insert({
      id: `sig-rejected-${now}-${crypto.randomUUID()}`,
      botId: hook.botId,
      signal: hook.direction,
      barTime: payload.barTime ?? "",
      price: payload.price ?? 0,
      interval: payload.interval ?? "",
      receivedAt: now,
      status: "rejected",
      rejectReason: "webhook_rate_limited",
      raw: { webhook: hook.name },
    });
    return NextResponse.json({ received: true, ignored: "A webhook can only be triggered once a minute." }, { status: 200 });
  }

  // The price: the alert's own, else the live quote of the bot's underlying if it is fresh. The alert may carry no
  // message at all (as with Option Alpha, the call itself is the trigger).
  let price = payload.price;
  if (price === null && underlying) {
    const tick = await waitForTick(underlying, FIRST_QUOTE_WAIT_MS);
    if (tick && now - tick.t <= MAX_QUOTE_AGE_MS) price = tick.price;
  }
  if (price === null) {
    return NextResponse.json({ error: 'No price. Put it in the alert message, e.g. {"price":{{close}}}.' }, { status: 400 });
  }

  const barTime = payload.barTime ?? `${hook.id}-${new Date(now).toISOString().slice(0, 16)}`;
  const result = ingestWebhook({ bot: hook.botId, signal: hook.direction, ...(underlying ? { symbol: underlying } : {}), price, bar_time: barTime, interval: payload.interval ?? "", webhook: hook.name }, { executor: sharedExecutor, trusted: true });
  await settleIfServerless(result);
  if (result.status === 200) webhooksStore.update(hook.id, { lastTriggeredAt: now, triggerCount: hook.triggerCount + 1 });
  return NextResponse.json(result.body, { status: result.status });
}
