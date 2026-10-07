import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { signalsStore, storage as backend, storageProblem, webhooksStore } from "@/lib/automation/store";
import { ingestWebhook } from "@/lib/automation/webhookIngest";
import { WEBHOOK_MIN_INTERVAL_MS, findWebhookByToken, isAttached, webhookUnderlying } from "@/lib/automation/webhooks";
import { SLOW_QUOTE_WAIT_MS, resolveHookPrice } from "@/lib/automation/hookPrice";
import { checkInterruptedRuns } from "@/lib/automation/interrupted";
import { pruneOncePerDay } from "@/lib/automation/retention";
import { deferWork, loadEverything, withStorage } from "@/lib/automation/withStorage";

/** A named webhook's URL, the one TradingView is given. The secret is the URL itself. As in Option Alpha, the call is only a trigger:
 * whatever the alert's message says is not read, and the bot works from its own live quote of its underlying. */
async function handlePOST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
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
  const underlying = webhookUnderlying(hook.botId);

  // Option Alpha ignores a webhook called again within a minute; so do we, and the log says so.
  // Read the record again here: `hook` was fetched before the body was awaited, and a call that arrived in the meantime may have used the minute.
  const lastTriggeredAt = webhooksStore.get(hook.id)?.lastTriggeredAt ?? hook.lastTriggeredAt;
  if (lastTriggeredAt !== null && now - lastTriggeredAt < WEBHOOK_MIN_INTERVAL_MS) {
    signalsStore.insert({
      id: `sig-rejected-${now}-${crypto.randomUUID()}`,
      botId: hook.botId,
      signal: hook.direction,
      barTime: "",
      price: 0,
      interval: "",
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

  const botId = hook.botId;
  const direction = hook.direction;
  const barTime = `${hook.id}-${new Date(now).toISOString().slice(0, 16)}`; // one per minute: a webhook runs at most once a minute
  const send = (price: number) =>
    ingestWebhook({ bot: botId, signal: direction, ...(underlying ? { symbol: underlying } : {}), price, bar_time: barTime, interval: "", webhook: hook.name }, { executor: sharedExecutor, trusted: true });
  const count = () => webhooksStore.update(hook.id, { triggerCount: (webhooksStore.get(hook.id)?.triggerCount ?? 0) + 1 });

  // On a host whose records are in a database (Vercel), loading them all, finding the live quote and starting up all cost seconds
  // that TradingView will not wait for (it gives up after about 3). So the call is recognised from the webhook and the bot alone,
  // the minute's slot is taken and saved, and the answer goes out. Everything else (loading the rest of the records, the quote,
  // the checks, the flip, the orders) is done behind the answer. The Log shows every call, including one the bot then refused.
  if (backend.remote) {
    const background = async () => {
      await loadEverything();
      pruneOncePerDay(now);
      await checkInterruptedRuns(now).catch(() => undefined);
      const found = await resolveHookPrice(underlying, Date.now(), SLOW_QUOTE_WAIT_MS);
      if (found === null) {
        giveBack();
        signalsStore.insert({ id: `sig-rejected-${now}-${crypto.randomUUID()}`, botId, signal: direction, barTime, price: 0, interval: "", receivedAt: now, status: "rejected", rejectReason: "no_price", raw: { webhook: hook.name } });
        return;
      }
      const result = send(found);
      if (result.status === 200) count();
      else giveBack();
      await result.processing;
    };
    return deferWork(NextResponse.json({ received: true }, { status: 200 }), background);
  }

  // Records in files (a laptop, a server with a disk): answered as soon as the signal is saved; the bot finishes its work behind it.
  // The price is the bot's own live quote, never one sent with the call.
  const interruptedCheck = (async () => {
    // Housekeeping, finished behind the answer with the rest of the work: old log entries (once a day) and runs that never finished.
    pruneOncePerDay(now);
    await checkInterruptedRuns(now);
  })().catch(() => undefined);
  const price = await resolveHookPrice(underlying, now);
  if (price !== null) {
    const result = send(price);
    if (result.status === 200) count();
    else giveBack();
    return deferWork(NextResponse.json(result.body, { status: result.status }), Promise.all([result.processing, interruptedCheck]));
  }

  // No quote yet (a server that has only just started, or a slow feed): answer now, and keep looking for it a few seconds more
  // in the background. If there is still none, the call is logged as rejected, so it shows in the bot's Log.
  const late = (async () => {
    const found = await resolveHookPrice(underlying, Date.now(), SLOW_QUOTE_WAIT_MS);
    if (found === null) {
      giveBack();
      signalsStore.insert({ id: `sig-rejected-${now}-${crypto.randomUUID()}`, botId, signal: direction, barTime, price: 0, interval: "", receivedAt: now, status: "rejected", rejectReason: "no_price", raw: { webhook: hook.name } });
      return;
    }
    const result = send(found);
    if (result.status === 200) count();
    else giveBack();
    await result.processing;
  })();
  return deferWork(NextResponse.json({ received: true, queued: "Waiting for a live price; the call is being processed." }, { status: 202 }), Promise.all([late, interruptedCheck]));
}

// Only the webhooks and the bots are loaded before the answer (see above); `maxDuration` is how long the work behind the answer may take.
export const maxDuration = 60;
export const POST = withStorage(handlePOST, { load: ["webhooks", "bots"] });
