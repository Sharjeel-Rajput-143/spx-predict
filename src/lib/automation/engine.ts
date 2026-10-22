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
  closeChaseMax,
  closeUseMarks,
  closeMaxAboveMarket,
  getFlipCooldownSeconds,
  quoteMaxWidth,
  isDryRun,
  isTestMode,
} from "./config";
import { logDecision } from "./decisions";
import { recordError } from "./errors";
import { expireStalePositions } from "./expiry";
import { watchOrder } from "./orderWatch";
import { describeBand, placeAndWatch } from "./placeAndWatch";
import { chaseRungs } from "./closeChase";
import { applyMarkCeiling } from "./closeMarks";
import { checkDailyLoss } from "./lossLimit";
import { brokerSaid, trailText } from "./orderEnd";
import { OrderNotPlacedError } from "./orderErrors";
import { getLastTick } from "@/lib/marketData/tickStore";
import { applyTradeOp, contractsToClose, describeFinals, describeClosePricing, describeQuantity, type ClosePricing } from "./closePricing";
import { resolveQuantity, resolveStrikeInputs } from "./openSettings";
import { applyFloor, effectiveMinCredit } from "./minCredit";
import { occSymbol } from "./tradierExecutor";
import { repriceAfterBand, type PriceBand } from "./priceBand";
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

/** Whether orders for this underlying must carry a limit price on this executor (see BrokerExecutor.limitOnly). */
export const needsLimit = (executor: BrokerExecutor, underlying: string): boolean => (executor.limitOnlyFor ? executor.limitOnlyFor(underlying) : executor.limitOnly === true);

/** What the engine knows about an order's price: the ladder it will walk, or why there isn't one. */
interface PricePlan {
  ladder: Ladder | null;
  /** In words, for the trace and the log. */
  note: string;
  /** Set when a quote exists but can't be traded on. */
  unusable?: string;
  /** The quote's worst price on this side (the most a debit could cost, the least a credit could bring). */
  worst?: number;
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
  if (!legs) return { ladder: null, note: "One price (no quote available: the broker gave no usable bid and ask for one or both legs)" };
  // A quote far too wide to mean anything is not priced from (real-time data only; exempt while the data is delayed, or every paper trade would be refused).
  const widest = quoteMaxWidth();
  const market = spreadMarket(side, legs);
  if (market && widest > 0 && legs.delayed !== true) {
    const gap = Math.abs(market.best - market.natural); // the same width whichever side is being priced
    if (gap > widest + 1e-9) {
      const reason = `the quote is too wide to price from: its bid/ask gap is $${gap.toFixed(2)} against a limit of $${widest.toFixed(2)} (the limit is off while the data is delayed)`;
      return { ladder: null, note: `No usable price: ${reason}`, unusable: reason };
    }
  }
  const own = pricing.close;
  const finals = own ? { percent: own.percent, slippage: own.slippage, flat: own.flat, ...(own.tradePrice ? { tradePrice: applyTradeOp(openedFor, own.tradePrice) ?? undefined } : {}) } : undefined;
  const built = buildLadder({ side, legs, mode: pricing.mode, finalPercent: pricing.percent, ...(finals ? { finals } : {}), width: pricing.width, tick: DEFAULT_PRICE_TICK });
  if (!built.ok) return { ladder: null, note: `No usable price: ${built.reason}`, unusable: built.reason };
  return { ladder: built.ladder, note: describeLadder(built.ladder, own ? describeFinals(own) : pricing.percent), ...(market ? { worst: market.natural } : {}) };
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
  /** `chase`: this close may continue past its ladder's top price (REHEARSAL close chase, CLOSE_CHASE_MAX). `marks`: its prices may be capped by the broker's marks (REHEARSAL, CLOSE_USE_MARKS). Both left off for the close inside a flip. */
  options?: { chase?: boolean; marks?: boolean },
): Promise<CloseResult> {
  const total = position.filledQuantity || position.requestedQuantity;
  const target = contracts !== undefined ? Math.min(total, Math.max(1, contracts)) : total;
  const partial = target < total;

  // Closing is a debit: buy the spread back. With a market to look at, walk from the mid toward the full spread.
  // Priced BEFORE anything changes, so a close that can't be priced leaves the position exactly as it was.
  // A broker that is limit-only (a combo is never sent as a bare market order) turns "market" into one limit order at the far end of the
  // spread, and refuses outright when there is no usable quote to price from. Only an executor without that rule (the simulation) falls
  // back to its own default price when there is no quote.
  const limitOnly = needsLimit(executor, position.underlying);
  const effective: Pricing | undefined = limitOnly && pricing?.market ? { ...pricing, market: false, mode: "off", percent: 100, close: undefined } : pricing;
  const plan: PricePlan | null = effective?.market
    ? { ladder: null, note: "Market order (no limit price)" }
    : effective && executor.getSpreadQuote
      ? await planPrice(executor, "debit", spreadOf(position), effective, position.credit)
      : null;
  if (limitOnly && !plan?.ladder) {
    const why = plan?.unusable ?? plan?.note ?? "this executor can't quote the spread";
    return {
      ok: false,
      outcome: "close_no_quote",
      reason: `Close refused: there is no usable quote of the spread to price a limit order from (${why}). The broker is only sent limit orders on a spread, so nothing was sent and the position is left exactly as it was. Try again when quotes are available.`,
      pricing: plan?.note,
    };
  }
  // REHEARSAL, both decided (and said in the Log) before anything is sent, and both only for a closing ladder on a limit-only broker whose bridge
  // says the account is paper:
  //  - CLOSE_USE_MARKS: the broker's own marks are a ceiling. A close is never sent above mark + CLOSE_MAX_ABOVE_MARKET; a quote far above the
  //    mark is replaced by a ladder built from the mark.
  //  - CLOSE_CHASE_MAX: the ladder goes on past its top price (never above the ceiling when marks are in force).
  const chaseNotes: string[] = [];
  let ladderUsed = plan?.ladder ?? null;
  let pricingNoteUsed = plan?.note;
  let ceiling: number | null = null;
  let chase: { prices: number[]; limit: number; step: number } | null = null;
  const useMarks = !!(options?.marks && limitOnly && ladderUsed && closeUseMarks());
  const chaseMax = options?.chase && limitOnly && ladderUsed ? closeChaseMax() : 0;
  let paperKnown: boolean | null = null;
  const isPaper = async () => {
    if (paperKnown === null) {
      try {
        paperKnown = (await executor.isPaperAccount?.()) === true;
      } catch {
        paperKnown = false;
      }
    }
    return paperKnown;
  };
  if (useMarks && ladderUsed) {
    if (!(await isPaper())) {
      chaseNotes.push("Broker marks: CLOSE_USE_MARKS is on but it is ignored, because the bridge does not say this is a paper account. The close is priced from the quote as usual.");
    } else {
      let mark: number | null = null;
      let why = "";
      try {
        mark = (await executor.getSpreadMark?.(position, target)) ?? null;
        if (mark === null) why = "the account does not show both legs of the spread with a mark";
      } catch (err) {
        why = `the account's positions could not be read (${errorMessage(err)})`;
      }
      if (mark === null) {
        chaseNotes.push(`Broker marks: not used (${why}). The close is priced from the quote as usual.`);
      } else {
        const capped = applyMarkCeiling({ prices: ladderUsed.prices, mid: ladderUsed.mid, mark, maxAbove: closeMaxAboveMarket(), width: effective?.width });
        if (!capped.ok) {
          chaseNotes.push(`Broker marks: not used (${capped.reason}). The close is priced from the quote as usual.`);
        } else {
          ceiling = capped.ceiling;
          chaseNotes.push(capped.note);
          if (capped.kind !== "within") {
            ladderUsed = { ...ladderUsed, prices: capped.prices, mid: capped.prices[0], final: capped.prices[capped.prices.length - 1] };
            pricingNoteUsed = `${capped.kind === "rebuilt" ? "Broker marks" : "Quote capped by the broker's marks"}: ${capped.prices.map((p) => p.toFixed(2)).join(", ")} (mark ${mark.toFixed(2)}, ceiling ${capped.ceiling.toFixed(2)}; the quote said ${plan?.note ?? "no ladder"})`;
          }
        }
      }
    }
  }
  if (chaseMax > 0 && ladderUsed) {
    if (!(await isPaper())) {
      chaseNotes.push(`Rehearsal chase: CLOSE_CHASE_MAX is $${chaseMax.toFixed(2)} but it is ignored, because the bridge does not say this is a paper account. The close is priced as usual.`);
    } else if (plan?.worst === undefined) {
      chaseNotes.push("Rehearsal chase: not used, because the quote gave no worst price to continue from.");
    } else {
      // With a ceiling from the marks, the quote's worst price is no longer the end of the road: the ceiling is.
      const worst = ceiling !== null ? Math.min(plan.worst, ceiling) : plan.worst;
      const c = chaseRungs({ prices: ladderUsed.prices, worst, max: chaseMax, width: effective?.width, ...(ceiling !== null ? { ceiling } : {}) });
      if (c.ok) {
        chase = { prices: c.prices, limit: c.limit, step: c.step };
        chaseNotes.push(`Rehearsal chase (CLOSE_CHASE_MAX $${chaseMax.toFixed(2)}, paper account): if the ladder's top price ${ladderUsed.final.toFixed(2)} does not fill, ${c.prices.length === 1 ? "one more price" : `${c.prices.length} more prices`} follow in steps of ${c.step.toFixed(2)}, up to ${c.limit.toFixed(2)}: ${c.prices.map((p) => p.toFixed(2)).join(", ")}.`);
      } else {
        chaseNotes.push(`Rehearsal chase: not used (${c.reason}).`);
      }
    }
  }
  // Every attempt to close has its own order ids: the bridge remembers every id it has seen (across restarts) and refuses one sent again with
  // a different price. The count is saved on the position before anything is sent, so a failed attempt is never repeated under its id.
  const attempt = (positionsStore.get(position.id)?.closeAttempts ?? position.closeAttempts ?? 0) + 1;
  const statusBefore = positionsStore.get(position.id)?.status ?? position.status;
  positionsStore.update(position.id, { status: "closing", closeSignalId: signal?.id ?? null, closeAttempts: attempt });
  const ladder = ladderUsed;
  const pricingNote = pricingNoteUsed;

  let closeStep = 0;
  const result = await placeAndWatch({
    executor,
    kind: "close",
    positionId: position.id,
    now,
    place: (price) => executor.placeCloseOrder(position, { clientOrderId: `${position.id}:close:${attempt}:${++closeStep}`, pricePercent: pricing?.percent, ...(price !== null ? { limitDebit: price } : {}), ...(partial ? { quantity: target } : {}) }),
    prices: ladder ? [...ladder.prices, ...(chase?.prices ?? [])] : null,
    ...(chase && ladder ? { chase: { from: ladder.prices.length } } : {}),
    // The broker refused a price as too far through its market: price again from its own numbers (never past the ladder's final price - or, for a
    // rung of the chase, never past the chase's own limit; the cap above the broker's market price applies either way).
    ...(ladder ? { reprice: ({ band, refused }: { band: PriceBand; refused: number }) => repriceAfterBand({ side: "debit", band, refused, finalPrice: Math.min(chase && refused > ladder.final + 1e-9 ? chase.limit : ladder.final, ceiling ?? Infinity), rungs: ladder.prices.length, maxAboveMarket: closeMaxAboveMarket(), width: effective?.width }) } : {}),
    stepMs: effective?.stepMs ?? (ladder?.secondsEach ?? 0) * 1000,
    finalMs: timeoutMs,
    pollMs: pollIntervalMs,
    defaultLimit: 0,
    quantity: target,
  });
  if (!result.ok) {
    // Left "closing": we can't know the broker didn't take the order, so the
    // position keeps counting as live until an operator resolves it.
    // The order was never taken (a check of ours failed, or the bridge answered with a refusal such as 409, 422 or 503): nothing is working at
    // the broker, so a position that was open goes back to open, with the bridge's own words in the Log. Anything unclear (no answer, a
    // timeout) stays "closing" below, and so does a refusal because the account does not hold the spread (Resolve looks at that).
    if (result.stage === "place" && result.error instanceof OrderNotPlacedError && !result.error.needsResolve && statusBefore === "open") {
      positionsStore.update(position.id, { status: "open", closeSignalId: null });
      return { ok: false, outcome: "executor_error", reason: `Close order not placed: ${errorMessage(result.error)} Nothing was sent to the broker, so the position is back to open.`, pricing: pricingNote, steps: [...chaseNotes, ...result.steps] };
    }
    return result.stage === "place"
      ? { ok: false, outcome: "executor_error", reason: `Close order failed: ${errorMessage(result.error)}`, pricing: pricingNote, steps: [...chaseNotes, ...result.steps] }
      : { ok: false, outcome: "executor_error", reason: `Lost track of close order ${result.ref}: ${errorMessage(result.error)}`, pricing: pricingNote, steps: [...chaseNotes, ...result.steps] };
  }
  const { state, timedOut } = result;
  const steps = [...chaseNotes, ...result.steps];
  // When the close filled on a rung of the chase, the Log says which rung and at what price.
  const chased = result.chase && state.status === "filled" ? ` Filled on rehearsal chase rung ${result.chase.chaseRung} (price ${result.chase.rung} of ${result.chase.of}) at the final price of $${result.chase.price.toFixed(2)}${state.averagePrice !== undefined ? ` (the broker reported $${state.averagePrice.toFixed(2)})` : ""}.` : "";

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
    return { ok: true, outcome: "closed", reason: `Close order filled: ${target} of ${total} contracts closed, ${total - target} still open.${chased}`, pricing: pricingNote, steps, closedPositionId: part.id };
  }
  if (state.status === "filled" && state.filledQuantity >= targetQuantity) {
    positionsStore.update(position.id, {
      status: "closed",
      closedAt: Date.now(),
      closePrice: state.averagePrice ?? null,
      underlyingAtClose: signal?.price ?? null,
    });
    return { ok: true, outcome: "closed", reason: `Close order filled.${chased}`, pricing: pricingNote, steps };
  }
  // Nothing filled. The broker confirmed the order is over (a cancel we asked for is confirmed before we get here), but a cancelled order alone is
  // not proof the spread is still held: the position goes back to "open" only when the account itself shows the whole spread, and stays
  // "closing" (for Resolve) otherwise.
  const refused = !timedOut && state.priceBand !== undefined;
  if (state.status === "rejected" || refused) {
    const why = refusalText(state, "Close order rejected.");
    const trail = trailText(state);
    const back = await backToOpenIfStillHeld(position, executor, total);
    return { ok: false, outcome: "close_rejected", reason: `${why}${trail ? ` ${trail}.` : ""}${back}`, pricing: pricingNote, steps };
  }
  if (state.filledQuantity === 0) {
    const back = await backToOpenIfStillHeld(position, executor, total);
    const said = brokerSaid(state, !timedOut);
    return { ok: false, outcome: "close_timeout", reason: `${timedOut ? "Close order never filled before the confirm timeout." : "Close order ended without filling."}${said ? ` ${said}` : ""}${back}`, pricing: pricingNote, steps };
  }
  return { ok: false, outcome: "close_partial_fill", reason: "Close order only partially filled. The rest was canceled; the position stays in closing, keeps its slot in the limits, and needs a person to clear it.", pricing: pricingNote, steps };
}

/** What the broker said when it refused an order: the price band in numbers when it gave them, and always its own words. */
function refusalText(state: { rejectReason?: string; priceBand?: PriceBand }, fallback: string): string {
  const band = state.priceBand ? `The broker refused the price as too far through its market (${describeBand(state.priceBand)}).` : "";
  const words = state.rejectReason ? `${band ? " Its words: " : ""}${state.rejectReason}` : "";
  return `${band}${words}`.trim() || fallback;
}

/**
 * A close that ended with nothing filled and the broker confirming the order is over. Whether the position can go back to "open" is
 * decided by the account, not by the order: the broker's own positions must show the WHOLE spread still held. Anything else (the account
 * can't be asked, it holds less, it holds nothing, it is a simulated position with no account to ask) leaves it "closing" for a person to
 * resolve. Returns the sentence to add to the reason.
 */
async function backToOpenIfStillHeld(position: Position, executor: BrokerExecutor, quantity: number): Promise<string> {
  if (!executor.listBrokerPositions || position.venue === "mock" || !position.optionRoot) return "";
  try {
    const right = position.type === "short_put_spread" ? "put" : "call";
    const short = occSymbol(position.optionRoot, position.expiry, right, position.shortStrike);
    const long = occSymbol(position.optionRoot, position.expiry, right, position.longStrike);
    const held = await executor.listBrokerPositions();
    const of = (sym: string) => held.filter((h) => h.symbol === sym).reduce((s, h) => s + h.quantity, 0);
    if (of(short) <= -quantity && of(long) >= quantity) {
      positionsStore.update(position.id, { status: "open", closeSignalId: null });
      return " The account still holds the whole spread, so the position is back to open (nothing was closed).";
    }
    return " The position stays in closing: the account does not show the whole spread still held, so a person has to resolve it (Resolve on the position).";
  } catch {
    return " The position stays in closing: the account could not be asked whether the spread is still held, so a person has to resolve it (Resolve on the position).";
  }
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
    return {
      ok: false,
      outcome: "stuck_position",
      reason: `The ${describeLegs(position)} position is stuck in "closing": no close order is working and none was confirmed, so no second close was sent and nothing new was opened. Open the position and press Resolve: it asks the broker what is really held and offers only what is safe.`,
    };
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
        if (waited.outcome !== "close_in_flight" && waited.outcome !== "stuck_position") recordError(botId, "close_failed", { positionId: position.id, reason: waited.reason }, now);
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

    // REHEARSAL (CLOSE_USE_MARKS, paper only): the flip's close is capped by the broker's marks like a manual close is. Never the chase, and
    // nothing here touches the open that follows. If this close fails, the flip stops below and nothing new is opened, as before.
    const result = await closePosition(position, signal, options.executor, closeTimeoutMs, pollIntervalMs, now, applyClosePricing(pricingFor(staticConfig, "close", options.ladderStepMs), ownClose), contracts < total ? contracts : undefined, { marks: true });
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

  // The daily loss limit (off unless set): today's realized result plus the open loss. It blocks NEW OPENS only - the close of a flip has already
  // happened above, and nothing here touches a close. It does not switch the bot off and leaves nothing to clear: it is worked out afresh each time,
  // and the next New York trading day starts from zero. Every evaluation writes one Log line with the numbers.
  if (limits.dailyLossLimit > 0) {
    const check = await checkDailyLoss({ botId, limit: limits.dailyLossLimit, now, executor: ctx.executor, exclude: gone });
    rec?.decision(`The day's loss is under the daily loss limit of $${limits.dailyLossLimit.toFixed(2)}`, !check.hit, check.line);
    botsStore.update(botId, { lossCheck: check.snapshot });
    if (check.hit) {
      if (!ctx.dryRun) botsStore.update(botId, { needsAttention: true, needsAttentionReason: `daily_loss_limit_reached: ${check.line}` });
      return finish("daily_loss_limit_reached", `Daily loss limit reached. ${check.line}. Nothing was opened. Closing is not blocked and the bot stays on; this ends with the New York trading day.`, { dailyLoss: check.snapshot });
    }
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

  // A broker that is only sent limit orders is never sent one at a guessed price: with no quote to price from, nothing is opened.
  if (needsLimit(executor, staticConfig.underlying) && !ladderPrices) {
    rec?.decision("The spread has a quote to price a limit order from", false, priceNote ?? "No quote");
    return finish("open_no_quote", `Open refused: there is no usable quote of the spread to price a limit order from (${priceNote ?? "no quote"}). Nothing was sent.`);
  }

  // The minimum credit: a rung under the floor is never sent, and an open with no rung left is skipped. (A ladder falls from the mid to the
  // final price, so what is dropped is its tail.) With no ladder the one price is the bot's expected credit, which the floor sits below.
  const floor = effectiveMinCredit(staticConfig);
  const firstPrice = ladderPrices ? ladderPrices[0] : staticConfig.openingCreditEstimate;
  rec?.decision(`The price is at least the minimum credit of $${floor.toFixed(2)}`, firstPrice + 1e-9 >= floor, `Best price $${firstPrice.toFixed(2)}`);
  if (firstPrice + 1e-9 < floor) {
    return finish("below_min_credit", `Skipped, below minimum credit: the best price for this spread is $${firstPrice.toFixed(2)}, under the bot's minimum of $${floor.toFixed(2)}. Nothing was opened.`, { minCredit: floor, bestPrice: firstPrice, ladder: ladderPrices });
  }
  if (ladderPrices) {
    const { kept, dropped } = applyFloor(ladderPrices, floor);
    if (dropped.length > 0) {
      ladderPrices = kept;
      priceNote = `${priceNote ?? "SmartPricing"}; ${dropped.length === 1 ? "the price" : "the prices"} under the $${floor.toFixed(2)} minimum credit ${dropped.map((p) => p.toFixed(2)).join(", ")} ${dropped.length === 1 ? "was" : "were"} dropped, so the ladder ends at $${kept[kept.length - 1].toFixed(2)}`;
      pricingDetail = { ...pricingDetail, pricing: { ...(pricingDetail as { pricing?: Record<string, unknown> }).pricing, note: priceNote, prices: kept, final: kept[kept.length - 1], droppedUnderMinCredit: dropped } };
    }
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
    venue: executor.venueFor?.(staticConfig.underlying) ?? executor.venue ?? "mock",
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

  // One id per price step, built from the alert (or the position, for a manual open): the same step sent twice carries the same id.
  let openStep = 0;
  const result = await placeAndWatch({
    executor,
    kind: "open",
    positionId: position.id,
    now,
    place: (price) =>
      executor.placeOpenOrder({
        clientOrderId: `${signal?.id ?? position.id}:open:${++openStep}`,
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
    // The broker refused a price as too far through its market: price again from its own numbers, never under the minimum credit.
    ...(ladderPrices ? { reprice: ({ band, refused }: { band: PriceBand; refused: number }) => repriceAfterBand({ side: "credit", band, refused, finalPrice: ladderPrices![ladderPrices!.length - 1], rungs: ladderPrices!.length, minCredit: floor, width: staticConfig.widthPoints }) } : {}),
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
    // A refusal by the broker (an order it ended itself, with its reason or a price band) is a rejection, not a timeout.
    const refused = !timedOut && (state.priceBand !== undefined || state.rejectReason !== undefined);
    const reason = state.priceBand || state.rejectReason ? refusalText(state, "") : timedOut ? "Open order timed out unfilled." : "Open order ended without filling.";
    recordError(botId, "open_failed", { positionId: position.id, reason }, now);
    return finish(state.status === "rejected" || refused ? "open_rejected" : "open_timeout_no_fill", reason, { positionId: position.id, rungsTried: result.rungsTried });
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
      undefined,
      { chase: true, marks: true },
    );
    rec.action({ action: "close", title: closeTitle(position), position: positionsStore.get(position.id) ?? position, params: closeParamsFor(position, closeTimeoutMs, botConfig?.closePricePercent, { ...closeHow, note: result.pricing }), steps: result.steps, outcome: result.outcome, reason: result.reason });
    // A close refused for want of a quote changed nothing and is not a failure of the bot: the person who pressed the button sees the message and can press it again.
    if (!result.ok && result.outcome !== "close_no_quote") {
      recordError(botId, "close_failed", { positionId, reason: result.reason }, now);
      ensureBotRecord(botId);
      botsStore.update(botId, { needsAttention: true, needsAttentionReason: result.reason });
    }
    return log(result.outcome, result.reason, result.ok);
  } finally {
    rec.save();
  }
}
