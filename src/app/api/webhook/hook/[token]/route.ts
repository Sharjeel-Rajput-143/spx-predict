import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { botsStore, signalsStore, storage as backend, storageProblem, webhooksStore } from "@/lib/automation/store";
import { ingestWebhook } from "@/lib/automation/webhookIngest";
import { WEBHOOK_MIN_INTERVAL_MS, checkAlertText, findWebhookByToken, isAttached, webhookUnderlying } from "@/lib/automation/webhooks";
import { ensureBotRecord } from "@/lib/automation/bots";
import { logDecision } from "@/lib/automation/decisions";
import { SLOW_QUOTE_WAIT_MS, freshQuoteNow, resolveHookPrice } from "@/lib/automation/hookPrice";
import { arrivalIdle, enqueueArrival } from "@/lib/automation/webhookQueue";
import { checkInterruptedRuns } from "@/lib/automation/interrupted";
import { runMirror } from "@/lib/automation/liveMirror";
import { pruneOncePerDay } from "@/lib/automation/retention";
import { deferWork, loadEverything, withStorage } from "@/lib/automation/withStorage";

/** Starts the live job of this call (liveMirror.ts) and hands back a promise that cannot reject. If the mirror itself ever broke its promise and threw, or hung, the demo call would not notice:
 * nothing the answer is built from depends on it. */
function mirrorSafely(...args: Parameters<typeof runMirror>): Promise<void> | undefined {
  try {
    return runMirror(...args).catch(() => undefined);
  } catch {
    return undefined;
  }
}

/** A named webhook's URL, the one TradingView is given. The secret is the URL itself. As in Option Alpha, the call is only a trigger:
 * the URL decides which signal it is, and the bot works from its own live quote of its underlying. The alert's text is read for one
 * thing only: to refuse a call whose text disagrees with its URL (a Bullish alert pointed at the Bearish URL). It never starts or
 * changes a trade. */
async function handlePOST(req: NextRequest, { params }: { params: Promise<{ token: string }> }, text: string) {
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

  // The text of the alert must not disagree with the URL's direction. A refused call is saved as a rejected signal, said in the Log
  // and the bot's alerts, and answered with an error so that TradingView's own log shows it failed. Nothing is traded, and the
  // minute's slot isn't used, so the right alert a moment later still goes through.
  const verdict = checkAlertText(hook, text);
  if (!verdict.ok) {
    const signalId = `sig-rejected-${now}-${crypto.randomUUID()}`;
    signalsStore.insert({ id: signalId, botId: hook.botId, signal: hook.direction!, barTime: "", price: 0, interval: "", receivedAt: now, status: "rejected", rejectReason: verdict.code, raw: { webhook: hook.name, alertText: text.slice(0, 200) } });
    logDecision({ signalId, botId: hook.botId, outcome: "webhook_text_mismatch", reason: verdict.reason, detail: { webhook: hook.name, direction: hook.direction, alertText: text.slice(0, 200) }, now });
    ensureBotRecord(hook.botId);
    botsStore.update(hook.botId, { needsAttention: true, needsAttentionReason: `${hook.name}: ${verdict.reason}` });
    return NextResponse.json({ error: verdict.reason }, { status: 422 });
  }

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
    // The live price is asked for right now, while the answer goes out and the rest of the records load: a lookup started only after the
    // records had loaded made every alert wait for the two one after the other.
    const priceLookup = resolveHookPrice(underlying, Date.now(), SLOW_QUOTE_WAIT_MS).catch(() => null);
    const background = async () => {
      await loadEverything();
      pruneOncePerDay(now);
      await checkInterruptedRuns(now).catch(() => undefined);
      const found = await priceLookup;
      if (found === null) {
        giveBack();
        signalsStore.insert({ id: `sig-rejected-${now}-${crypto.randomUUID()}`, botId, signal: direction, barTime, price: 0, interval: "", receivedAt: now, status: "rejected", rejectReason: "no_price", raw: { webhook: hook.name } });
        return;
      }
      // Both jobs start at the same moment and neither waits for the other (see liveMirror.ts). The live job first: nothing the demo job does, even a throw, can stop it.
      const liveJob = mirrorSafely({ hook, direction: direction!, price: found, barTime });
      try {
        const result = send(found);
        if (result.status === 200) count();
        else giveBack();
        await result.processing;
      } catch (err) {
        giveBack();
        console.error("[automation] the demo job of this alert failed; the live job is independent and was started", err);
      }
      await liveJob;
    };
    return deferWork(NextResponse.json({ received: true }, { status: 200 }), background);
  }

  // Records in files (a laptop, a server with a disk). The answer NEVER waits for a price: TradingView gives up after a few seconds, and the first call after a restart used to
  // spend about 1.7 of them fetching a quote. Either a fresh quote is already held (the usual case: a poller keeps one), and the signal is saved at once, or the call is answered
  // now and finds its price behind the answer. Either way the calls of one bot reach the engine in the order they arrived (webhookQueue.ts), the minute's slot is already taken
  // and saved, and a call that never reaches the engine is reported by the watchdog (checkInterruptedRuns).
  const interruptedCheck = (async () => {
    // Housekeeping, finished behind the answer with the rest of the work: old log entries (once a day) and runs that never finished.
    pruneOncePerDay(now);
    await checkInterruptedRuns(now);
  })().catch(() => undefined);
  const quote = freshQuoteNow(underlying, now);
  if (quote !== null && arrivalIdle(botId)) {
    // Both jobs start at the same moment and neither waits for the other (see liveMirror.ts). The live job is started first and cannot be stopped by anything the demo job does.
    const mirrored = mirrorSafely({ hook, direction: direction!, price: quote, barTime });
    let result: ReturnType<typeof send> | null = null;
    try {
      result = send(quote);
      if (result.status === 200) count();
      else giveBack();
    } catch (err) {
      giveBack();
      console.error("[automation] the demo job of this alert failed; the live job is independent and was started", err);
    }
    // TradingView's answer is built from the demo result alone.
    if (!result) return deferWork(NextResponse.json({ error: "The demo bot could not take this alert." }, { status: 500 }), Promise.all([interruptedCheck, mirrored]));
    return deferWork(NextResponse.json(result.body, { status: result.status }), Promise.all([result.processing, interruptedCheck, mirrored]));
  }

  // No fresh quote yet (a server that has only just started, or a slow feed), or an earlier call of this bot is still waiting for its own: answered now, and this call takes its turn
  // behind the others. If there is still no price after the wait, the call is logged as rejected, so it shows in the bot's Log, and the minute is given back.
  let processing: Promise<void> | undefined;
  let liveJob: Promise<void> | undefined;
  const turn = enqueueArrival(botId, async () => {
    const found = quote ?? (await resolveHookPrice(underlying, Date.now(), SLOW_QUOTE_WAIT_MS));
    if (found === null) {
      giveBack();
      signalsStore.insert({ id: `sig-rejected-${now}-${crypto.randomUUID()}`, botId, signal: direction, barTime, price: 0, interval: "", receivedAt: now, status: "rejected", rejectReason: "no_price", raw: { webhook: hook.name } });
      return;
    }
    // Both jobs start at the same moment and neither waits for the other (see liveMirror.ts).
    liveJob = mirrorSafely({ hook, direction: direction!, price: found, barTime });
    try {
      const result = send(found);
      if (result.status === 200) count();
      else giveBack();
      processing = result.processing;
    } catch (err) {
      giveBack();
      console.error("[automation] the demo job of this alert failed; the live job is independent and was started", err);
    }
  });
  return deferWork(NextResponse.json({ received: true, queued: "Waiting for a live price; the call is being processed." }, { status: 200 }), Promise.all([turn.then(() => processing), interruptedCheck, turn.then(() => liveJob)]));
}

/** A look that triggers nothing: it answers 200 for any address (so it says nothing about which tokens exist), after opening the same
 * storage connection a real call uses. Point an uptime monitor at /hook/warm every few minutes: it keeps this function and its
 * database connection awake, so a real call isn't the one that pays for starting them (TradingView gives up after about 3 seconds).
 * A database that can't be reached answers 503 here, which makes the monitor a health check as well. */
async function handleGET(_req: NextRequest, _ctx: { params: Promise<{ token: string }> }) {
  return NextResponse.json({ ok: true });
}

// Only the webhooks and the bots are loaded before the answer (see above); `maxDuration` is how long the work behind the answer may take.
// A call that can't be recognised within a second (a function that is starting up, a database that is slow to answer) is answered
// anyway and carried out behind the answer, so TradingView never sees a timeout for it.
export const maxDuration = 60;
const guarded = withStorage(handlePOST, { load: ["webhooks", "bots"], answerWithin: { ms: 900, response: () => NextResponse.json({ received: true, queued: "Being processed." }, { status: 200 }) } });
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  // Read the alert's text first: once the answer has gone out the request is no longer there to read.
  const text = (await req.text().catch(() => "")).slice(0, 4000);
  return guarded(req, ctx, text);
}
export const GET = withStorage(handleGET, { load: ["webhooks", "bots"] });
