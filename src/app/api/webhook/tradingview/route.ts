import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isKnownBot } from "@/lib/automation/bots";
import { withBotLock } from "@/lib/automation/botLock";
import { getWebhookSecret } from "@/lib/automation/config";
import { processSignal, receiveAndSaveSignal } from "@/lib/automation/engine";
import { startEodScheduler } from "@/lib/automation/eodSweep";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { signalsStore } from "@/lib/automation/store";

function secretMatches(provided: unknown): boolean {
  if (typeof provided !== "string" || !provided) return false;
  const expected = Buffer.from(getWebhookSecret());
  const actual = Buffer.from(provided);
  // Reject unequal lengths before timingSafeEqual, which throws on a length
  // mismatch rather than returning false.
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Spec: "store nothing except a rejected log row" on a bad secret - and
 * never the secret itself, here or anywhere else. */
function logRejectedSignal(body: Record<string, unknown>, reason: string) {
  const { secret: _secret, ...redacted } = body;
  signalsStore.insert({
    id: `sig-rejected-${Date.now()}-${crypto.randomUUID()}`,
    botId: typeof body.bot === "string" ? body.bot : "unknown",
    signal: typeof body.signal === "string" ? body.signal : "",
    barTime: typeof body.bar_time === "string" ? body.bar_time : "",
    price: typeof body.price === "number" ? body.price : 0,
    interval: typeof body.interval === "string" ? body.interval : "",
    receivedAt: Date.now(),
    status: "rejected",
    rejectReason: reason,
    raw: redacted,
  });
}

export async function POST(req: NextRequest) {
  startEodScheduler();

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  if (!secretMatches((body as Record<string, unknown>).secret)) {
    logRejectedSignal(body as Record<string, unknown>, "bad_secret");
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { bot, signal, symbol, price, bar_time: barTime, interval } = body as Record<string, unknown>;

  if (typeof bot !== "string" || !isKnownBot(bot)) {
    logRejectedSignal(body as Record<string, unknown>, "unknown_bot");
    return NextResponse.json({ error: "Unknown bot." }, { status: 400 });
  }
  if (signal !== "bullish" && signal !== "bearish") {
    logRejectedSignal(body as Record<string, unknown>, "invalid_signal");
    return NextResponse.json({ error: "signal must be \"bullish\" or \"bearish\"." }, { status: 400 });
  }
  if (typeof price !== "number" || !Number.isFinite(price)) {
    logRejectedSignal(body as Record<string, unknown>, "invalid_price");
    return NextResponse.json({ error: "price must be a number." }, { status: 400 });
  }
  if (typeof barTime !== "string" || !barTime) {
    logRejectedSignal(body as Record<string, unknown>, "invalid_bar_time");
    return NextResponse.json({ error: "bar_time is required." }, { status: 400 });
  }

  const { secret: _secret, ...rawWithoutSecret } = body as Record<string, unknown>;
  const savedSignal = receiveAndSaveSignal({
    botId: bot,
    signal,
    price,
    barTime,
    interval: typeof interval === "string" ? interval : "",
    raw: { ...rawWithoutSecret, symbol },
  });

  // Return fast; the decision logic (which can take up to the close/fill
  // timeouts) runs in the background, serialized per bot. Caught here so a
  // misconfigured bot (e.g. the strike-offset TODOs in .env.example still
  // unset) logs loudly instead of becoming an unhandled rejection.
  void withBotLock(bot, () => processSignal(savedSignal, { executor: sharedExecutor })).catch((err) => {
    console.error(`[automation] signal ${savedSignal.id} for bot "${bot}" failed`, err);
  });

  return NextResponse.json({ received: true }, { status: 200 });
}
