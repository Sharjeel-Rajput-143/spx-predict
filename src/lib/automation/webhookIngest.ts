import "server-only";
import crypto from "node:crypto";
import { BTC_BOT_ID, isKnownBot } from "./bots";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { withBotLock } from "./botLock";
import { getWebhookSecret } from "./config";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { startEodScheduler } from "./eodSweep";
import { executorStatus, liveExecutorProblem } from "./sharedExecutor";
import { signalsStore, storageProblem } from "./store";
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

/** A call that failed the secret can come from anyone on the internet. It is still refused and still shows in the Log, but it can't
 * be used to fill the database: at most this many such rows an hour (every request on a host with a database loads them all). */
export const MAX_BAD_SECRET_ROWS_PER_HOUR = 20;

/** What is kept of a stranger's message: a few short plain values, never the whole body. */
function boundedRaw(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body).slice(0, 10)) {
    out[key.slice(0, 40)] = typeof value === "string" ? value.slice(0, 200) : typeof value === "number" || typeof value === "boolean" || value === null ? value : "[not kept]";
  }
  return out;
}

/** Spec: "store nothing except a rejected log row" on a bad secret - and
 * never the secret itself, here or anywhere else. */
function logRejectedSignal(body: Record<string, unknown>, reason: string) {
  const now = Date.now();
  if (reason === "bad_secret") {
    const recent = signalsStore.query((s) => s.rejectReason === "bad_secret" && now - s.receivedAt < 60 * 60_000).length;
    if (recent >= MAX_BAD_SECRET_ROWS_PER_HOUR) return; // refused all the same; just not written down again
  }
  const { secret: _secret, ...redacted } = body;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  signalsStore.insert({
    id: `sig-rejected-${now}-${crypto.randomUUID()}`,
    botId: typeof body.bot === "string" ? text(body.bot, 60) : "unknown",
    signal: text(body.signal, 20),
    barTime: text(body.bar_time, 60),
    price: typeof body.price === "number" ? body.price : 0,
    interval: text(body.interval, 10),
    receivedAt: now,
    status: "rejected",
    rejectReason: reason,
    raw: boundedRaw(redacted),
  });
}

export interface IngestOptions {
  executor: BrokerExecutor;
  /** Set only by the admin page's Send test alert, after its own auth. A `test` field in a webhook body is ignored. */
  test?: boolean;
  /** The caller was already authenticated another way (a named webhook's secret URL), so the shared secret in the body isn't checked. */
  trusted?: boolean;
  /** Set only by the mirror (liveMirror.ts), server side: the signal is a copy of this demo bot's. The live bot accepts a signal from nowhere else: not the shared secret, not a test alert. */
  mirrorOf?: string;
}

export interface IngestResult {
  status: number;
  body: Record<string, unknown>;
  /** The saved signal's id, once accepted. */
  signalId?: string;
  /** Resolves when the decision logic for an accepted signal has finished (never rejects). */
  processing?: Promise<void>;
}

/** On a serverless host (a demo) the work must finish before the answer goes out - the function may be stopped the moment
 * it responds. The mock fills at once, so this takes a moment; anywhere else the answer still goes out immediately. */
export async function settleIfServerless(result: IngestResult, maxMs = 8000): Promise<void> {
  if (!process.env.VERCEL || !result.processing) return;
  await Promise.race([result.processing, new Promise<void>((r) => setTimeout(r, maxMs))]);
}

export function ingestWebhook(parsed: unknown, options: IngestOptions): IngestResult {
  // First of all: a host that can't keep records can't run the engine, and must not half-process (or half-log) an alert.
  const storage = storageProblem();
  if (storage) return { status: 503, body: { error: storage } };

  startEodScheduler();

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: 400, body: { error: "Malformed request body." } };
  }
  const body = parsed as Record<string, unknown>;

  if (!options.trusted && !secretMatches(body.secret)) {
    logRejectedSignal(body, "bad_secret");
    return { status: 401, body: { error: "Unauthorized." } };
  }

  // A misconfigured broker executor (EXECUTOR=tradier without its token) refuses
  // signals up front rather than failing halfway through one.
  // Each bot is held to its OWN executor: a broken demo executor setting does not refuse the live bot's copy of an alert (its executor is checked by the engine, and it refuses in words).
  const target = (parsed as { bot?: unknown }).bot;
  const problem = target === LIVE_BOT_ID && options.mirrorOf === BTC_BOT_ID ? liveExecutorProblem() : executorStatus().error;
  if (problem) return { status: 503, body: { error: problem } };

  const { bot, signal, symbol, price, bar_time: barTime, interval } = body;

  if (typeof bot !== "string" || !isKnownBot(bot)) {
    logRejectedSignal(body, "unknown_bot");
    return { status: 400, body: { error: "Unknown bot." } };
  }
  // The live bot is reached only by the mirror. Anyone else naming it (an outside call with the shared secret, the admin page's test alert) is told it does not exist.
  if (bot === LIVE_BOT_ID && options.mirrorOf !== BTC_BOT_ID) {
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
    raw: { ...rest, symbol, origin: options.test ? "test_hook" : "tradingview", ...(options.test ? { test: true } : {}) },
  });

  // The decision logic (which can take up to the close/fill timeouts) runs in
  // the background, serialized per bot. Caught here so a misconfigured bot
  // logs loudly instead of becoming an unhandled rejection.
  const processing = withBotLock(bot, () => processSignal(savedSignal, { executor: options.executor })).catch((err) => {
    console.error(`[automation] signal ${savedSignal.id} for bot "${bot}" failed`, err);
  });

  return { status: 200, body: { received: true }, signalId: savedSignal.id, processing };
}
