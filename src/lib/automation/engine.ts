import "server-only";
import crypto from "node:crypto";
import { ensureBotRecord, getBotLimits, getBotStaticConfig, listBotIds } from "./bots";
import {
  DEDUPE_WINDOW_SECONDS,
  ORDER_POLL_INTERVAL_MS,
  CLOSE_CONFIRM_TIMEOUT_SECONDS,
  ORDER_FILL_TIMEOUT_SECONDS,
  getFlipCooldownSeconds,
  isDryRun,
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
import { computeStrikes, maxRisk, validateStrikes, type StrikePair } from "./strikes";
import { easternDateKey, isWithinTradingHours } from "./tradingHours";
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
): Promise<CloseResult> {
  positionsStore.update(position.id, { status: "closing", closeSignalId: signal?.id ?? null });
  let ref: string;
  try {
    ({ ref } = await executor.placeCloseOrder(position));
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

/**
 * The full per-signal decision logic (spec steps 0-10). Must always be
 * invoked through withBotLock so two signals for the same bot never run at
 * once. Takes an already-persisted signal row (see receiveAndSaveSignal).
 */
export async function processSignal(signal: Signal, options: ProcessSignalOptions): Promise<void> {
  const now = options.now ?? Date.now();
  const closeTimeoutMs = options.closeConfirmTimeoutMs ?? CLOSE_CONFIRM_TIMEOUT_SECONDS * 1000;
  const openTimeoutMs = options.orderFillTimeoutMs ?? ORDER_FILL_TIMEOUT_SECONDS * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? ORDER_POLL_INTERVAL_MS;
  const dryRun = options.dryRun ?? isDryRun();
  const { botId } = signal;

  const log = (outcome: DecisionOutcome, reason: string, detail: Record<string, unknown> = {}) =>
    logDecision({ signalId: signal.id, botId, outcome, reason, detail, now });

  // A required setting (e.g. the strike offsets) is missing: say so in the
  // decision log rather than only throwing into the route's console.
  let staticConfig: ReturnType<typeof getBotStaticConfig>;
  try {
    staticConfig = getBotStaticConfig(botId);
  } catch (err) {
    ensureBotRecord(botId);
    botsStore.update(botId, { needsAttention: true, needsAttentionReason: errorMessage(err) });
    log("config_error", errorMessage(err));
    return;
  }

  // Step 0: stale-position safety net (the EOD sweep is the primary mechanism).
  expireStalePositions(botId, now);

  // Step 1: kill switch.
  const bot = ensureBotRecord(botId);
  if (!bot.enabled) {
    log("automations_off", "Bot is switched off.");
    return;
  }

  // Each direction can be switched off on its own (Settings > Triggers).
  if (bot.triggers && bot.triggers[signal.signal as SignalDirection] === false) {
    log("trigger_disabled", `The ${signal.signal} trigger is switched off for this bot.`);
    return;
  }

  // Step 2: hours guard.
  if (!isWithinTradingHours(now)) {
    log("outside_hours", "Outside the configured trading window.");
    return;
  }

  // Step 3: dedupe.
  const duplicate = findDuplicateSignal(signal);
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
    if (sameDay) {
      log("day_trading_blocked", "Day trading is not allowed for this bot, so a position opened today isn't closed. It is held to expiry.", { positionId: sameDay.id });
      return;
    }
  }

  for (const position of opposingPositions) {
    const inFlight = ordersStore.query(
      (o) => o.positionId === position.id && o.kind === "close" && (o.status === "working" || o.status === "partially_filled"),
    );
    if (inFlight.length > 0) {
      log("close_in_flight", "A close order for this position is already in flight; nothing sent.", { positionId: position.id });
      continue;
    }

    if (dryRun) {
      log("dry_run", `Dry run: would close ${position.type} position.`, { positionId: position.id });
      continue;
    }

    const result = await closePosition(position, signal, options.executor, closeTimeoutMs, pollIntervalMs, now);
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
    botId,
    staticConfig,
    wanted,
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
  botId: string;
  staticConfig: BotStaticConfig;
  wanted: PositionType;
  /** Given for a manual position; otherwise derived from the signal's price. */
  strikes?: StrikePair;
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

  const finish = (outcome: DecisionOutcome, reason: string, detail: Record<string, unknown> = {}): StageResult => {
    logDecision({ signalId: signal?.id ?? null, botId, outcome, reason, detail: { ...detail, ...(ctx.manual ? { manual: true } : {}) }, now });
    return { ok: outcome === "opened" || outcome === "dry_run", outcome, reason };
  };

  const existingWanted = activePositionsForBot(botId, wanted);
  if (existingWanted.length >= limits.maxPositionsPerType) {
    return finish("already_in_position", "An active position of the wanted type already exists.");
  }

  const totalActive = activePositionsForBot(botId);
  if (totalActive.length >= limits.totalPositionLimit) {
    return finish("total_position_limit_reached", "Total active position limit reached.");
  }

  const todayNewPositions = countTodayNewPositions(botId, now, bot.dailyResetAt);
  if (todayNewPositions >= limits.dailyNewPositionLimit) {
    return finish("daily_limit_reached", "Daily new-position limit reached; closing stays allowed, opening does not.");
  }

  const strikes = ctx.strikes ?? computeStrikes(wanted, ctx.price ?? 0, staticConfig);
  const validation = validateStrikes(wanted, strikes, staticConfig);
  if (!validation.ok) {
    recordError(botId, "invalid_strikes", { strikes, reason: validation.reason }, now);
    botsStore.update(botId, { needsAttention: true, needsAttentionReason: `invalid_strikes: ${validation.reason}` });
    return finish("invalid_strikes", validation.reason ?? "Invalid strikes.", { strikes });
  }

  const projectedRisk = maxRisk(staticConfig.widthPoints, staticConfig.quantity, staticConfig.openingCreditEstimate);
  const currentRisk = sumActiveAllocationRisk(botId, staticConfig.widthPoints, staticConfig.openingCreditEstimate);
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
  const accountBotIds = listBotIds().filter((id) => getBotStaticConfig(id).accountId === staticConfig.accountId);
  const overlap = findOverlap(newLegs, activePositionsForBots(accountBotIds));
  if (overlap) {
    return finish("overlapping_strikes", "New legs collide with an existing active position.", { overlapPositionId: overlap.id });
  }

  if (ctx.dryRun) {
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
  };
  positionsStore.insert(position);

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
  const log = (outcome: DecisionOutcome, reason: string): StageResult => {
    logDecision({ signalId: null, botId, outcome, reason, detail: { manual: true }, now });
    return { ok: false, outcome, reason };
  };

  expireStalePositions(botId, now);
  if (!isWithinTradingHours(now)) return log("outside_hours", "Outside the configured trading window.");

  const longStrike = input.type === "short_put_spread" ? input.shortStrike - staticConfig.widthPoints : input.shortStrike + staticConfig.widthPoints;
  return openStage({
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
}

/** Closes one active position now. A failed close is handled exactly like a
 * failed flip: error recorded, bot flagged needs_attention. Must run inside withBotLock. */
export async function manualClose(positionId: string, options: ManualOptions & { underlyingPrice?: number | null }): Promise<StageResult> {
  const now = options.now ?? Date.now();
  const position = positionsStore.get(positionId);
  if (!position) throw new Error("Position not found.");
  const { botId } = position;
  const log = (outcome: DecisionOutcome, reason: string, ok = false): StageResult => {
    logDecision({ signalId: null, botId, outcome, reason, detail: { manual: true, positionId }, now });
    return { ok, outcome, reason };
  };

  if (position.status !== "open" && position.status !== "closing") {
    throw new Error(`A position that is ${position.status} can't be closed.`);
  }
  const inFlight = ordersStore.query(
    (o) => o.positionId === position.id && o.kind === "close" && (o.status === "working" || o.status === "partially_filled"),
  );
  if (inFlight.length > 0) return log("close_in_flight", "A close order for this position is already in flight; nothing sent.");
  if (options.dryRun ?? isDryRun()) return log("dry_run", `Dry run: would close ${position.type} position.`, true);

  const result = await closePosition(
    position,
    { id: null, price: options.underlyingPrice ?? null },
    options.executor,
    options.closeConfirmTimeoutMs ?? CLOSE_CONFIRM_TIMEOUT_SECONDS * 1000,
    options.pollIntervalMs ?? ORDER_POLL_INTERVAL_MS,
    now,
  );
  if (!result.ok) {
    recordError(botId, "close_failed", { positionId, reason: result.reason }, now);
    ensureBotRecord(botId);
    botsStore.update(botId, { needsAttention: true, needsAttentionReason: result.reason });
  }
  return log(result.outcome, result.reason, result.ok);
}
