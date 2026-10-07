import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { signalsStore, storageProblem, webhooksStore } from "@/lib/automation/store";
import { ingestWebhook, settleIfServerless } from "@/lib/automation/webhookIngest";
import { WEBHOOK_MIN_INTERVAL_MS, findWebhookByToken, isAttached, parseHookBody, webhookUnderlying } from "@/lib/automation/webhooks";
import { resolveHookPrice } from "@/lib/automation/hookPrice";

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
  // Read the record again here: `hook` was fetched before the body was awaited, and a call that arrived in the meantime may have used the minute.
  const lastTriggeredAt = webhooksStore.get(hook.id)?.lastTriggeredAt ?? hook.lastTriggeredAt;
  if (lastTriggeredAt !== null && now - lastTriggeredAt < WEBHOOK_MIN_INTERVAL_MS) {
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

  // Take this minute's slot now, before anything is awaited: two calls arriving together (a double delivery) then can't both
  // get past the check above while the price is being looked up. If the call comes to nothing, the slot is given back.
  const previous = lastTriggeredAt;
  webhooksStore.update(hook.id, { lastTriggeredAt: now });
  const giveBack = () => webhooksStore.update(hook.id, { lastTriggeredAt: previous });

  // The price: the alert's own, else the live quote of the bot's underlying if it is fresh. The alert may carry no
  // message at all (as with Option Alpha, the call itself is the trigger).
  const price = await resolveHookPrice(payload.price, underlying, now);
  if (price === null) {
    giveBack();
    return NextResponse.json({ error: 'No price. Put it in the alert message, e.g. {"price":{{close}}}.' }, { status: 400 });
  }

  const barTime = payload.barTime ?? `${hook.id}-${new Date(now).toISOString().slice(0, 16)}`;
  const result = ingestWebhook({ bot: hook.botId, signal: hook.direction, ...(underlying ? { symbol: underlying } : {}), price, bar_time: barTime, interval: payload.interval ?? "", webhook: hook.name }, { executor: sharedExecutor, trusted: true });
  await settleIfServerless(result);
  if (result.status === 200) webhooksStore.update(hook.id, { triggerCount: (webhooksStore.get(hook.id)?.triggerCount ?? 0) + 1 });
  else giveBack();
  return NextResponse.json(result.body, { status: result.status });
}
