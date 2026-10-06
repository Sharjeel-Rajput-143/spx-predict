import "server-only";
import crypto from "node:crypto";
import { isKnownBot } from "./bots";
import { withBotLock } from "./botLock";
import { getWebhookSecret } from "./config";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { startEodScheduler } from "./eodSweep";
import { executorStatus } from "./sharedExecutor";
import { signalsStore } from "./store";
import type { BrokerExecutor } from "./types";

/** The whole life of a TradingView alert after its JSON is parsed: secret
 * check, validation, save, then the decision logic. The webhook route and the
 * admin page's "Send test alert" both come through here, so a test exercises
 * exactly what a real alert does. */

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

export interface IngestOptions {
  executor: BrokerExecutor;
  /** Set only by the admin page's Send test alert, after its own auth. A `test` field in a webhook body is ignored. */
  test?: boolean;
}

export interface IngestResult {
  status: number;
  body: Record<string, unknown>;
  /** The saved signal's id, once accepted. */
  signalId?: string;
  /** Resolves when the decision logic for an accepted signal has finished (never rejects). */
  processing?: Promise<void>;
}

export function ingestWebhook(parsed: unknown, options: IngestOptions): IngestResult {
  startEodScheduler();

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: 400, body: { error: "Malformed request body." } };
  }
  const body = parsed as Record<string, unknown>;

  if (!secretMatches(body.secret)) {
    logRejectedSignal(body, "bad_secret");
    return { status: 401, body: { error: "Unauthorized." } };
  }

  // A misconfigured broker executor (EXECUTOR=tradier without its token) refuses
  // signals up front rather than failing halfway through one.
  const problem = executorStatus().error;
  if (problem) return { status: 503, body: { error: problem } };

  const { bot, signal, symbol, price, bar_time: barTime, interval } = body;

  if (typeof bot !== "string" || !isKnownBot(bot)) {
    logRejectedSignal(body, "unknown_bot");
    return { status: 400, body: { error: "Unknown bot." } };
  }
  if (signal !== "bullish" && signal !== "bearish") {
    logRejectedSignal(body, "invalid_signal");
    return { status: 400, body: { error: "signal must be \"bullish\" or \"bearish\"." } };
  }
  if (typeof price !== "number" || !Number.isFinite(price)) {
    logRejectedSignal(body, "invalid_price");
    return { status: 400, body: { error: "price must be a number." } };
  }
  if (typeof barTime !== "string" || !barTime) {
    logRejectedSignal(body, "invalid_bar_time");
    return { status: 400, body: { error: "bar_time is required." } };
  }

  // `test` is dropped from whatever arrived and only set from the server-side option.
  const { secret: _secret, test: _ignored, ...rest } = body;
  const savedSignal = receiveAndSaveSignal({
    botId: bot,
    signal,
    price,
    barTime,
    interval: typeof interval === "string" ? interval : "",
    raw: { ...rest, symbol, ...(options.test ? { test: true } : {}) },
  });

  // The decision logic (which can take up to the close/fill timeouts) runs in
  // the background, serialized per bot. Caught here so a misconfigured bot
  // logs loudly instead of becoming an unhandled rejection.
  const processing = withBotLock(bot, () => processSignal(savedSignal, { executor: options.executor })).catch((err) => {
    console.error(`[automation] signal ${savedSignal.id} for bot "${bot}" failed`, err);
  });

  return { status: 200, body: { received: true }, signalId: savedSignal.id, processing };
}
