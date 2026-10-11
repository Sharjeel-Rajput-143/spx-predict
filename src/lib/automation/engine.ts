import "server-only";
import crypto from "node:crypto";
import { originLabel } from "./origin";
import { botAccountId, ensureBotRecord, getBotLimits, getBotStaticConfig, listBotIds } from "./bots";
import {
  DEDUPE_WINDOW_SECONDS,
  ORDER_POLL_INTERVAL_MS,
  CLOSE_CONFIRM_TIMEOUT_SECONDS,
  ORDER_FILL_TIMEOUT_SECONDS,
  STRIKE_QUOTE_MAX_AGE_SECONDS,
  getFlipCooldownSeconds,
  isDryRun,
  isTestMode,
} from "./config";
import { logDecision } from "./decisions";
import { recordError } from "./errors";
import { expireStalePositions } from "./expiry";
import { watchOrder } from "./orderWatch";
import { placeAndWatch } from "./placeAndWatch";
import { getLastTick } from "@/lib/marketData/tickStore";
import { applyTradeOp, contractsToClose, describeFinals, describeClosePricing, describeQuantity, type ClosePricing } from "./closePricing";
import { resolveQuantity, resolveStrikeInputs } from "./openSettings";
import { DEFAULT_PRICE_TICK, buildLadder, describeLadder, spreadMarket, type Ladder, type SmartPricingMode } from "./smartPricing";
import {
  activePositionsForBot,
  activePositionsForBots,
  countTodayNewPositions,
  findOverlap,
  positionLegs,
  sumActiveAllocationRisk,
} from "./safeguards";
import { botsStore, ordersStore, positionsStore, signalsStore } from "./store";
import { describePlan, maxRisk, planStrikes, roundingWords, validateStrikes, type StrikePair, type StrikePlan } from "./strikes";
import { checkHolds, defaultCheck, describeCheck, isDefaultForm, matching, positionsWord, typeLabel } from "./positionChecks";
import { RunRecorder, describeLegs, typeName } from "./runTrace";
import { describeTradingTime, describeWindow, easternDateKey, hoursConfigFor, isWithinTradingHours } from "./tradingHours";
import type { BotStaticConfig, BrokerExecutor, SpreadQuoteRequest, DecisionOutcome, Order, Position, PositionType, Signal, SignalDirection } from "./types";

export interface ReceiveSignalInput {
  botId: string;
  signal: SignalDirection;
  price: number;
  barTime: string;
  interval: string;
  raw: unknown;
  now?: number;
}

/** Persists the raw signal immediately (spec: "once the signal is saved,
 * return 200 quickly") - decision logic runs afterward, inside the bot lock. */
export function receiveAndSaveSignal(input: ReceiveSignalInput): Signal {
  const now = input.now ?? Date.now();
  const row: Signal = {
    id: `sig-${now}-${crypto.randomUUID()}`,
    botId: input.botId,
    signal: input.signal,
    barTime: input.barTime,
    price: input.price,
    interval: input.interval,
    receivedAt: now,
    status: "accepted",
    raw: input.raw,
  };
  return signalsStore.insert(row);
}

export interface ProcessSignalOptions {
  executor: BrokerExecutor;
  now?: number;
  dryRun?: boolean;
  closeConfirmTimeoutMs?: number;
  orderFillTimeoutMs?: number;
  pollIntervalMs?: number;
  /** How long each SmartPricing rung waits, overriding the preset's seconds (tests use milliseconds). */
  ladderStepMs?: number;
  /** The underlying's latest live quote and its age, for a bot whose strikes come from a live quote. Default: the app's live price feed. */
  liveQuote?: (symbol: string) => LiveQuote | null;
}

/** A live price for the underlying, and how old it is. */
export interface LiveQuote {
  price: number;
  ageMs: number;
}

/** The app's own price feed (Google/Yahoo), the only quote source there is today. Its age is when it last got a price,
 * not an exchange timestamp, so a feed that is itself delayed can't be told apart by age. */
function feedQuote(symbol: string): LiveQuote | null {
  const tick = getLastTick(symbol);
  return tick ? { price: tick.price, ageMs: Math.max(0, Date.now() - tick.t) } : null;
}

function oppositeType(type: PositionType): PositionType {
  return type === "short_put_spread" ? "short_call_spread" : "short_put_spread";
}

function wantedType(signal: SignalDirection): PositionType {
  return signal === "bullish" ? "short_put_spread" : "short_call_spread";
}

interface DuplicateMatch {
  reason: string;
  signalId: string;
}

/** Only signals saved *before* this one can make it a duplicate. Both copies
 * of a double-delivered alert are persisted before either is processed, so
 * without that ordering each would see the other and both would be dropped -
 * the engine must act on exactly one. */
/** A signal the bot made for itself to retry a missed open: it is spaced by the retry rules, so the duplicate check neither applies to it nor counts it. */
const isRetrySignal = (s: Pick<Signal, "raw">) => (s.raw as { origin?: unknown } | null)?.origin === "retry";

function findDuplicateSignal(signal: Signal): DuplicateMatch | null {
  if (isRetrySignal(signal)) return null;
  const all = signalsStore.all();
  const index = all.findIndex((s) => s.id === signal.id);
  const earlier = (index === -1 ? all : all.slice(0, index)).filter(
    (s) => s.botId === signal.botId && s.status === "accepted" && s.signal === signal.signal && !isRetrySignal(s),
  );

  const sameBarTime = earlier.find((s) => s.barTime === signal.barTime);
  if (sameBarTime) {
    return { reason: `Same bar_time (${signal.barTime}) already processed.`, signalId: sameBarTime.id };
  }

  const windowMs = DEDUPE_WINDOW_SECONDS * 1000;
  const recentSame = earlier.find((s) => signal.receivedAt - s.receivedAt < windowMs);
  if (recentSame) {
    return { reason: `Identical signal received within ${DEDUPE_WINDOW_SECONDS}s.`, signalId: recentSame.id };
  }

  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What closed a position: the signal that did, or just the price when a person did it. */
interface CloseCause {
  id: string | null;
  price: number | null;
}

/** How a bot's orders are priced. */
interface Pricing {
  mode: SmartPricingMode;
  /** The final price as a percent of the way across the bid/ask. */
  percent: number;
  /** Seconds of waiting per rung, overriding the preset (tests use milliseconds). */
  stepMs?: number;
  width: number;
  /** A trigger's own Close Position pricing (several final prices, or a market order); the fields above are then its choices. */
  close?: ClosePricing;
  /** Send a market order: no ladder and no limit price. */
  market?: boolean;
}

/** The bot's pricing for a close, replaced by the trigger's own Close Position pricing when one was saved. */
export function applyClosePricing(base: Pricing, own?: ClosePricing): Pricing {
  if (!own) return base;
  if (own.speed === "market") return { ...base, market: true, close: own };
  return { ...base, mode: own.speed, percent: own.percent ?? base.percent, close: own };
}

export const pricingFor = (config: BotStaticConfig, side: "open" | "close", stepMs?: number): Pricing => ({
  mode: config.smartPricing ?? "normal",
  percent: (side === "open" ? config.openPricePercent : config.closePricePercent) ?? 100,
  stepMs,
  width: config.widthPoints,
});

/** What the engine knows about an order's price: the ladder it will walk, or why there isn't one. */
interface PricePlan {
  ladder: Ladder | null;
  /** In words, for the trace and the log. */
  note: string;
  /** Set when a quote exists but can't be traded on. */
  unusable?: string;
}

/** SmartPricing needs a market: the executor's quote of the spread. An executor without quotes (the mock) gets one
 * price, as before. A quote that fails to arrive falls back to that single price too - and says so. */
async function planPrice(executor: BrokerExecutor, side: "credit" | "debit", spread: SpreadQuoteRequest, pricing: Pricing, openedFor?: number | null): Promise<PricePlan> {
  if (!executor.getSpreadQuote) return { ladder: null, note: "One price (this executor has no market to quote)" };
  let legs: Awaited<ReturnType<NonNullable<BrokerExecutor["getSpreadQuote"]>>>;
  try {
    legs = await executor.getSpreadQuote(spread);
  } catch (err) {
    return { ladder: null, note: `One price (the quote failed: ${errorMessage(err)})` };
  }
  if (!legs) return { ladder: null, note: "One price (no quote available)" };
  const own = pricing.close;
  const finals = own ? { percent: own.percent, slippage: own.slippage, flat: own.flat, ...(own.tradePrice ? { tradePrice: applyTradeOp(openedFor, own.tradePrice) ?? undefined } : {}) } : undefined;
  const built = buildLadder({ side, legs, mode: pricing.mode, finalPercent: pricing.percent, ...(finals ? { finals } : {}), width: pricing.width, tick: DEFAULT_PRICE_TICK });
  if (!built.ok) return { ladder: null, note: `No usable price: ${built.reason}`, unusable: built.reason };
  return { ladder: built.ladder, note: describeLadder(built.ladder, own ? describeFinals(own) : pricing.percent) };
}

export const spreadOf = (p: Position): SpreadQuoteRequest => ({ underlying: p.underlying, optionRoot: p.optionRoot, expiry: p.expiry, type: p.type, shortStrike: p.shortStrike, longStrike: p.longStrike });

interface CloseResult {
  ok: boolean;
  outcome: DecisionOutcome;
  reason: string;
  /** How the close was priced, in words. */
  pricing?: string;
  /** One line per price the close tried. */
  steps?: string[];
  /** When only part of the position was closed: the closed record that part became. */
  closedPositionId?: string;
}

export async function closePosition(
  position: Position,
  signal: CloseCause | null,
  executor: BrokerExecutor,
  timeoutMs: number,
  pollIntervalMs: number,
  now: number,
  pricing?: Pricing,
  /** How many of the position's contracts to close; unset or all of them = the whole position. */
  contracts?: number,
): Promise<CloseResult> {
  const total = position.filledQuantity || position.requestedQuantity;
  const target = contracts !== undefined ? Math.min(total, Math.max(1, contracts)) : total;
  const partial = target < total;
  positionsStore.update(position.id, { status: "closing", closeSignalId: signal?.id ?? null });

  // Closing is a debit: buy the spread back. With a market to look at, walk from the mid toward the full spread;
  // with none (or an unusable quote) the executor's own default applies, as it always has.
  const plan: PricePlan | null = pricing?.market
    ? { ladder: null, note: "Market order (no limit price)" }
    : pricing && executor.getSpreadQuote
      ? await planPrice(executor, "debit", spreadOf(position), pricing, position.credit)
      : null;
  const ladder = plan?.ladder ?? null;
  const pricingNote = plan?.note;

  const result = await placeAndWatch({
    executor,
    kind: "close",
    positionId: position.id,
    now,
    place: (price) => executor.placeCloseOrder(position, { pricePercent: pricing?.percent, ...(price !== null ? { limitDebit: price } : {}), ...(partial ? { quantity: target } : {}) }),
    prices: ladder?.prices ?? null,
    stepMs: pricing?.stepMs ?? (ladder?.secondsEach ?? 0) * 1000,
    finalMs: timeoutMs,
    pollMs: pollIntervalMs,
    defaultLimit: 0,
    quantity: target,
  });
  if (!result.ok) {
    // Left "closing": we can't know the broker didn't take the order, so the
    // position keeps counting as live until an operator resolves it.
    return result.stage === "place"
      ? { ok: false, outcome: "executor_error", reason: `Close order failed: ${errorMessage(result.error)}`, pricing: pricingNote, steps: result.steps }
      : { ok: false, outcome: "executor_error", reason: `Lost track of close order ${result.ref}: ${errorMessage(result.error)}`, pricing: pricingNote, steps: result.steps };
  }
  const { state, timedOut, steps } = result;

  const targetQuantity = target;
  if (state.status === "filled" && state.filledQuantity >= targetQuantity && partial) {
    // Part of the position was closed: that part becomes its own closed record (so its result is counted), and the rest stays open.
    const closedAt = Date.now();
    const part: Position = {
      ...position,
      id: `pos-${now}-${crypto.randomUUID()}`,
      requestedQuantity: target,
      filledQuantity: target,
      status: "closed",
      closedAt,
      closePrice: state.averagePrice ?? null,
      underlyingAtClose: signal?.price ?? null,
      closeSignalId: signal?.id ?? null,
      splitFrom: position.id,
    };
    positionsStore.insert(part);
    positionsStore.update(position.id, { status: "open", requestedQuantity: total - target, filledQuantity: total - target, closeSignalId: null });
    return { ok: true, outcome: "closed", reason: `Close order filled: ${target} of ${total} contracts closed, ${total - target} still open.`, pricing: pricingNote, steps, closedPositionId: part.id };
  }
  if (state.status === "filled" && state.filledQuantity >= targetQuantity) {
    positionsStore.update(position.id, {
      status: "closed",
      closedAt: Date.now(),
      closePrice: state.averagePrice ?? null,
      underlyingAtClose: signal?.price ?? null,
    });
    return { ok: true, outcome: "closed", reason: "Close order filled.", pricing: pricingNote, steps };
  }
  if (state.status === "rejected") {
    return { ok: false, outcome: "close_rejected", reason: state.rejectReason ?? "Close order rejected.", pricing: pricingNote, steps };
  }
  if (state.filledQuantity === 0) {
    return { ok: false, outcome: "close_timeout", reason: timedOut ? "Close order never filled before the confirm timeout." : "Close order ended without filling.", pricing: pricingNote, steps };
  }
  return { ok: false, outcome: "close_partial_fill", reason: "Close order only partially filled. The rest was canceled; the position stays in closing, keeps its slot in the limits, and needs a person to clear it.", pricing: pricingNote, steps };
}

/** A close that was already in progress when a flip signal arrived: wait for it to be confirmed (the same wait and
 * timeout as a close the flip sends itself). With no order working behind a "closing" position there is nothing to
 * wait for, and no second close is sent either: it stays for a person to clear. */
async function awaitCloseInProgress(
  position: Position,
  order: Order | null,
  signal: CloseCause | null,
  executor: BrokerExecutor,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<CloseResult> {
  if (!order) {
    return { ok: false, outcome: "close_in_flight", reason: "This position is closing, but no close order is working and none confirmed. A second close isn't sent: check the broker, then clear it with Close position." };
  }
  let watched: Awaited<ReturnType<typeof watchOrder>>;
  try {
    watched = await watchOrder(executor, order.ref, { timeoutMs, pollIntervalMs, partialTimeoutMs: timeoutMs });
  } catch (err) {
    return { ok: false, outcome: "executor_error", reason: `Lost track of close order ${order.ref}: ${errorMessage(err)}` };
  }
  const { state, timedOut } = watched;
  ordersStore.update(order.id, { status: state.status, filledQuantity: state.filledQuantity, rejectReason: state.rejectReason, updatedAt: Date.now() });

  const target = position.filledQuantity || position.requestedQuantity;
  if (state.status === "filled" && state.filledQuantity >= target) {
    positionsStore.update(position.id, { status: "closed", closedAt: Date.now(), closePrice: state.averagePrice ?? null, underlyingAtClose: signal?.price ?? null });
    return { ok: true, outcome: "closed", reason: "The close that was already in progress is confirmed." };
  }
  if (state.status === "rejected") return { ok: false, outcome: "close_rejected", reason: state.rejectReason ?? "The close in progress was rejected." };
  if (state.filledQuantity === 0) return { ok: false, outcome: "close_timeout", reason: timedOut ? "The close in progress never filled before the confirm timeout." : "The close in progress ended without filling." };
  return { ok: false, outcome: "close_partial_fill", reason: "The close in progress only partially filled. The rest was canceled; the position stays closing and needs a person to clear it." };
}

/** The plan as stored on a decision: the numbers plus the sentence. */
const planDetail = (plan: StrikePlan) => ({ ...plan, text: describePlan(plan) });

const fmtLevel = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Why a signal's price can't be used, or null when it can. */
function priceRangeProblem(price: number, config: BotStaticConfig): string | null {
  if (!Number.isFinite(price) || price <= 0) return `Price ${price} is not a positive number.`;
  const range = config.priceRange;
  if (range && (price < range.min || price > range.max)) {
    return `Price ${fmtLevel(price)} is outside the ${config.underlying} sanity range ${fmtLevel(range.min)} - ${fmtLevel(range.max)}; nothing done.`;
  }
  return null;
}

export const closeTitle = (p: Position) => `Close Position (${p.underlying}, ${typeName(p.type)})`;

/** The settings a close order is sent with - a snapshot for the run log. */
function closeParamsFor(p: Position, timeoutMs: number, pricePercent = 100, how?: { note?: string; quotes: boolean; mode: SmartPricingMode }, closing?: { contracts: number; setting?: string }): { label: string; value: string }[] {
  const qty = p.filledQuantity || p.requestedQuantity;
  const n = closing?.contracts ?? qty;
  // With a market to price against the order walks a SmartPricing ladder; without one it goes out at a single price.
  const price = how?.note ?? (how?.quotes ? `SmartPricing ${how.mode}, final price ${pricePercent}% of bid/ask` : `${pricePercent}% of bid/ask (no limit price is sent yet)`);
  return [
    { label: "Price", value: price },
    { label: "Quantity", value: `${n} contract${n === 1 ? "" : "s"} (${closing?.setting ?? "100% of position"})` },
    { label: "Confirm timeout", value: `${Math.round(timeoutMs / 1000)}s` },
  ];
}

/**
 * The full per-signal decision logic (spec steps 0-10). Must always be
 * invoked through withBotLock so two signals for the same bot never run at
 * once. Takes an already-persisted signal row (see receiveAndSaveSignal).
 */
export async function processSignal(signal: Signal, options: ProcessSignalOptions): Promise<void> {
  const manual = (signal.raw as { source?: string } | null)?.source === "manual";
  const rec = new RunRecorder({
    id: signal.id,
    botId: signal.botId,
    signalId: signal.id,
    source: manual ? "manual" : "webhook",
    automation: `${signal.signal === "bullish" ? "Bullish" : signal.signal === "bearish" ? "Bearish" : "Unknown"} signal`,
    trigger: originLabel(signal), // "TradingView: BullishNDX", "Test Hook: BullishNDX", "Manual run"
    startedAt: options.now ?? Date.now(),
  });
  try {
    await runSignal(signal, options, rec);
  } catch (err) {
    // An unexpected crash must still leave a decision row (every run writes one), then surface as before.
    const reason = `Unexpected error: ${errorMessage(err)}`;
    rec.decision("Run finished without an unexpected error", false, errorMessage(err));
    logDecision({ signalId: signal.id, botId: signal.botId, outcome: "executor_error", reason, detail: { unexpected: true }, now: options.now ?? Date.now() });
    throw err;
  } finally {
    rec.save(); // even a run that threw keeps the steps it got through
  }
}

async function runSignal(signal: Signal, options: ProcessSignalOptions, rec: RunRecorder): Promise<void> {
  const now = options.now ?? Date.now();
  const closeTimeoutMs = options.closeConfirmTimeoutMs ?? CLOSE_CONFIRM_TIMEOUT_SECONDS * 1000;
  const openTimeoutMs = options.orderFillTimeoutMs ?? ORDER_FILL_TIMEOUT_SECONDS * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? ORDER_POLL_INTERVAL_MS;
  const dryRun = options.dryRun ?? isDryRun();
  /** Real clock at the start of the run: the flip's waits are real time, and they age the price taken at the call. */
  const runStartedAt = Date.now();
  const { botId } = signal;

  // Once the bot's settings are known, every decision of this run carries how its strikes
  // would be (or were) chosen: target price, rounding mode, the strikes.
  let plan: StrikePlan | null = null;
  const log = (outcome: DecisionOutcome, reason: string, detail: Record<string, unknown> = {}) =>
    logDecision({ signalId: signal.id, botId, outcome, reason, detail: { ...(plan ? { strikePlan: planDetail(plan) } : {}), ...detail }, now });

  // A required setting (e.g. the strike offsets) is missing: say so in the
  // decision log rather than only throwing into the route's console.
  let staticConfig: ReturnType<typeof getBotStaticConfig>;
  try {
    staticConfig = getBotStaticConfig(botId);
  } catch (err) {
    ensureBotRecord(botId);
    botsStore.update(botId, { needsAttention: true, needsAttentionReason: errorMessage(err) });
    rec.decision("Bot has its required trading inputs", false, errorMessage(err));
    log("config_error", errorMessage(err));
    return;
  }

  if (Number.isFinite(signal.price) && signal.price > 0) {
    plan = planStrikes(wantedType(signal.signal as SignalDirection), signal.price, staticConfig);
  }

  // Step 0: stale-position safety net (the EOD sweep is the primary mechanism).
  expireStalePositions(botId, now);

  // Step 1: the switches. The kill switch stops every webhook run completely. The bot's On/Off is softer, like
  // Option Alpha's "Always On" trigger, copied only for closes: with the bot off a webhook may still close the
  // opposite position (the flip's close), and may never open. The sweep and the Close position button ignore both.
  const bot = ensureBotRecord(botId);
  if (bot.killSwitch) {
    rec.decision("Kill switch is off", false, "Kill switch is on - nothing runs");
    log("kill_switch", "Kill switch is on: nothing was closed or opened.");
    return;
  }
  const direction = signal.signal as SignalDirection;
  // "Always On" (per trigger, on unless a person turned it off): with the bot off the trigger still runs its close part.
  const alwaysOn = bot.alwaysOn?.[direction] !== false;
  const closeOnly = !bot.enabled && alwaysOn;
  const closableNow = closeOnly ? activePositionsForBot(botId, oppositeType(wantedType(signal.signal as SignalDirection))) : [];
  rec.decision("Bot is switched on", bot.enabled, bot.enabled ? "Bot is on" : !alwaysOn ? "Bot is off and this trigger's Always On is off" : closableNow.length > 0 ? "Bot is off - this run may close, never open" : "Bot is off");
  if (!bot.enabled && !alwaysOn) {
    log("automations_off", "Bot off, and this trigger's Always On is off: nothing runs.");
    return;
  }
  if (closeOnly && closableNow.length === 0) {
    log("automations_off", "Bot off: nothing to close, and the Open step is blocked. Nothing was opened.");
    return;
  }

  // Each direction can be switched off on its own (Settings > Triggers).
  if (bot.triggers) {
    const on = bot.triggers[signal.signal as SignalDirection] !== false;
    rec.decision(`The ${signal.signal} trigger is switched on`, on, on ? "Trigger is on" : "Trigger is off");
    if (!on) {
      log("trigger_disabled", `The ${signal.signal} trigger is switched off for this bot.`);
      return;
    }
  }

  // Step 2: hours guard.
  const hours = hoursConfigFor(staticConfig.hours);
  const realInHours = isWithinTradingHours(now, hours);
  // Only the admin page's Send test alert can skip the clock, and only when AUTOMATION_TEST_MODE=true.
  // The flag is set server-side after the secret check; a webhook body can't carry it.
  const hoursSkipped = !realInHours && (signal.raw as { test?: unknown } | null)?.test === true && isTestMode();
  const inHours = realInHours || hoursSkipped;
  rec.decision(
    `Current market time is between ${describeWindow(hours)}`,
    inHours,
    hoursSkipped ? `Testing mode: clock check skipped. ${describeTradingTime(now, hours)}` : describeTradingTime(now, hours),
  );
  if (!inHours) {
    log("outside_hours", "Outside the configured trading window.");
    return;
  }

  // Data checks (after the switches and the clock, before anything is closed or opened): a signal from the wrong
  // chart must never turn into strikes for this bot's underlying.
  const symbol = (signal.raw as { symbol?: unknown } | null)?.symbol;
  if (typeof symbol === "string" && symbol.trim()) {
    const sent = symbol.trim().toUpperCase();
    const matches = sent === staticConfig.underlying.toUpperCase();
    rec.decision(`Signal symbol is ${staticConfig.underlying}`, matches, matches ? `Symbol ${sent}` : `The signal says ${sent}, this bot trades ${staticConfig.underlying}`);
    if (!matches) {
      log("symbol_mismatch", `Signal symbol "${sent}" doesn't match this bot's underlying ${staticConfig.underlying}; nothing done.`, { sent, expected: staticConfig.underlying });
      return;
    }
  }
  const priceProblem = priceRangeProblem(signal.price, staticConfig);
  rec.decision(
    staticConfig.priceRange ? `Price is between ${fmtLevel(staticConfig.priceRange.min)} and ${fmtLevel(staticConfig.priceRange.max)}` : "Price is a positive number",
    priceProblem === null,
    priceProblem ?? `Price ${fmtLevel(signal.price)}`,
  );
  if (priceProblem) {
    log("price_out_of_range", priceProblem, { price: signal.price, range: staticConfig.priceRange ?? null });
    return;
  }

  // Step 3: dedupe.
  const duplicate = findDuplicateSignal(signal);
  rec.decision("Signal isn't a duplicate", !duplicate, duplicate ? duplicate.reason : `No identical signal in the last ${DEDUPE_WINDOW_SECONDS}s, and none for this bar_time`);
  if (duplicate) {
    log("duplicate_signal", duplicate.reason, { matchedSignalId: duplicate.signalId });
    return;
  }

  // Step 4: sides. Safe to assert here - only `status: "accepted"` signals
  // (validated at the webhook route) ever reach processSignal.
  const wanted = wantedType(signal.signal as SignalDirection);
  const opposite = oppositeType(wanted);

  // Stage A: close the opposite side. Every status counts as held, like Option Alpha's "any status" - a position
  // that is already closing included. A closing position never gets a second close order: the flip waits for
  // the close that is in progress to be confirmed, and only then runs the Open step.
  const opposingPositions = activePositionsForBot(botId, opposite);
  /** Positions a dry run says it would have closed: the Open step is then judged as it would be after them. */
  const wouldClose = new Set<string>();

  // Optional minimum hold time (off by default): a flip inside the cooldown
  // leaves the existing position alone and opens nothing.
  const cooldownSeconds = getFlipCooldownSeconds();
  if (cooldownSeconds > 0) {
    const held = opposingPositions.find((p) => p.openedAt != null && now - p.openedAt < cooldownSeconds * 1000);
    rec.decision(`Position has been held at least ${cooldownSeconds}s`, !held, held ? `Held ${Math.round((now - (held.openedAt ?? now)) / 1000)}s` : "No position inside the cooldown");
    if (held) {
      log("cooldown_active", `Position held under ${cooldownSeconds}s; flip ignored.`, { positionId: held.id });
      return;
    }
  }

  // Day trading switched off: never close something opened today. 0DTE positions
  // are always same-day, so this means "hold to expiry" - the flip is skipped.
  if (!getBotLimits(botId).dayTradingAllowed) {
    const today = easternDateKey(now);
    const sameDay = opposingPositions.find((p) => p.openedAt != null && easternDateKey(p.openedAt) === today);
    rec.decision("Day trading is allowed", !sameDay, sameDay ? "The position was opened today" : "No position opened today");
    if (sameDay) {
      log("day_trading_blocked", "Day trading is not allowed for this bot, so a position opened today isn't closed. It is held to expiry.", { positionId: sameDay.id });
      return;
    }
  }

  // The check in front of the Close step, as edited on the canvas (unset: one or more of the opposite side, any status).
  const closeCheck = bot.positionChecks?.[direction]?.close ?? defaultCheck();
  const closeSide = typeLabel(opposite);
  const closeCounted = matching(activePositionsForBot(botId), closeCheck, closeSide).length;
  const closeYes = checkHolds(closeCheck, closeCounted);
  rec.decision(
    isDefaultForm(closeCheck, closeSide) ? `Bot has exactly or more than ${positionsWord(closeCheck.count)} with ${typeName(opposite)} type and any status` : describeCheck(closeCheck, closeSide),
    closeYes,
    positionsWord(closeCounted),
  );

  for (const position of closeYes ? opposingPositions : []) {
    if (closeOnly) log("bot_off_close_only", "Bot off, close only: handling the opposite position; nothing will be opened.", { positionId: position.id });
    const inFlight = ordersStore.query(
      (o) => o.positionId === position.id && o.kind === "close" && (o.status === "working" || o.status === "partially_filled"),
    );

    if (position.status === "closing" || inFlight.length > 0) {
      rec.decision(
        "The position isn't already closing",
        false,
        inFlight.length > 0 ? `A close order is working (${inFlight.length}) - no second close is sent` : "It is closing, with no close order working - no second close is sent",
      );
      if (dryRun) {
        wouldClose.add(position.id);
        rec.action({ action: "close", title: closeTitle(position), position, params: [{ label: "Wait", value: `up to ${Math.round(closeTimeoutMs / 1000)}s for the close in progress to be confirmed` }], outcome: "dry_run", reason: "Dry run: would wait for the close in progress to be confirmed." });
        log("dry_run", "Dry run: would wait for the close already in progress to be confirmed, then open.", { positionId: position.id, wouldClose: true });
        continue;
      }
      const waited = await awaitCloseInProgress(position, inFlight[0] ?? null, signal, options.executor, closeTimeoutMs, pollIntervalMs);
      rec.action({ action: "close", title: closeTitle(position), position: positionsStore.get(position.id) ?? position, params: [{ label: "Wait", value: `up to ${Math.round(closeTimeoutMs / 1000)}s for the close in progress to be confirmed` }], outcome: waited.outcome, reason: waited.reason });
      if (!waited.ok) {
        // An unconfirmed close with no order behind it was flagged when it went wrong; waiting on a real one that fails again is a new error.
        if (waited.outcome !== "close_in_flight") recordError(botId, "close_failed", { positionId: position.id, reason: waited.reason }, now);
        botsStore.update(botId, { needsAttention: true, needsAttentionReason: waited.reason });
        log(waited.outcome, waited.reason, { positionId: position.id });
        return; // Never open the new side while the old side might still be held.
      }
      log("closed", waited.reason, { positionId: position.id });
      continue;
    }

    rec.decision("The position isn't already closing", true, "No close order is working");

    const ownClose = bot.closeSettings?.[direction]?.pricing;
    const ownQuantity = bot.closeSettings?.[direction]?.quantity;
    const total = position.filledQuantity || position.requestedQuantity;
    const contracts = contractsToClose(total, ownQuantity);
    const closeHow = { quotes: !!options.executor.getSpreadQuote, mode: staticConfig.smartPricing ?? "normal", ...(ownClose ? { note: describeClosePricing(ownClose) } : {}) };
    const closeParams = closeParamsFor(position, closeTimeoutMs, staticConfig.closePricePercent, closeHow, { contracts, setting: describeQuantity(ownQuantity) });
    if (dryRun) {
      if (contracts >= total) wouldClose.add(position.id); // a partial close leaves the position held
      rec.action({ action: "close", title: closeTitle(position), position, params: closeParams, outcome: "dry_run", reason: "Dry run: would close; nothing sent." });
      log("dry_run", `Dry run: would close ${position.type} position.`, { positionId: position.id, wouldClose: true });
      continue;
    }

    const result = await closePosition(position, signal, options.executor, closeTimeoutMs, pollIntervalMs, now, applyClosePricing(pricingFor(staticConfig, "close", options.ladderStepMs), ownClose), contracts < total ? contracts : undefined);
    // The Memo and Tags set on this trigger's Close Position step go on the position it closed.
    const stepNote = bot.closeSettings?.[direction];
    if (stepNote?.memo || stepNote?.tags?.length) {
      const noted = result.closedPositionId ?? position.id;
      const now2 = positionsStore.get(noted) ?? position;
      positionsStore.update(noted, {
        ...(stepNote.memo ? { notes: [now2.notes, stepNote.memo].filter(Boolean).join("\n") } : {}),
        ...(stepNote.tags?.length ? { tags: [...new Set([...(now2.tags ?? []), ...stepNote.tags])] } : {}),
      });
    }
    rec.action({ action: "close", title: closeTitle(position), position: positionsStore.get(result.closedPositionId ?? position.id) ?? position, params: [...closeParamsFor(position, closeTimeoutMs, staticConfig.closePricePercent, { ...closeHow, note: result.pricing }, { contracts, setting: describeQuantity(ownQuantity) }), ...(stepNote?.memo ? [{ label: "Memo", value: stepNote.memo }] : []), ...(stepNote?.tags?.length ? [{ label: "Tags", value: stepNote.tags.join(", ") }] : [])], steps: result.steps, outcome: result.outcome, reason: result.reason });
    if (!result.ok) {
      recordError(botId, "close_failed", { positionId: position.id, reason: result.reason }, now);
      botsStore.update(botId, { needsAttention: true, needsAttentionReason: result.reason });
      log(result.outcome, result.reason, { positionId: position.id });
      return; // Never open the new side while the old side might still be held.
    }
    log("closed", result.reason, { positionId: position.id });
  }

  // The bot is off: the close above was all this run may do. The Open step is blocked.
  if (closeOnly) {
    rec.decision("Bot is switched on (the Open step)", false, "Bot off: the Open step is blocked");
    log("automations_off", "Bot off: the Open step is blocked. The opposite position was handled; nothing was opened.", { botOff: true });
    return;
  }

  // Stage B: open the wanted side - re-read fresh right before acting.
  await openStage({
    rec,
    botId,
    staticConfig,
    wanted,
    plan,
    signal,
    price: signal.price,
    executor: options.executor,
    now,
    dryRun,
    openTimeoutMs,
    pollIntervalMs,
    ladderStepMs: options.ladderStepMs,
    manual: false,
    wouldCloseIds: wouldClose,
    liveQuote: options.liveQuote ?? feedQuote,
    runStartedAt,
  });
}

interface OpenStageContext {
  rec?: RunRecorder;
  botId: string;
  staticConfig: BotStaticConfig;
  wanted: PositionType;
  /** Given for a manual position; otherwise derived from the signal's price. */
  strikes?: StrikePair;
  /** How the strikes were derived, for the decision log (absent for a manual position). */
  plan?: StrikePlan | null;
  signal: Signal | null;
  /** Underlying price when the position is opened. */
  price: number | null;
  executor: BrokerExecutor;
  now: number;
  dryRun: boolean;
  openTimeoutMs: number;
  pollIntervalMs: number;
  /** Overrides how long each SmartPricing rung waits (tests). */
  ladderStepMs?: number;
  manual: boolean;
  /** A dry run: positions it said it would close, which the Open step treats as gone. */
  wouldCloseIds?: ReadonlySet<string>;
  /** Where a live strike price comes from. */
  liveQuote?: (symbol: string) => LiveQuote | null;
  /** Date.now() when the run began, to work out how old the price taken at the call is by the time the Open step runs. */
  runStartedAt?: number;
}

export interface StageResult {
  ok: boolean;
  outcome: DecisionOutcome;
  reason: string;
}

/** Guards, strike validation, the order, and its fill - shared by the signal
 * path and a manually placed position. Writes exactly one decision row. */
async function openStage(ctx: OpenStageContext): Promise<StageResult> {
  const { botId, wanted, signal, executor, now } = ctx;
  // What this trigger's Open Position step was edited to do replaces the bot's own strike, size and price inputs below.
  let staticConfig = ctx.staticConfig;
  const limits = getBotLimits(botId);
  const bot = ensureBotRecord(botId);
  const openSettings = ctx.manual ? undefined : bot.openSettings?.[wanted === "short_put_spread" ? "bullish" : "bearish"];

  const rec = ctx.rec;
  let created: Position | null = null;
  let actionRecorded = false;
  /** The price the strikes are built from, and how they were derived from it: the alert's, or a live quote's. */
  let usedPrice: number | null = ctx.price;
  let usedPlan: StrikePlan | null | undefined = ctx.plan;
  /** Which price was used, how old it was when the Open step ran, and what it was - on every decision from there on. */
  let sourceDetail: Record<string, unknown> = {};
  let sourceNote: string | undefined;
  const gone = ctx.wouldCloseIds ?? new Set<string>();
  /** How the order is priced, once known: the SmartPricing ladder in words, and its numbers for the log. */
  let priceNote: string | undefined;
  let pricingDetail: Record<string, unknown> = {};
  /** One line per price the order tried, for the run trace. */
  let orderSteps: string[] = [];
  const side = wanted === "short_put_spread" ? "put" : "call";

  /** Records the open as an action card, once, when the run reaches its end. */
  const recordOpenAction = (outcome: DecisionOutcome, reason: string, strikes?: StrikePair) => {
    if (!rec || actionRecorded) return;
    actionRecorded = true;
    const position = created ? (positionsStore.get(created.id) ?? created) : null;
    const k = strikes ?? (position ? { shortStrike: position.shortStrike, longStrike: position.longStrike } : null);
    if (!k) return;
    const offset = wanted === "short_put_spread" ? staticConfig.putShortOffset : staticConfig.callShortOffset;
    rec.action({
      action: "open",
      title: `Open ${staticConfig.underlying} ${typeName(wanted)}`,
      position,
      summary: position ? undefined : describeLegs({ underlying: staticConfig.underlying, type: wanted, expiry: easternDateKey(now), shortStrike: k.shortStrike, longStrike: k.longStrike }),
      params: [
        // TODO(unconfirmed): what "% of bid/ask" means exactly - the owner is to confirm.
        { label: "Price", value: priceNote ?? `Limit credit $${staticConfig.openingCreditEstimate.toFixed(2)} (${staticConfig.openPricePercent ?? 100}% of bid/ask)` },
        { label: "Quantity", value: `${staticConfig.quantity} contract${staticConfig.quantity === 1 ? "" : "s"}` },
        ...(sourceNote ? [{ label: "Strike price", value: sourceNote }] : []),
        { label: "Expiration", value: `${easternDateKey(now)} (same day)` },
        {
          label: `Short ${side}`,
          value: ctx.manual || usedPrice == null || !usedPlan ? `${k.shortStrike} (entered by hand)` : `${k.shortStrike} (target ${fmtLevel(usedPlan.target)} = ${usedPrice} ${offset < 0 ? "-" : "+"} ${Math.abs(offset)}, rounded ${roundingWords(usedPlan)} ${usedPlan.rounding === "nearest" ? "" : "to "}${staticConfig.strikeIncrement})`,
        },
        { label: `Long ${side}`, value: `${k.longStrike} (${staticConfig.widthPoints} points ${side === "put" ? "below" : "above"} the short ${side})` },
        { label: "Fill timeout", value: `${Math.round(ctx.openTimeoutMs / 1000)}s` },
      ],
      steps: orderSteps,
      outcome,
      reason,
    });
  };

  const finish = (outcome: DecisionOutcome, reason: string, detail: Record<string, unknown> = {}): StageResult => {
    // Any run that ended after the position was created (filled, rejected, timed out, errored) gets its action card.
    if (created) recordOpenAction(outcome, reason);
    logDecision({
      signalId: signal?.id ?? null,
      botId,
      outcome,
      reason,
      detail: { ...(usedPlan ? { strikePlan: planDetail(usedPlan) } : {}), ...sourceDetail, ...pricingDetail, ...detail, ...(ctx.manual ? { manual: true } : {}), ...(rec && !signal ? { runId: rec.id } : {}) },
      now,
    });
    return { ok: outcome === "opened" || outcome === "dry_run", outcome, reason };
  };

  /** A limit triggered: the bot switches itself off, and says why in the log (and, through the
   * decision, as an alert) and on the status page. A person switches it back on after checking. */
  const stopAtLimit = (outcome: "total_position_limit_reached" | "daily_limit_reached" | "allocation_limit_reached", reason: string, detail: Record<string, unknown> = {}): StageResult => {
    botsStore.update(botId, { enabled: false, needsAttention: true, needsAttentionReason: `${outcome}: ${reason}` });
    return finish(outcome, `${reason} The bot has been switched off; switch it back on once you've checked it.`, { ...detail, botSwitchedOff: true });
  };

  // The check in front of the Open step, as edited on the canvas (unset: already held up to the bot's per-type limit).
  // A position placed by hand always uses the per-type limit; only a signal follows the canvas.
  const openCheck = (!ctx.manual && bot.positionChecks?.[wanted === "short_put_spread" ? "bullish" : "bearish"]?.open) || defaultCheck(limits.maxPositionsPerType);
  const wantedSide = typeLabel(wanted);
  const existingWanted = matching(activePositionsForBot(botId), openCheck, wantedSide);
  const alreadyHeld = checkHolds(openCheck, existingWanted.length);
  if (isDefaultForm(openCheck, wantedSide)) {
    rec?.decision(`Bot holds fewer than ${openCheck.count} ${typeName(wanted)} position${openCheck.count === 1 ? "" : "s"}`, !alreadyHeld, positionsWord(existingWanted.length));
  } else {
    rec?.decision(describeCheck(openCheck, wantedSide), alreadyHeld, positionsWord(existingWanted.length));
  }
  if (alreadyHeld) {
    return finish("already_in_position", "An active position of the wanted type already exists.");
  }

  const totalActive = activePositionsForBot(botId).filter((p) => !gone.has(p.id));
  rec?.decision(`Bot has fewer than ${limits.totalPositionLimit} open position${limits.totalPositionLimit === 1 ? "" : "s"}`, totalActive.length < limits.totalPositionLimit, `${totalActive.length} open`);
  if (totalActive.length >= limits.totalPositionLimit) {
    return stopAtLimit("total_position_limit_reached", "Total active position limit reached.", { limit: limits.totalPositionLimit, active: totalActive.length });
  }

  const todayNewPositions = countTodayNewPositions(botId, now, bot.dailyResetAt);
  rec?.decision(`Bot opened fewer than ${limits.dailyNewPositionLimit} new positions today`, todayNewPositions < limits.dailyNewPositionLimit, `${todayNewPositions} opened today`);
  if (todayNewPositions >= limits.dailyNewPositionLimit) {
    return stopAtLimit("daily_limit_reached", "Daily new-position limit reached.", { limit: limits.dailyNewPositionLimit, openedToday: todayNewPositions });
  }

  // The Entry Criteria ticked on this trigger's Open step: not meeting one means nothing is opened (nothing is wrong, so the bot stays on).
  const entry = openSettings?.entry;
  if (entry) {
    const checks: { text: string; pass: boolean; measured: string }[] = [];
    if (entry.lessOpen !== undefined) checks.push({ text: `Bot has less than ${entry.lessOpen} open position${entry.lessOpen === 1 ? "" : "s"}`, pass: totalActive.length < entry.lessOpen, measured: `${totalActive.length} open` });
    if (entry.lessToday !== undefined) checks.push({ text: `Bot opened less than ${entry.lessToday} new position${entry.lessToday === 1 ? "" : "s"} today`, pass: todayNewPositions < entry.lessToday, measured: `${todayNewPositions} opened today` });
    if (entry.lessForSymbol !== undefined) {
      const forSymbol = totalActive.filter((p) => p.underlying === staticConfig.underlying).length;
      checks.push({ text: `Bot has less than ${entry.lessForSymbol} open position${entry.lessForSymbol === 1 ? "" : "s"} with symbol ${staticConfig.underlying}`, pass: forSymbol < entry.lessForSymbol, measured: `${forSymbol} open with ${staticConfig.underlying}` });
    }
    for (const c of checks) {
      rec?.decision(c.text, c.pass, c.measured);
      if (!c.pass) return finish("entry_criteria_not_met", `Entry criteria not met: ${c.text.toLowerCase()} (${c.measured}). Nothing was opened.`, { criterion: c.text });
    }
  }

  // Which price the strikes are built from. The alert's (default), or - for a bot set to "live" - a quote taken now,
  // as the Open step runs (after a flip's close this can be minutes after the alert). Either way the choice, the
  // price and its age are logged, and the price-range check runs on the price that is actually used.
  if (!ctx.manual && signal) {
    const sourceSetting = staticConfig.strikePriceSource ?? "alert";
    const elapsedMs = Date.now() - (ctx.runStartedAt ?? Date.now());
    const seconds = (ms: number) => Math.round(ms / 100) / 10;
    if (sourceSetting === "alert") {
      const ageMs = Math.max(0, now - signal.receivedAt) + elapsedMs;
      sourceDetail = { priceSource: { source: "alert", price: signal.price, ageSeconds: seconds(ageMs) } };
      sourceNote = `price at the call ${fmtLevel(signal.price)}, ${seconds(ageMs)}s old`;
      rec?.decision("The strikes use the price when the call arrived", true, `Price at the call ${fmtLevel(signal.price)}, ${seconds(ageMs)}s old when the Open step ran`);
    } else {
      const quote = (ctx.liveQuote ?? feedQuote)(staticConfig.underlying);
      const maxAgeMs = STRIKE_QUOTE_MAX_AGE_SECONDS * 1000;
      const usable = !!quote && Number.isFinite(quote.price) && quote.price > 0 && quote.ageMs <= maxAgeMs;
      const measured = !quote ? `No live ${staticConfig.underlying} quote` : `Live ${staticConfig.underlying} quote ${fmtLevel(quote.price)}, ${seconds(quote.ageMs)}s old${usable ? "" : ` (older than the ${STRIKE_QUOTE_MAX_AGE_SECONDS}s allowed)`}`;
      rec?.decision("A fresh live quote is available for the strikes", usable, measured);
      if (!usable || !quote) {
        const reason = `No usable live ${staticConfig.underlying} quote for the strikes (${!quote ? "none available" : `${seconds(quote.ageMs)}s old, over the ${STRIKE_QUOTE_MAX_AGE_SECONDS}s allowed`}); nothing opened. This bot takes its strike price from a live quote; set the strike price source back to the alert's price to use that instead.`;
        return finish("no_live_price", reason, { priceSource: { source: "live", price: quote?.price ?? null, ageSeconds: quote ? seconds(quote.ageMs) : null } });
      }
      const problem = priceRangeProblem(quote.price, staticConfig);
      sourceDetail = { priceSource: { source: "live", price: quote.price, ageSeconds: seconds(quote.ageMs), alertPrice: signal.price } };
      sourceNote = `live quote ${fmtLevel(quote.price)}, ${seconds(quote.ageMs)}s old (alert said ${fmtLevel(signal.price)})`;
      rec?.decision(
        staticConfig.priceRange ? `The live price is between ${fmtLevel(staticConfig.priceRange.min)} and ${fmtLevel(staticConfig.priceRange.max)}` : "The live price is a positive number",
        problem === null,
        problem ?? measured,
      );
      if (problem) return finish("price_out_of_range", problem, { price: quote.price, range: staticConfig.priceRange ?? null });
      usedPrice = quote.price;
      usedPlan = planStrikes(wanted, quote.price, staticConfig);
    }
  }

  // The short and long strike methods and the position size set on this trigger's Open step.
  if (openSettings && !ctx.strikes) {
    const eff = resolveStrikeInputs(staticConfig, wanted, usedPrice ?? 0, openSettings);
    if (!eff.ok) {
      rec?.decision("The strikes follow this trigger's settings", false, eff.reason);
      recordError(botId, "invalid_strikes", { reason: eff.reason }, now);
      botsStore.update(botId, { needsAttention: true, needsAttentionReason: `invalid_strikes: ${eff.reason}` });
      return finish("invalid_strikes", eff.reason);
    }
    staticConfig = { ...staticConfig, ...eff.inputs };
    if (eff.words.length > 0) {
      usedPlan = planStrikes(wanted, usedPrice ?? 0, staticConfig);
      rec?.decision("The strikes follow this trigger's settings", true, eff.words.join("; "));
    }
    if (openSettings.size) {
      const sized = resolveQuantity(staticConfig, openSettings.size, staticConfig.widthPoints);
      rec?.decision("The position size is at least 1 contract", sized.quantity >= 1, `${sized.quantity} contract${sized.quantity === 1 ? "" : "s"}: ${sized.words}`);
      if (sized.quantity < 1) return finish("size_too_small", `The position size works out to less than 1 contract (${sized.words}); nothing was opened.`, { sizing: sized.words });
      staticConfig = { ...staticConfig, quantity: sized.quantity };
    }
  }

  const strikes = ctx.strikes ?? planStrikes(wanted, usedPrice ?? 0, staticConfig);
  const validation = validateStrikes(wanted, strikes, staticConfig);
  rec?.decision("Strikes pass the checks (order, not equal, on the increment, the right width)", validation.ok, validation.ok ? (usedPlan ? describePlan(usedPlan) : `Short ${strikes.shortStrike}, long ${strikes.longStrike}`) : `${validation.reason} (short ${strikes.shortStrike}, long ${strikes.longStrike})`);
  if (!validation.ok) {
    recordError(botId, "invalid_strikes", { strikes, reason: validation.reason }, now);
    botsStore.update(botId, { needsAttention: true, needsAttentionReason: `invalid_strikes: ${validation.reason}` });
    return finish("invalid_strikes", validation.reason ?? "Invalid strikes.", { strikes });
  }

  const projectedRisk = maxRisk(staticConfig.widthPoints, staticConfig.quantity, staticConfig.openingCreditEstimate);
  const currentRisk = sumActiveAllocationRisk(botId, staticConfig.widthPoints, staticConfig.openingCreditEstimate, gone);
  rec?.decision(
    `Opening stays within the $${staticConfig.allocationLimit.toLocaleString("en-US")} allocation`,
    currentRisk + projectedRisk <= staticConfig.allocationLimit,
    `$${Math.round(currentRisk).toLocaleString("en-US")} at risk + $${Math.round(projectedRisk).toLocaleString("en-US")} for this trade`,
  );
  if (currentRisk + projectedRisk > staticConfig.allocationLimit) {
    return stopAtLimit("allocation_limit_reached", "Opening this position would exceed the allocation limit.", {
      currentRisk,
      projectedRisk,
      allocationLimit: staticConfig.allocationLimit,
    });
  }

  const expiry = easternDateKey(now);
  let ladderPrices: number[] | null = null;
  let ladderStepMs = 0;
  const newLegs = positionLegs({
    underlying: staticConfig.underlying,
    expiry,
    shortStrike: strikes.shortStrike,
    longStrike: strikes.longStrike,
    type: wanted,
  });
  const accountBotIds = listBotIds().filter((id) => botAccountId(id) === staticConfig.accountId);
  const overlap = findOverlap(newLegs, activePositionsForBots(accountBotIds).filter((p) => !gone.has(p.id)));
  rec?.decision("No leg collides with an existing position", !overlap, overlap ? `Overlaps ${describeLegs(overlap)}` : "No overlapping legs");
  if (overlap) {
    return finish("overlapping_strikes", "New legs collide with an existing active position.", { overlapPositionId: overlap.id });
  }

  // The Position Criteria ticked on this trigger's Open step. The ones about the spread's own quote need one; with none they can't be met.
  const wantsPosition = openSettings?.position;
  if (wantsPosition && Object.keys(wantsPosition).length > 0) {
    const c = wantsPosition;
    const checks: { text: string; pass: boolean; measured: string }[] = [];
    const width = staticConfig.widthPoints;
    if (c.widthMin !== undefined || c.widthMax !== undefined) {
      checks.push({ text: `The spread width is between ${c.widthMin ?? "any"} and ${c.widthMax ?? "any"}`, pass: width >= (c.widthMin ?? 0) && width <= (c.widthMax ?? Infinity), measured: `Width ${width}` });
    }
    if (c.otmPercentAbove !== undefined) {
      const px = usedPrice ?? 0;
      const otm = px > 0 ? ((wanted === "short_put_spread" ? px - strikes.shortStrike : strikes.shortStrike - px) / px) * 100 : -100;
      checks.push({ text: `The short strike is more than ${c.otmPercentAbove}% out of the money`, pass: otm > c.otmPercentAbove, measured: `${(Math.round(otm * 1000) / 1000).toString()}% out of the money` });
    }
    if (c.maxBidAskSpread !== undefined || c.midMin !== undefined || c.midMax !== undefined) {
      let market: ReturnType<typeof spreadMarket> = null;
      if (executor.getSpreadQuote) {
        try {
          const legs = await executor.getSpreadQuote({ underlying: staticConfig.underlying, optionRoot: staticConfig.optionRoot, expiry, type: wanted, shortStrike: strikes.shortStrike, longStrike: strikes.longStrike });
          market = legs ? spreadMarket("credit", legs) : null;
        } catch {
          market = null;
        }
      }
      const note = market ? "" : "No quote for the spread, so this can't be checked";
      if (c.maxBidAskSpread !== undefined) {
        const gap = market ? Math.round((market.best - market.natural) * 100) / 100 : null;
        checks.push({ text: `The bid/ask spread is less than $${c.maxBidAskSpread}`, pass: gap !== null && gap < c.maxBidAskSpread, measured: gap !== null ? `$${gap.toFixed(2)}` : note });
      }
      if (c.midMin !== undefined || c.midMax !== undefined) {
        const mid = market ? Math.round(market.mid * 100) / 100 : null;
        checks.push({ text: `The mid price is between $${c.midMin ?? "any"} and $${c.midMax ?? "any"}`, pass: mid !== null && mid >= (c.midMin ?? 0) && mid <= (c.midMax ?? Infinity), measured: mid !== null ? `$${mid.toFixed(2)}` : note });
      }
    }
    for (const check of checks) {
      rec?.decision(check.text, check.pass, check.measured);
      if (!check.pass) return finish("position_criteria_not_met", `Position criteria not met: ${check.text.toLowerCase()} (${check.measured}). Nothing was opened.`, { criterion: check.text });
    }
  }

  // With a market to look at (a real executor), price the order off the spread's own bid/ask: a SmartPricing ladder.
  if (executor.getSpreadQuote) {
    const priced = await planPrice(executor, "credit", { underlying: staticConfig.underlying, optionRoot: staticConfig.optionRoot, expiry, type: wanted, shortStrike: strikes.shortStrike, longStrike: strikes.longStrike }, applyClosePricing(pricingFor(staticConfig, "open", ctx.ladderStepMs), openSettings?.pricing));
    ladderPrices = priced.ladder?.prices ?? null;
    ladderStepMs = (priced.ladder?.secondsEach ?? 0) * 1000;
    priceNote = priced.note;
    pricingDetail = { pricing: { note: priced.note, ...(priced.ladder ? { mode: priced.ladder.mode, prices: priced.ladder.prices, mid: priced.ladder.mid, final: priced.ladder.final } : {}) } };
    rec?.decision("The spread has a price to trade at", !priced.unusable, priced.note);
    if (priced.unusable) return finish("open_rejected", `No usable price for this spread: ${priced.unusable}`);
  }

  if (ctx.dryRun) {
    recordOpenAction("dry_run", "Dry run: nothing sent.", strikes);
    return finish("dry_run", `Dry run: would open ${wanted} at ${strikes.shortStrike}/${strikes.longStrike}.`, { strikes, wanted });
  }

  const position: Position = {
    id: `pos-${now}-${crypto.randomUUID()}`,
    botId,
    underlying: staticConfig.underlying,
    type: wanted,
    shortStrike: strikes.shortStrike,
    longStrike: strikes.longStrike,
    requestedQuantity: staticConfig.quantity,
    filledQuantity: 0,
    expiry,
    status: "opening",
    credit: null,
    openedAt: now,
    closedAt: null,
    openSignalId: signal?.id ?? null,
    closeSignalId: null,
    brokerOrderRef: null,
    underlyingAtOpen: usedPrice,
    manual: ctx.manual,
    venue: executor.venue ?? "mock",
    optionRoot: staticConfig.optionRoot,
    ...(openSettings?.exit && Object.keys(openSettings.exit).length > 0 ? { exitOptions: openSettings.exit } : {}),
    ...((signal?.raw as { test?: unknown } | null)?.test === true ? { test: true } : {}),
  };
  positionsStore.insert(position);
  created = position;

  // An executor exception leaves the position "opening" on purpose: the
  // order may have reached the broker, so it keeps blocking duplicate entries
  // until an operator checks.
  const failOpen = (reason: string): StageResult => {
    recordError(botId, "open_failed", { positionId: position.id, reason }, now);
    botsStore.update(botId, { needsAttention: true, needsAttentionReason: reason });
    return finish("executor_error", reason, { positionId: position.id });
  };

  const result = await placeAndWatch({
    executor,
    kind: "open",
    positionId: position.id,
    now,
    place: (price) =>
      executor.placeOpenOrder({
        botId,
        pricePercent: staticConfig.openPricePercent,
        underlying: staticConfig.underlying,
        optionRoot: staticConfig.optionRoot,
        positionType: wanted,
        shortStrike: strikes.shortStrike,
        longStrike: strikes.longStrike,
        quantity: staticConfig.quantity,
        limitCredit: price ?? staticConfig.openingCreditEstimate,
        expiry,
      }),
    prices: ladderPrices,
    stepMs: ctx.ladderStepMs ?? ladderStepMs,
    finalMs: ctx.openTimeoutMs,
    pollMs: ctx.pollIntervalMs,
    defaultLimit: staticConfig.openingCreditEstimate,
    quantity: staticConfig.quantity,
  });
  orderSteps = result.steps;
  pricingDetail = { ...pricingDetail, steps: result.steps };
  if (!result.ok) {
    return failOpen(result.stage === "place" ? `Open order failed: ${errorMessage(result.error)}` : `Lost track of open order ${result.ref}: ${errorMessage(result.error)}`);
  }
  const { state, timedOut } = result;

  // Nothing filled: the broker rejected it, or it ended (our timeout, or canceled elsewhere) with no fill.
  if (state.status === "rejected" || state.filledQuantity === 0) {
    positionsStore.update(position.id, { status: "rejected" });
    const reason = state.rejectReason ?? (timedOut ? "Open order timed out unfilled." : "Open order ended without filling.");
    recordError(botId, "open_failed", { positionId: position.id, reason }, now);
    return finish(state.status === "rejected" ? "open_rejected" : "open_timeout_no_fill", reason, { positionId: position.id, rungsTried: result.rungsTried });
  }

  // Full fill, or a partial the timeout settled at - both become `open` at
  // whatever size actually filled (spec: the remainder is simply canceled).
  positionsStore.update(position.id, {
    status: "open",
    filledQuantity: state.filledQuantity,
    credit: state.averagePrice ?? staticConfig.openingCreditEstimate,
    ...(openSettings?.tags?.length ? { tags: [...new Set([...(positionsStore.get(position.id)?.tags ?? []), ...openSettings.tags])] } : {}),
  });
  const partial = state.filledQuantity < staticConfig.quantity;
  return finish(
    "opened",
    partial
      ? `Opened new position at the partial size: ${state.filledQuantity} of ${staticConfig.quantity} contracts filled; the rest was canceled.`
      : "Opened new position.",
    { positionId: position.id, filledQuantity: state.filledQuantity, requestedQuantity: staticConfig.quantity, partial, rungsTried: result.rungsTried },
  );
}

// ---------------------------------------------------------------------------
// Manual actions from the UI. They go through the same guards, executor and
// decision log as a signal - there is no back door around the safeguards.
// ---------------------------------------------------------------------------

export interface ManualOptions {
  executor: BrokerExecutor;
  now?: number;
  dryRun?: boolean;
  closeConfirmTimeoutMs?: number;
  orderFillTimeoutMs?: number;
  pollIntervalMs?: number;
  ladderStepMs?: number;
}

/** Places a position at an explicit short strike (long derived from the bot's
 * width). Must run inside withBotLock. */
export async function manualOpen(
  botId: string,
  input: { type: PositionType; shortStrike: number; underlyingPrice?: number | null },
  options: ManualOptions,
): Promise<StageResult> {
  const now = options.now ?? Date.now();
  const staticConfig = getBotStaticConfig(botId);
  const rec = new RunRecorder({ botId, signalId: null, source: "ui", automation: "Manual position", trigger: "Manual action", startedAt: now });
  const log = (outcome: DecisionOutcome, reason: string): StageResult => {
    logDecision({ signalId: null, botId, outcome, reason, detail: { manual: true, runId: rec.id }, now });
    return { ok: false, outcome, reason };
  };

  try {
    expireStalePositions(botId, now);
    // Opens always respect the switches (only closing is exempt).
    const switches = ensureBotRecord(botId);
    if (switches.killSwitch) {
      rec.decision("Kill switch is off", false, "Kill switch is on");
      return log("kill_switch", "Kill switch is on: nothing was opened.");
    }
    if (!switches.enabled) {
      rec.decision("Bot is switched on", false, "Bot is off");
      return log("automations_off", "Bot off: the Open step is blocked. Nothing was opened.");
    }
    const hours = hoursConfigFor(staticConfig.hours);
    const inHours = isWithinTradingHours(now, hours);
    rec.decision(`Current market time is between ${describeWindow(hours)}`, inHours, describeTradingTime(now, hours));
    if (!inHours) return log("outside_hours", "Outside the configured trading window.");

    const longStrike = input.type === "short_put_spread" ? input.shortStrike - staticConfig.widthPoints : input.shortStrike + staticConfig.widthPoints;
    return await openStage({
      rec,
      botId,
      staticConfig,
      wanted: input.type,
      strikes: { shortStrike: input.shortStrike, longStrike },
      signal: null,
      price: input.underlyingPrice ?? null,
      executor: options.executor,
      now,
      dryRun: options.dryRun ?? isDryRun(),
      openTimeoutMs: options.orderFillTimeoutMs ?? ORDER_FILL_TIMEOUT_SECONDS * 1000,
      pollIntervalMs: options.pollIntervalMs ?? ORDER_POLL_INTERVAL_MS,
      ladderStepMs: options.ladderStepMs,
      manual: true,
    });
  } finally {
    rec.save();
  }
}

/** Closes one active position now. A failed close is handled exactly like a
 * failed flip: error recorded, bot flagged needs_attention. Must run inside withBotLock. */
export async function manualClose(positionId: string, options: ManualOptions & { underlyingPrice?: number | null }): Promise<StageResult> {
  const now = options.now ?? Date.now();
  const position = positionsStore.get(positionId);
  if (!position) throw new Error("Position not found.");
  const { botId } = position;
  const rec = new RunRecorder({ botId, signalId: null, source: "ui", automation: "Manual close", trigger: "Manual action", startedAt: now });
  const log = (outcome: DecisionOutcome, reason: string, ok = false): StageResult => {
    logDecision({ signalId: null, botId, outcome, reason, detail: { manual: true, positionId, runId: rec.id }, now });
    return { ok, outcome, reason };
  };

  if (position.status !== "open" && position.status !== "closing") {
    throw new Error(`A position that is ${position.status} can't be closed.`);
  }

  try {
    rec.decision("Position is open", true, `Status is ${position.status}`);
    const inFlight = ordersStore.query(
      (o) => o.positionId === position.id && o.kind === "close" && (o.status === "working" || o.status === "partially_filled"),
    );
    rec.decision("No close order is already in flight for it", inFlight.length === 0, inFlight.length === 0 ? "No working close order" : `${inFlight.length} working close order`);
    if (inFlight.length > 0) return log("close_in_flight", "A close order for this position is already in flight; nothing sent.");

    const closeTimeoutMs = options.closeConfirmTimeoutMs ?? CLOSE_CONFIRM_TIMEOUT_SECONDS * 1000;
    let botConfig: BotStaticConfig | null = null;
    try {
      botConfig = getBotStaticConfig(botId);
    } catch {
      /* a bot without complete inputs: the defaults apply */
    }
    const closeHow = { quotes: !!options.executor.getSpreadQuote, mode: botConfig?.smartPricing ?? ("normal" as SmartPricingMode) };
    const params = closeParamsFor(position, closeTimeoutMs, botConfig?.closePricePercent, closeHow);
    if (options.dryRun ?? isDryRun()) {
      rec.action({ action: "close", title: closeTitle(position), position, params, outcome: "dry_run", reason: "Dry run: nothing sent." });
      return log("dry_run", `Dry run: would close ${position.type} position.`, true);
    }

    const result = await closePosition(
      position,
      { id: null, price: options.underlyingPrice ?? null },
      options.executor,
      closeTimeoutMs,
      options.pollIntervalMs ?? ORDER_POLL_INTERVAL_MS,
      now,
      botConfig ? pricingFor(botConfig, "close", options.ladderStepMs) : undefined,
    );
    rec.action({ action: "close", title: closeTitle(position), position: positionsStore.get(position.id) ?? position, params: closeParamsFor(position, closeTimeoutMs, botConfig?.closePricePercent, { ...closeHow, note: result.pricing }), steps: result.steps, outcome: result.outcome, reason: result.reason });
    if (!result.ok) {
      recordError(botId, "close_failed", { positionId, reason: result.reason }, now);
      ensureBotRecord(botId);
      botsStore.update(botId, { needsAttention: true, needsAttentionReason: result.reason });
    }
    return log(result.outcome, result.reason, result.ok);
  } finally {
    rec.save();
  }
}
