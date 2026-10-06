import "server-only";
import crypto from "node:crypto";
import { botAccountId, ensureBotRecord, getBotLimits, getBotStaticConfig, listBotIds } from "./bots";
import {
  DEDUPE_WINDOW_SECONDS,
  ORDER_POLL_INTERVAL_MS,
  CLOSE_CONFIRM_TIMEOUT_SECONDS,
  ORDER_FILL_TIMEOUT_SECONDS,
  getFlipCooldownSeconds,
  isDryRun,
  isTestMode,
} from "./config";
import { logDecision } from "./decisions";
import { recordError } from "./errors";
import { expireStalePositions } from "./expiry";
import { watchOrder } from "./orderWatch";
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
import { RunRecorder, describeLegs, typeName } from "./runTrace";
import { describeTradingTime, describeWindow, easternDateKey, hoursConfigFor, isWithinTradingHours } from "./tradingHours";
import type { BotStaticConfig, BrokerExecutor, DecisionOutcome, Order, Position, PositionType, Signal, SignalDirection } from "./types";

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
function findDuplicateSignal(signal: Signal): DuplicateMatch | null {
  const all = signalsStore.all();
  const index = all.findIndex((s) => s.id === signal.id);
  const earlier = (index === -1 ? all : all.slice(0, index)).filter(
    (s) => s.botId === signal.botId && s.status === "accepted" && s.signal === signal.signal,
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

interface CloseResult {
  ok: boolean;
  outcome: DecisionOutcome;
  reason: string;
}

/** What closed a position: the signal that did, or just the price when a person did it. */
interface CloseCause {
  id: string | null;
  price: number | null;
}

async function closePosition(
  position: Position,
  signal: CloseCause | null,
  executor: BrokerExecutor,
  timeoutMs: number,
  pollIntervalMs: number,
  now: number,
  pricePercent?: number,
): Promise<CloseResult> {
  positionsStore.update(position.id, { status: "closing", closeSignalId: signal?.id ?? null });
  let ref: string;
  try {
    ({ ref } = await executor.placeCloseOrder(position, { pricePercent }));
  } catch (err) {
    // Left "closing": we can't know the broker didn't take the order, so the
    // position keeps counting as live until an operator resolves it.
    return { ok: false, outcome: "executor_error", reason: `Close order failed: ${errorMessage(err)}` };
  }
  positionsStore.update(position.id, { brokerOrderRef: ref });

  const orderRow: Order = {
    id: `ord-${now}-${crypto.randomUUID()}`,
    positionId: position.id,
    kind: "close",
    status: "working",
    limitPrice: 0,
    filledQuantity: 0,
    ref,
    createdAt: now,
    updatedAt: now,
  };
  ordersStore.insert(orderRow);

  let watched: Awaited<ReturnType<typeof watchOrder>>;
  try {
    watched = await watchOrder(executor, ref, { timeoutMs, pollIntervalMs });
  } catch (err) {
    return { ok: false, outcome: "executor_error", reason: `Lost track of close order ${ref}: ${errorMessage(err)}` };
  }
  const { state, timedOut } = watched;
  ordersStore.update(orderRow.id, {
    status: state.status,
    filledQuantity: state.filledQuantity,
    rejectReason: state.rejectReason,
    updatedAt: Date.now(),
  });

  const targetQuantity = position.filledQuantity || position.requestedQuantity;
  if (state.status === "filled" && state.filledQuantity >= targetQuantity) {
    positionsStore.update(position.id, {
      status: "closed",
      closedAt: Date.now(),
      closePrice: state.averagePrice ?? null,
      underlyingAtClose: signal?.price ?? null,
    });
    return { ok: true, outcome: "closed", reason: "Close order filled." };
  }
  if (state.status === "rejected") {
    return { ok: false, outcome: "close_rejected", reason: state.rejectReason ?? "Close order rejected." };
  }
  if (timedOut && state.filledQuantity === 0) {
    return { ok: false, outcome: "close_timeout", reason: "Close order never filled before the confirm timeout." };
  }
  return { ok: false, outcome: "close_partial_fill", reason: "Close order only partially filled." };
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

const closeTitle = (p: Position) => `Close Position (${p.underlying}, ${typeName(p.type)})`;

/** The settings a close order is sent with - a snapshot for the run log. */
function closeParamsFor(p: Position, timeoutMs: number, pricePercent = 100): { label: string; value: string }[] {
  const qty = p.filledQuantity || p.requestedQuantity;
  return [
    // TODO(unconfirmed): what "% of bid/ask" means exactly - the owner is to confirm. No limit price is computed or sent yet.
    { label: "Price", value: `${pricePercent}% of bid/ask (no limit price is sent yet)` },
    { label: "Quantity", value: `${qty} contract${qty === 1 ? "" : "s"} (100% of position)` },
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
    trigger: manual ? "Manual run" : "Webhook",
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

  // Step 1: kill switch.
  const bot = ensureBotRecord(botId);
  rec.decision("Bot is switched on", bot.enabled, bot.enabled ? "Bot is on" : "Bot is off");
  if (!bot.enabled) {
    log("automations_off", "Bot is switched off.");
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

  // Stage A: close the opposite side.
  const opposingPositions = activePositionsForBot(botId, opposite);

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

  rec.decision(
    `Bot has exactly or more than 1 position with ${typeName(opposite)} type and any status`,
    opposingPositions.length > 0,
    `${opposingPositions.length} position${opposingPositions.length === 1 ? "" : "s"}`,
  );

  for (const position of opposingPositions) {
    const inFlight = ordersStore.query(
      (o) => o.positionId === position.id && o.kind === "close" && (o.status === "working" || o.status === "partially_filled"),
    );
    rec.decision("No close order is already in flight for it", inFlight.length === 0, inFlight.length === 0 ? "No working close order" : `${inFlight.length} working close order`);
    if (inFlight.length > 0) {
      log("close_in_flight", "A close order for this position is already in flight; nothing sent.", { positionId: position.id });
      continue;
    }

    const closeParams = closeParamsFor(position, closeTimeoutMs, staticConfig.closePricePercent);
    if (dryRun) {
      rec.action({ action: "close", title: closeTitle(position), position, params: closeParams, outcome: "dry_run", reason: "Dry run: nothing sent." });
      log("dry_run", `Dry run: would close ${position.type} position.`, { positionId: position.id });
      continue;
    }

    const result = await closePosition(position, signal, options.executor, closeTimeoutMs, pollIntervalMs, now, staticConfig.closePricePercent);
    rec.action({ action: "close", title: closeTitle(position), position: positionsStore.get(position.id) ?? position, params: closeParams, outcome: result.outcome, reason: result.reason });
    if (!result.ok) {
      recordError(botId, "close_failed", { positionId: position.id, reason: result.reason }, now);
      botsStore.update(botId, { needsAttention: true, needsAttentionReason: result.reason });
      log(result.outcome, result.reason, { positionId: position.id });
      return; // Never open the new side while the old side might still be held.
    }
    log("closed", result.reason, { positionId: position.id });
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
    manual: false,
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
  manual: boolean;
}

export interface StageResult {
  ok: boolean;
  outcome: DecisionOutcome;
  reason: string;
}

/** Guards, strike validation, the order, and its fill - shared by the signal
 * path and a manually placed position. Writes exactly one decision row. */
async function openStage(ctx: OpenStageContext): Promise<StageResult> {
  const { botId, staticConfig, wanted, signal, executor, now } = ctx;
  const limits = getBotLimits(botId);
  const bot = ensureBotRecord(botId);

  const rec = ctx.rec;
  let created: Position | null = null;
  let actionRecorded = false;
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
        { label: "Price", value: `Limit credit $${staticConfig.openingCreditEstimate.toFixed(2)} (${staticConfig.openPricePercent ?? 100}% of bid/ask)` },
        { label: "Quantity", value: `${staticConfig.quantity} contract${staticConfig.quantity === 1 ? "" : "s"}` },
        { label: "Expiration", value: `${easternDateKey(now)} (same day)` },
        {
          label: `Short ${side}`,
          value: ctx.manual || ctx.price == null || !ctx.plan ? `${k.shortStrike} (entered by hand)` : `${k.shortStrike} (target ${fmtLevel(ctx.plan.target)} = ${ctx.price} ${offset < 0 ? "-" : "+"} ${Math.abs(offset)}, rounded ${roundingWords(ctx.plan)} ${ctx.plan.rounding === "nearest" ? "" : "to "}${staticConfig.strikeIncrement})`,
        },
        { label: `Long ${side}`, value: `${k.longStrike} (${staticConfig.widthPoints} points ${side === "put" ? "below" : "above"} the short ${side})` },
        { label: "Fill timeout", value: `${Math.round(ctx.openTimeoutMs / 1000)}s` },
      ],
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
      detail: { ...(ctx.plan ? { strikePlan: planDetail(ctx.plan) } : {}), ...detail, ...(ctx.manual ? { manual: true } : {}), ...(rec && !signal ? { runId: rec.id } : {}) },
      now,
    });
    return { ok: outcome === "opened" || outcome === "dry_run", outcome, reason };
  };

  const existingWanted = activePositionsForBot(botId, wanted);
  rec?.decision(
    `Bot holds fewer than ${limits.maxPositionsPerType} ${typeName(wanted)} position${limits.maxPositionsPerType === 1 ? "" : "s"}`,
    existingWanted.length < limits.maxPositionsPerType,
    `${existingWanted.length} position${existingWanted.length === 1 ? "" : "s"}`,
  );
  if (existingWanted.length >= limits.maxPositionsPerType) {
    return finish("already_in_position", "An active position of the wanted type already exists.");
  }

  const totalActive = activePositionsForBot(botId);
  rec?.decision(`Bot has fewer than ${limits.totalPositionLimit} open position${limits.totalPositionLimit === 1 ? "" : "s"}`, totalActive.length < limits.totalPositionLimit, `${totalActive.length} open`);
  if (totalActive.length >= limits.totalPositionLimit) {
    return finish("total_position_limit_reached", "Total active position limit reached.");
  }

  const todayNewPositions = countTodayNewPositions(botId, now, bot.dailyResetAt);
  rec?.decision(`Bot opened fewer than ${limits.dailyNewPositionLimit} new positions today`, todayNewPositions < limits.dailyNewPositionLimit, `${todayNewPositions} opened today`);
  if (todayNewPositions >= limits.dailyNewPositionLimit) {
    return finish("daily_limit_reached", "Daily new-position limit reached; closing stays allowed, opening does not.");
  }

  const strikes = ctx.strikes ?? planStrikes(wanted, ctx.price ?? 0, staticConfig);
  const validation = validateStrikes(wanted, strikes, staticConfig);
  rec?.decision("Strikes pass the checks (order, not equal, on the increment, the right width)", validation.ok, validation.ok ? (ctx.plan ? describePlan(ctx.plan) : `Short ${strikes.shortStrike}, long ${strikes.longStrike}`) : `${validation.reason} (short ${strikes.shortStrike}, long ${strikes.longStrike})`);
  if (!validation.ok) {
    recordError(botId, "invalid_strikes", { strikes, reason: validation.reason }, now);
    botsStore.update(botId, { needsAttention: true, needsAttentionReason: `invalid_strikes: ${validation.reason}` });
    return finish("invalid_strikes", validation.reason ?? "Invalid strikes.", { strikes });
  }

  const projectedRisk = maxRisk(staticConfig.widthPoints, staticConfig.quantity, staticConfig.openingCreditEstimate);
  const currentRisk = sumActiveAllocationRisk(botId, staticConfig.widthPoints, staticConfig.openingCreditEstimate);
  rec?.decision(
    `Opening stays within the $${staticConfig.allocationLimit.toLocaleString("en-US")} allocation`,
    currentRisk + projectedRisk <= staticConfig.allocationLimit,
    `$${Math.round(currentRisk).toLocaleString("en-US")} at risk + $${Math.round(projectedRisk).toLocaleString("en-US")} for this trade`,
  );
  if (currentRisk + projectedRisk > staticConfig.allocationLimit) {
    return finish("allocation_limit_reached", "Opening this position would exceed the allocation limit.", {
      currentRisk,
      projectedRisk,
      allocationLimit: staticConfig.allocationLimit,
    });
  }

  const expiry = easternDateKey(now);
  const newLegs = positionLegs({
    underlying: staticConfig.underlying,
    expiry,
    shortStrike: strikes.shortStrike,
    longStrike: strikes.longStrike,
    type: wanted,
  });
  const accountBotIds = listBotIds().filter((id) => botAccountId(id) === staticConfig.accountId);
  const overlap = findOverlap(newLegs, activePositionsForBots(accountBotIds));
  rec?.decision("No leg collides with an existing position", !overlap, overlap ? `Overlaps ${describeLegs(overlap)}` : "No overlapping legs");
  if (overlap) {
    return finish("overlapping_strikes", "New legs collide with an existing active position.", { overlapPositionId: overlap.id });
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
    underlyingAtOpen: ctx.price,
    manual: ctx.manual,
    venue: executor.venue ?? "mock",
    optionRoot: staticConfig.optionRoot,
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

  let ref: string;
  try {
    ({ ref } = await executor.placeOpenOrder({
      botId,
      pricePercent: staticConfig.openPricePercent,
      underlying: staticConfig.underlying,
      optionRoot: staticConfig.optionRoot,
      positionType: wanted,
      shortStrike: strikes.shortStrike,
      longStrike: strikes.longStrike,
      quantity: staticConfig.quantity,
      limitCredit: staticConfig.openingCreditEstimate,
      expiry,
    }));
  } catch (err) {
    return failOpen(`Open order failed: ${errorMessage(err)}`);
  }
  positionsStore.update(position.id, { brokerOrderRef: ref });

  const orderRow: Order = {
    id: `ord-${now}-${crypto.randomUUID()}`,
    positionId: position.id,
    kind: "open",
    status: "working",
    limitPrice: staticConfig.openingCreditEstimate,
    filledQuantity: 0,
    ref,
    createdAt: now,
    updatedAt: now,
  };
  ordersStore.insert(orderRow);

  let watched: Awaited<ReturnType<typeof watchOrder>>;
  try {
    watched = await watchOrder(executor, ref, { timeoutMs: ctx.openTimeoutMs, pollIntervalMs: ctx.pollIntervalMs });
  } catch (err) {
    return failOpen(`Lost track of open order ${ref}: ${errorMessage(err)}`);
  }
  const { state, timedOut } = watched;
  ordersStore.update(orderRow.id, {
    status: state.status,
    filledQuantity: state.filledQuantity,
    rejectReason: state.rejectReason,
    updatedAt: Date.now(),
  });

  if (state.status === "rejected" || (timedOut && state.filledQuantity === 0)) {
    positionsStore.update(position.id, { status: "rejected" });
    const reason = state.rejectReason ?? "Open order timed out unfilled.";
    recordError(botId, "open_failed", { positionId: position.id, reason }, now);
    return finish(state.status === "rejected" ? "open_rejected" : "open_timeout_no_fill", reason, { positionId: position.id });
  }

  // Full fill, or a partial the timeout settled at - both become `open` at
  // whatever size actually filled (spec: the remainder is simply canceled).
  positionsStore.update(position.id, {
    status: "open",
    filledQuantity: state.filledQuantity,
    credit: state.averagePrice ?? staticConfig.openingCreditEstimate,
  });
  return finish("opened", "Opened new position.", { positionId: position.id, filledQuantity: state.filledQuantity });
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
    let closePercent: number | undefined;
    try {
      closePercent = getBotStaticConfig(botId).closePricePercent;
    } catch {
      /* a bot without complete inputs: the default applies */
    }
    const params = closeParamsFor(position, closeTimeoutMs, closePercent);
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
      closePercent,
    );
    rec.action({ action: "close", title: closeTitle(position), position: positionsStore.get(position.id) ?? position, params, outcome: result.outcome, reason: result.reason });
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
