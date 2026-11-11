import { BYBIT_UNDERLYING } from "./executorKind";
import { DEMO_HOST, LIVE_HOST } from "./bybitLiveLimits";
import "server-only";
import crypto from "node:crypto";
import { dailyLimitBlock } from "./bybitDay";
import { parseClockMinutes } from "./config";
import { unknownResultFor } from "./brokerVenue";
import { logDecision } from "./decisions";
import { BridgeHttpError, OrderNotPlacedError, isRefusalStatus } from "./orderErrors";
import { positionQuantity } from "./pnl";
import { botsStore, ordersStore, positionsStore } from "./store";
import { describeWindow, hoursConfigFor, isWithinTradingHours } from "./tradingHours";
import type { BrokerExecutor, CloseOrderOptions, CloseReason, ExecutorVenue, OpenSpreadRequest, OrderState, Position } from "./types";

/**
 * The Bybit backend (DEMO account only): trades the BTCUSDT linear perpetual with market orders, in response to the same signals the other executors take.
 * A new backend behind the same interface - the decision engine is unchanged. A bullish signal buys, a bearish one sells short, a flip closes the old side
 * (reduce only, confirmed by Bybit) and only then opens the other.
 *
 * HOW IT TALKS TO BYBIT (V5 API, https://api-demo.bybit.com)
 *   Every private call is signed: HMAC-SHA256 (hex) over  timestamp + apiKey + recvWindow + (the query string for a GET | the raw JSON body for a POST),
 *   sent in the headers X-BAPI-API-KEY, X-BAPI-TIMESTAMP, X-BAPI-RECV-WINDOW and X-BAPI-SIGN. The answer is JSON { retCode, retMsg, result }; retCode 0 is
 *   success, anything else is a refusal and is thrown with Bybit's own words. Calls used:
 *     POST /v5/order/create       market order (category linear, positionIdx 0 = one-way mode); an entry carries stopLoss and takeProfit, a close reduceOnly: true
 *     POST /v5/position/trading-stop   sets the stop loss and take profit on a position that came back without them
 *     POST /v5/order/cancel       only if an order is still working when the engine gives up on it
 *     GET  /v5/order/realtime, /v5/order/history   an order's status; also how a close made by Bybit (a stop) is found and classified
 *     GET  /v5/position/list      what the account really holds (side, size, average price, mark price, unrealised P/L, stop loss, take profit)
 *     GET  /v5/position/closed-pnl     Bybit's own realised profit and loss for a closing order (net of fees)
 *     GET  /v5/account/wallet-balance  the connection check
 *     GET  /v5/market/instruments-info, /v5/market/tickers   public: the price tick and the mark price a stop is worked out from
 *
 * DEMO ONLY. The host must be api-demo.bybit.com: any other address is refused when the settings are read, so real money cannot be reached from here.
 *
 * NO DEFAULTS FOR RISK. STOP_LOSS_PERCENT, TAKE_PROFIT_PERCENT, POSITION_SIZE and DAILY_MAX_LOSS_USD must all be set. With any missing the executor does not
 * exist (reading the settings throws, naming what is missing) and nothing is sent.
 *
 * STOP LOSS AND TAKE PROFIT ON BYBIT'S SIDE. Every entry is sent WITH a stop loss and a take profit (STOP_LOSS_PERCENT and TAKE_PROFIT_PERCENT of the mark price, rounded to
 * the price tick, triggered on the mark price, closing at market), so Bybit closes the trade by itself even if this site is down. After the fill the position is read
 * back; if either is missing it is set once with trading-stop, and if that fails too the position is closed again at once, reduce only, and the failure is thrown.
 * When Bybit closes a trade by a stop, syncPositions finds out (the account is flat but our record is open), marks it closed with how it closed and its real
 * exit price, and the next signal starts from flat.
 *
 * UNITS. The engine counts a credit spread's price in points and its result as (credit - close price) x 100 x contracts. To keep that arithmetic right without
 * changing it, a price is carried as the dollar value of one contract divided by 100 (price x POSITION_SIZE / 100). A short (a bearish signal) is a "credit"
 * of its entry value and a close price of its exit value; a long (a bullish signal) has the same credit and a close price of (2 x entry - exit), so the
 * engine's (credit - close price) x 100 comes out as exactly (exit - entry) x size. Both are real fill prices from Bybit, never strikes. The strikes and
 * width the engine builds for a position mean nothing to Bybit. Fees are not in that figure; the net figure is Bybit's own closed profit and loss, read
 * afterwards (getContractResult) and stored as the position's result when Bybit gives it.
 *
 * TRADING WINDOW. BYBIT_ALWAYS_ON=true: orders are sent at any time, and the bot has no end of day (nothing is swept; a position stays held until a signal
 * closes it). Otherwise orders are only sent inside BYBIT_HOURS_START to BYBIT_HOURS_END (default 09:35 to 15:55 New York time, Monday to Friday, NYSE calendar),
 * and an end-of-day sweep closes what is held a minute before the window ends. A person's own Close position is never held to the window.
 *
 * SAFETY. An open is only sent when the account holds nothing in the symbol; a close only when the account holds this side in at least the size to close, and
 * it is always reduce only, so it can never open the opposite side. The same order id sent twice gives the same order (Bybit's orderLinkId). The key and secret
 * never appear in an error message, a log line or a request address.
 */

export const BYBIT_DEMO_HOST = "api-demo.bybit.com";
export const DEFAULT_API_BASE = `https://${BYBIT_DEMO_HOST}`;
export const BYBIT_ORDER_PREFIX = { open: "bybit-open-", close: "bybit-close-" } as const;
/** The breakeven stop's defaults (BREAKEVEN_TRIGGER_PERCENT / BREAKEVEN_LOCK_PERCENT unset). */
export const DEFAULT_BREAKEVEN_TRIGGER_PERCENT = 0.3;
export const DEFAULT_BREAKEVEN_LOCK_PERCENT = 0.12;
export const BYBIT_RISK_ENV = ["STOP_LOSS_PERCENT", "TAKE_PROFIT_PERCENT", "POSITION_SIZE", "DAILY_MAX_LOSS_USD"] as const;
const BYBIT_UNDERLYING_NAME = BYBIT_UNDERLYING;
/** retCode when an orderLinkId was used before. */
const DUPLICATE_LINK_ID = 110072;
/** Bybit's "parameter error" retCode, which is what a stop on the wrong side of the price comes back as. */
const TRADING_STOP_PRICE_REFUSED = 10001;
/** retCode when an order to cancel is already over (filled, cancelled) or unknown. */
const ORDER_NOT_FOUND = [110001, 110008, 110010];

export class BybitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BybitConfigError";
  }
}

/** Bybit answered a call with a retCode other than 0: its own words, and the code. */
/** Bybit could not be reached or did not answer (a reset connection, a timeout, "fetch failed"). Nothing says what Bybit did with the request. */
export class BybitNoAnswerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BybitNoAnswerError";
  }
}

/** The failure in words, with the reason underneath it: Node reports a network failure only as "fetch failed" and keeps the real reason (ECONNRESET, ENOTFOUND, a timeout...) in `cause`. */
export function describeFailure(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  if (base.includes("(reason:")) return base; // already explained (a failed call's message carries its reason)
  const reasons: string[] = [];
  let cause: unknown = err instanceof Error ? err.cause : undefined;
  for (let depth = 0; cause !== undefined && cause !== null && depth < 4; depth++) {
    if (cause instanceof Error) {
      const code = (cause as { code?: unknown }).code;
      const text = [typeof code === "string" ? code : "", cause.message && cause.message !== base ? cause.message : ""].filter(Boolean).join(" ");
      if (text) reasons.push(text);
      else if (cause.name) reasons.push(cause.name);
      cause = cause.cause;
    } else {
      reasons.push(String(cause));
      break;
    }
  }
  if (err instanceof Error && err.name && err.name !== "Error" && !reasons.length && !base.includes(err.name)) reasons.push(err.name);
  return reasons.length ? `${base} (reason: ${reasons.join(" <- ")})` : base;
}

/** A read that is safe to ask again: no answer at all, or Bybit saying "busy" or "try later". */
const RETRYABLE_HTTP = [429, 500, 502, 503, 504];
const READ_RETRIES = 2;
const READ_RETRY_DELAY_MS = 1000;
/** Retrying never holds a signal up longer than this, however slow each try is. */
const READ_RETRY_BUDGET_MS = 20_000;
/** A position still "closing" with the account flat is repaired only after the monitor has seen it that way for this long, so a close that is being finished right now is never overtaken. */
const CLOSING_REPAIR_AFTER_MS = 25_000;

/**
 * STOP LOSS SAFETY. A position at Bybit must always have a working stop loss that covers all of it. These are the numbers the rules use.
 *  - STOP_TOLERANCE_PERCENT: how far (in percentage points of the price) a stop may be from where it should be. The stop is worked out from the mark price BEFORE the
 *    market order, and the order fills a little away from it, so right after an entry the stop must be within this of the real fill's STOP_LOSS_PERCENT. 0.05 points is
 *    $37 on a $75,000 BTC: far more than a normal fill's slippage (a few dollars), far less than the 0.3% ($225) stop distance. A stop LOOSER than the intended distance
 *    plus this is wrong at any time; a stop TIGHTER than intended is only wrong right after an entry (a breakeven stop is tighter on purpose).
 *  - STOP_CHECK_BUDGET_MS: after an entry the stop is confirmed within this, however slow the reads are. After it the repair-then-close rule applies at once.
 *  - ALARM_AFTER_MS: the alarm when Bybit cannot be read for this long with a position at risk.
 *  - UNPROTECTED_CAP_MS: how long an entry keeps trying inside its own call before it hands the problem to the watchdog and reports it.
 *  - CLOSE_RETRY_MS: the pause between reduce-only close attempts on an unprotected position.
 */
export const STOP_TOLERANCE_PERCENT = 0.05;
export const STOP_CHECK_BUDGET_MS = 5_000;
export const ALARM_AFTER_MS = 20_000;
const UNPROTECTED_CAP_MS = 30_000;
const CLOSE_RETRY_MS = 1_000;
/** The watchdog's pace. */
export const WATCHDOG_INTERVAL_MS = 1_500;
/** Consecutive failed reads of the watchdog after which new entries are refused (about 4.5 seconds). */
const UNHEALTHY_AFTER_FAILURES = 3;

export interface StopVerdict {
  ok: boolean;
  /** What is wrong, in words (empty when ok). */
  problems: string[];
  /** Not a reason to close: the take profit is missing. */
  takeProfitMissing: boolean;
}

/**
 * Is the stop on this position right? Rules: there is a stop loss; it covers the whole position (Bybit's "Full" mode, not a part of it); it is not looser than
 * STOP_LOSS_PERCENT from the average fill price by more than the tolerance; and, with `strict` (right after an entry), not tighter than that by more than the tolerance either.
 */
export function stopVerdict(held: { side: "Buy" | "Sell" | null; size: number; avgPrice: number | null; stopLoss: number | null; takeProfit: number | null; tpslMode?: string | null }, stopLossPercent: number, opts: { strict?: boolean; tolerancePercent?: number } = {}): StopVerdict {
  const tol = opts.tolerancePercent ?? STOP_TOLERANCE_PERCENT;
  const problems: string[] = [];
  if (held.side === null) return { ok: true, problems, takeProfitMissing: false };
  const avg = held.avgPrice;
  if (held.stopLoss === null) problems.push("there is no stop loss");
  else if (avg !== null && avg > 0) {
    const long = held.side === "Buy";
    const lossPercent = ((long ? avg - held.stopLoss : held.stopLoss - avg) / avg) * 100;
    if (lossPercent > stopLossPercent + tol) problems.push(`the stop loss ${held.stopLoss} is ${lossPercent.toFixed(3)}% from the fill ${avg.toFixed(2)}, looser than the ${stopLossPercent}% it should be (tolerance ${tol} points)`);
    else if (opts.strict && lossPercent < stopLossPercent - tol) problems.push(`the stop loss ${held.stopLoss} is ${lossPercent.toFixed(3)}% from the fill ${avg.toFixed(2)}, not the ${stopLossPercent}% it should be (tolerance ${tol} points)`);
  }
  if (held.tpslMode && /partial/i.test(held.tpslMode)) problems.push(`the stop covers only part of the position (Bybit's ${held.tpslMode} mode), not all ${held.size}`);
  return { ok: problems.length === 0, problems, takeProfitMissing: held.stopLoss !== null && held.takeProfit === null };
}

export class BybitApiError extends Error {
  constructor(message: string, readonly retCode: number) {
    super(message);
    this.name = "BybitApiError";
  }
}

/** Thrown (and nothing is sent) when now is outside the trading window. */
export class BybitWindowError extends OrderNotPlacedError {
  constructor(message: string) {
    super(message);
    this.name = "BybitWindowError";
  }
}

export interface BybitConfig {
  apiKey: string;
  apiSecret: string;
  apiBase: string;
  /** The linear perpetual traded, "BTCUSDT". */
  symbol: string;
  /** POSITION_SIZE: coin per order (one engine contract). Set by the operator; there is no default. */
  qty: number;
  /** STOP_LOSS_PERCENT: how far from the entry (percent of price) Bybit's stop loss sits. */
  stopLossPercent: number;
  /** TAKE_PROFIT_PERCENT: how far from the entry (percent of price) Bybit's take profit sits. */
  takeProfitPercent: number;
  /** DAILY_MAX_LOSS_USD: the day's loss at which everything is closed and new entries are blocked until the next day. */
  dailyMaxLossUsd: number;
  /** BREAKEVEN_TRIGGER_PERCENT: once the open trade is this far in profit (percent of the entry price, at the mark price) the stop loss is moved to breakeven. 0 = off. */
  breakevenTriggerPercent: number;
  /** BREAKEVEN_LOCK_PERCENT: where the moved stop goes: this far on the profit side of the entry price (percent), so a stop out roughly covers the fees. */
  breakevenLockPercent: number;
  /** BYBIT_ALWAYS_ON: orders at any time, no end of day. */
  alwaysOn: boolean;
  /** The hours orders may be sent in when it is not always on, New York time "HH:MM" (BYBIT_HOURS_START / BYBIT_HOURS_END). */
  hoursStart: string;
  hoursEnd: string;
  recvWindow: number;
  timeoutMs: number;
  /** How many more times a read (never an order) is asked after it got no answer. Default 2. */
  readRetries?: number;
  /** The pause between tries, in milliseconds. Default 1000. */
  readRetryDelayMs?: number;
  /** How long a "closing" position must have been seen with the account flat before the monitor closes the record. Default 25 seconds. */
  closingRepairAfterMs?: number;
  /** BYBIT_STOP_TOLERANCE_PERCENT: how far (percentage points of price) a stop may be from where it should be. Default STOP_TOLERANCE_PERCENT (0.05). */
  stopTolerancePercent?: number;
}

type Env = Record<string, string | undefined>;

/** Reads the settings from the environment. Throws a BybitConfigError naming what is missing or wrong (never a value). */
export function readBybitConfig(env: Env = process.env): BybitConfig {
  const get = (n: string) => (env[n] ?? "").trim();
  const missing = ["BYBIT_DEMO_API_KEY", "BYBIT_DEMO_API_SECRET", ...BYBIT_RISK_ENV].filter((n) => !get(n));
  if (missing.length > 0) {
    throw new BybitConfigError(
      `BROKER=bybit will not trade until these are set in .env.local: ${missing.join(", ")}. The key and secret are those of a Bybit DEMO account; STOP_LOSS_PERCENT, TAKE_PROFIT_PERCENT, POSITION_SIZE and DAILY_MAX_LOSS_USD have no defaults, on purpose.`,
    );
  }
  const required = (name: string, min: number, max = Infinity) => {
    const raw = get(name);
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= min || n >= max) throw new BybitConfigError(`${name} must be a plain number above ${min}${max < Infinity ? ` and below ${max}` : ""}, got "${raw}".`);
    return n;
  };
  const optional = (name: string, fallback: number, min: number) => {
    const raw = get(name);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) throw new BybitConfigError(`${name} must be a number of at least ${min}, got "${raw}".`);
    return n;
  };
  const breakevenTriggerPercent = optional("BREAKEVEN_TRIGGER_PERCENT", DEFAULT_BREAKEVEN_TRIGGER_PERCENT, 0);
  const breakevenLockPercent = optional("BREAKEVEN_LOCK_PERCENT", DEFAULT_BREAKEVEN_LOCK_PERCENT, 0);
  if (breakevenTriggerPercent > 0 && breakevenLockPercent >= breakevenTriggerPercent) {
    throw new BybitConfigError(`BREAKEVEN_LOCK_PERCENT (${breakevenLockPercent}) must be below BREAKEVEN_TRIGGER_PERCENT (${breakevenTriggerPercent}): the moved stop has to sit behind the price that triggers it. Set BREAKEVEN_TRIGGER_PERCENT=0 to turn the breakeven stop off.`);
  }
  const base = (get("BYBIT_API_BASE") || DEFAULT_API_BASE).replace(/\/+$/, "");
  let host = "";
  try {
    const u = new URL(base);
    host = u.protocol === "https:" && !u.username && !u.password && u.pathname === "/" ? u.hostname : "";
  } catch {
    /* not an address */
  }
  if (host !== BYBIT_DEMO_HOST) throw new BybitConfigError(`BYBIT_API_BASE must be https://${BYBIT_DEMO_HOST}: this executor is demo only and refuses any other address.`);
  const symbol = (get("BYBIT_SYMBOL") || "BTCUSDT").toUpperCase();
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new BybitConfigError(`BYBIT_SYMBOL must be a USDT linear perpetual such as BTCUSDT, got "${symbol}".`);
  const alwaysRaw = get("BYBIT_ALWAYS_ON").toLowerCase();
  if (alwaysRaw && !["true", "false", "1", "0", "yes", "no", "on", "off"].includes(alwaysRaw)) throw new BybitConfigError(`BYBIT_ALWAYS_ON must be true or false, got "${alwaysRaw}".`);
  const hoursStart = get("BYBIT_HOURS_START") || "09:35";
  const hoursEnd = get("BYBIT_HOURS_END") || "15:55";
  let start: number;
  let end: number;
  try {
    start = parseClockMinutes(hoursStart, "BYBIT_HOURS_START");
    end = parseClockMinutes(hoursEnd, "BYBIT_HOURS_END");
  } catch (err) {
    throw new BybitConfigError(err instanceof Error ? err.message : String(err));
  }
  if (start >= end) throw new BybitConfigError(`BYBIT_HOURS_START (${hoursStart}) must be before BYBIT_HOURS_END (${hoursEnd}).`);
  return {
    apiKey: get("BYBIT_DEMO_API_KEY"),
    apiSecret: get("BYBIT_DEMO_API_SECRET"),
    apiBase: base,
    symbol,
    qty: required("POSITION_SIZE", 0),
    stopLossPercent: required("STOP_LOSS_PERCENT", 0, 100),
    takeProfitPercent: required("TAKE_PROFIT_PERCENT", 0, 100),
    dailyMaxLossUsd: required("DAILY_MAX_LOSS_USD", 0),
    breakevenTriggerPercent,
    breakevenLockPercent,
    alwaysOn: ["true", "1", "yes", "on"].includes(alwaysRaw),
    hoursStart,
    hoursEnd,
    recvWindow: optional("BYBIT_RECV_WINDOW", 5000, 1000),
    timeoutMs: optional("BYBIT_TIMEOUT_MS", 15_000, 1000),
    stopTolerancePercent: optional("BYBIT_STOP_TOLERANCE_PERCENT", STOP_TOLERANCE_PERCENT, 0.001),
  };
}

/** The host an executor may talk to: the demo host, or (only when built as live) the real one. Anything else is refused before a single request can be made. */
export function assertHost(apiBase: string, live: boolean): void {
  let host = "";
  try {
    const u = new URL(apiBase);
    host = u.protocol === "https:" && !u.username && !u.password && u.pathname.replace(/\/+$/, "") === "" && !u.search ? u.hostname : "";
  } catch {
    /* not an address */
  }
  const want = live ? LIVE_HOST : DEMO_HOST;
  if (host !== want) throw new BybitConfigError(live ? `The live executor talks to https://${LIVE_HOST} only, not "${host || "that address"}".` : `This executor is demo only: it refuses every address but https://${DEMO_HOST}.`);
}

export type BybitFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const round8 = (n: number) => Math.round(n * 1e8) / 1e8;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** A quantity as Bybit wants it: a plain decimal string, no exponent, no trailing zeros. */
export const formatQty = (n: number): string => {
  const s = round8(n).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
};

/** The price of one engine contract, in the engine's units: its dollar value divided by 100 (see UNITS above). */
export const toEngineUnits = (price: number, unitQty: number): number => round8((price * unitQty) / 100);

/** The side of the order that opens the position a signal wants: bullish buys, bearish sells short. */
export const openSideFor = (positionType: OpenSpreadRequest["positionType"]): "Buy" | "Sell" => (positionType === "short_put_spread" ? "Buy" : "Sell");

/** The order reference for an order id, and the order id inside one of this executor's references (or null). */
export const refFor = (kind: "open" | "close", orderId: string): string => `${BYBIT_ORDER_PREFIX[kind]}${orderId}`;
export function parseRef(ref: string | null | undefined): { kind: "open" | "close"; orderId: string } | null {
  if (!ref) return null;
  for (const kind of ["open", "close"] as const) {
    if (ref.startsWith(BYBIT_ORDER_PREFIX[kind])) {
      const orderId = ref.slice(BYBIT_ORDER_PREFIX[kind].length);
      return /^[A-Za-z0-9_-]{1,64}$/.test(orderId) ? { kind, orderId } : null;
    }
  }
  return null;
}

/** Bybit's order statuses as the engine's five. An unknown status is an error, never read as "working". */
export function mapBybitStatus(status: string): OrderState["status"] {
  switch (status) {
    case "Created":
    case "New":
    case "Untriggered":
    case "Triggered":
      return "working";
    case "PartiallyFilled":
      return "partially_filled";
    case "Filled":
      return "filled";
    case "Cancelled":
    case "PartiallyFilledCanceled":
    case "Deactivated":
      return "canceled";
    case "Rejected":
      return "rejected";
    default:
      throw new Error(`Bybit gave an order status this engine does not know: "${status}".`);
  }
}

/** The number of decimals in a price tick ("0.10" -> 1). */
const decimalsOf = (tick: number): number => {
  const s = String(tick);
  return s.includes(".") ? s.split(".")[1].length : 0;
};

/**
 * Where the stop loss and take profit go for an entry at `ref`: STOP_LOSS_PERCENT and TAKE_PROFIT_PERCENT away, on the losing and the winning side, rounded to the
 * price tick. A long stops below and takes profit above; a short is the mirror. Throws when rounding leaves either on the wrong side of the entry.
 */
export function protectionPrices(side: "Buy" | "Sell", ref: number, tick: number, stopLossPercent: number, takeProfitPercent: number): { stopLoss: string; takeProfit: string } {
  const long = side === "Buy";
  const round = (x: number) => (Math.round(x / tick) * tick).toFixed(decimalsOf(tick));
  const sl = Number(round(ref * (long ? 1 - stopLossPercent / 100 : 1 + stopLossPercent / 100)));
  const tp = Number(round(ref * (long ? 1 + takeProfitPercent / 100 : 1 - takeProfitPercent / 100)));
  const ok = long ? sl > 0 && sl < ref && tp > ref : tp > 0 && tp < ref && sl > ref;
  if (!ok) throw new Error(`STOP_LOSS_PERCENT ${stopLossPercent} and TAKE_PROFIT_PERCENT ${takeProfitPercent} give a stop at ${sl} and a take profit at ${tp} for a ${long ? "long" : "short"} entered at ${ref}, which is not on the right side of it (price tick ${tick}).`);
  return { stopLoss: sl.toFixed(decimalsOf(tick)), takeProfit: tp.toFixed(decimalsOf(tick)) };
}

interface BybitOrderRow {
  orderId?: string;
  orderLinkId?: string;
  side?: string;
  orderStatus?: string;
  orderType?: string;
  cumExecQty?: string;
  avgPrice?: string;
  rejectReason?: string;
  qty?: string;
  reduceOnly?: boolean;
  cumExecFee?: string;
  stopOrderType?: string;
  createType?: string;
  createdTime?: string;
  updatedTime?: string;
}

/** What moveStopToBreakeven did. "too_late": the price is already beyond the new stop, so the caller closes the trade. */
export type BreakevenOutcome =
  | { status: "off" }
  | { status: "not_yet"; profitPercent: number | null }
  | { status: "moved"; stopLoss: number; previous: number | null }
  | { status: "already_set"; stopLoss: number }
  | { status: "already_tighter"; stopLoss: number }
  | { status: "too_late"; newStop: number; reason: string };

export interface BybitHeld {
  /** The side held, or null when flat. */
  side: "Buy" | "Sell" | null;
  size: number;
  avgPrice: number | null;
  /** Bybit's mark price and the open profit or loss it reports for the position (null when flat or not given). */
  markPrice: number | null;
  unrealisedPnl: number | null;
  /** The stop loss and take profit set on the position at Bybit (null when none). */
  stopLoss: number | null;
  takeProfit: number | null;
  /** Bybit's TP/SL mode for the position: "Full" (the stop covers all of it) or "Partial". Null when Bybit does not say. */
  tpslMode?: string | null;
}

/** One finished trade as Bybit lists it (its closed-pnl record), with how the closing order came about when the order history still shows it. */
export interface BybitClosedTrade {
  /** The closing order's id. */
  orderId: string;
  /** The side of the POSITION that was closed. */
  side: "Long" | "Short";
  size: number;
  entryPrice: number | null;
  exitPrice: number | null;
  /** Bybit's closed profit and loss, net of fees. */
  pnl: number;
  fees: number | null;
  /** The fee for opening and the fee for closing, as Bybit lists them. */
  openFee: number | null;
  closeFee: number | null;
  leverage: number | null;
  /** The dollar value of the position at entry and at exit. */
  entryValue: number | null;
  exitValue: number | null;
  closedAt: number;
  /** Bybit's own stop loss or take profit, a liquidation, an order somebody placed, or null when the order is no longer in the recent history. */
  kind: "stop_loss" | "take_profit" | "liquidation" | "user" | null;
}

/** One call made to Bybit, for a live test's report: what was asked and exactly what came back (never the key or secret). */
export interface BybitTrace {
  method: string;
  path: string;
  params: Record<string, unknown>;
  httpStatus: number | null;
  retCode: number | null;
  retMsg: string | null;
  result: unknown;
}

export class BybitExecutor implements BrokerExecutor {
  readonly venue: ExecutorVenue = "bybit";
  /** The prefixes of the order references this executor makes and reads. The live executor has its own, so a demo executor never mistakes a live order for its own and the router can tell them apart. */
  protected readonly refPrefixes: { open: string; close: string } = BYBIT_ORDER_PREFIX;
  protected mkRef(kind: "open" | "close", orderId: string): string {
    return `${this.refPrefixes[kind]}${orderId}`;
  }
  protected readRef(ref: string | null | undefined): { kind: "open" | "close"; orderId: string } | null {
    if (!ref) return null;
    for (const kind of ["open", "close"] as const) {
      if (ref.startsWith(this.refPrefixes[kind])) {
        const orderId = ref.slice(this.refPrefixes[kind].length);
        return /^[A-Za-z0-9_-]{1,64}$/.test(orderId) ? { kind, orderId } : null;
      }
    }
    return null;
  }
  private readonly sent = new Map<string, { hash: string; ref: string }>();
  /** Per engine order id: how many of its entries were closed again at once. Bybit never lets an order link id be used twice, so a retry gets a new one. */
  private readonly burned = new Map<string, number>();
  private tickCache: { value: number; at: number } | null = null;
  /** Called after every call to Bybit with what came back. For a live test's report. */
  onCall?: (trace: BybitTrace) => void;
  /** Waits between reads of a position that is still settling. Replaced in tests. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Positions seen "closing" while the account was flat, and since when (see repairStuckClosing). */
  private readonly closingSeenFlat = new Map<string, number>();

  /** `fetchImpl`, `log` and `clock` are injectable so tests never touch the network. Constructing the executor makes no request. */
  constructor(
    protected readonly config: BybitConfig,
    private readonly fetchImpl: BybitFetch = (url, init) => fetch(url, init),
    protected readonly log: (line: string) => void = (line) => console.info(line),
    /** The clock, injectable so a test can stand at any moment. */
    protected readonly clock: () => number = Date.now,
    /** `live: true` is passed only by LiveBybitExecutor (bybitLive.ts). Without it this executor can reach the DEMO host and nothing else. */
    options: { live?: boolean } = {},
  ) {
    assertHost(config.apiBase, options.live === true);
  }

  /** The size of one engine contract, in coin (POSITION_SIZE). */
  get positionSize(): number {
    return this.config.qty;
  }

  /** True when orders are sent at any time (no trading window). */
  get alwaysOn(): boolean {
    return this.config.alwaysOn;
  }

  get symbol(): string {
    return this.config.symbol;
  }

  get dailyMaxLossUsd(): number {
    return this.config.dailyMaxLossUsd;
  }

  /** The hours orders may be sent in, for the underlying this executor trades; null for any other. `alwaysOn` when there is no window at all. */
  tradingWindowFor(underlying: string): { start: string; end: string; alwaysOn?: boolean } | null {
    if (underlying.toUpperCase() !== BYBIT_UNDERLYING_NAME) return null;
    return { start: this.config.hoursStart, end: this.config.hoursEnd, ...(this.config.alwaysOn ? { alwaysOn: true } : {}) };
  }

  /** Throws (and sends nothing, not even a read) when now is outside the trading window. */
  private assertInWindow(action: string): void {
    if (this.config.alwaysOn) return;
    const hours = hoursConfigFor({ start: this.config.hoursStart, end: this.config.hoursEnd });
    if (isWithinTradingHours(this.clock(), hours)) return;
    const message = `Skipped: outside trading window (${describeWindow(hours)} New York time, Monday to Friday; BYBIT_ALWAYS_ON=true removes the window): the ${action} was not sent to Bybit.`;
    this.log(`[bybit] ${message}`);
    throw new BybitWindowError(message);
  }

  /** Blanks the key and the secret in any text. One shorter than 4 characters is skipped: it would blank ordinary digits and words. */
  private redact = (s: string): string => [this.config.apiKey, this.config.apiSecret].filter((v) => v.length >= 4).reduce((text, v) => text.split(v).join("***"), s);

  private sign(timestamp: string, payload: string): string {
    return crypto.createHmac("sha256", this.config.apiSecret).update(`${timestamp}${this.config.apiKey}${this.config.recvWindow}${payload}`).digest("hex");
  }

  private trace(t: BybitTrace): void {
    try {
      this.onCall?.(t);
    } catch {
      /* a report must never break a trade */
    }
  }

  /**
   * One call. A private call is signed; a public one is not. Returns Bybit's `result`. A refusal (retCode other than 0) is a BybitApiError; an HTTP error is a
   * BridgeHttpError (the same class the IBKR bridge uses, so a refusal is told from "no answer" in one way); no answer or an unreadable one is an ordinary Error.
   */
  protected async call(method: "GET" | "POST", path: string, params: Record<string, string | number | boolean> | undefined, opts: { auth: boolean; retries?: number }): Promise<Record<string, unknown>> {
    // An ORDER is never sent twice (a lost answer is looked up by its orderLinkId instead). A READ changes nothing at Bybit, so one that got no answer is simply asked again.
    if (method !== "GET") return this.callOnce(method, path, params, opts);
    const retries = opts.retries ?? this.config.readRetries ?? READ_RETRIES;
    const delay = this.config.readRetryDelayMs ?? READ_RETRY_DELAY_MS;
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.callOnce(method, path, params, opts);
      } catch (err) {
        const again = err instanceof BybitNoAnswerError || (err instanceof BridgeHttpError && RETRYABLE_HTTP.includes(err.status));
        if (!again || attempt > retries || Date.now() - started + delay > READ_RETRY_BUDGET_MS) {
          if (attempt > 1 && err instanceof BybitNoAnswerError) throw new BybitNoAnswerError(`${err.message} (tried ${attempt} times)`, { cause: err.cause });
          throw err;
        }
        this.log(`[bybit] ${method} ${path} got no answer (${err instanceof Error ? err.message : String(err)}); asking again (try ${attempt + 1} of ${retries + 1}).`);
        if (delay > 0) await this.sleep(delay);
      }
    }
  }

  private async callOnce(method: "GET" | "POST", path: string, params: Record<string, string | number | boolean> | undefined, opts: { auth: boolean }): Promise<Record<string, unknown>> {
    const entries = Object.entries(params ?? {}).map(([k, v]) => [k, String(v)] as [string, string]);
    const query = method === "GET" && entries.length > 0 ? new URLSearchParams(entries).toString() : "";
    const body = method === "POST" ? JSON.stringify(params ?? {}) : undefined;
    const headers: Record<string, string> = { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) };
    if (opts.auth) {
      const timestamp = String(this.clock());
      headers["X-BAPI-API-KEY"] = this.config.apiKey;
      headers["X-BAPI-TIMESTAMP"] = timestamp;
      headers["X-BAPI-RECV-WINDOW"] = String(this.config.recvWindow);
      headers["X-BAPI-SIGN"] = this.sign(timestamp, body ?? query);
    }
    const asked = { method, path, params: { ...(params ?? {}) } };
    let res: Awaited<ReturnType<BybitFetch>>;
    try {
      res = await this.fetchImpl(`${this.config.apiBase}${path}${query ? `?${query}` : ""}`, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(this.config.timeoutMs) });
    } catch (err) {
      const message = this.redact(`The Bybit request ${method} ${path} could not be completed: ${describeFailure(err)}`);
      this.trace({ ...asked, httpStatus: null, retCode: null, retMsg: message, result: null });
      throw new BybitNoAnswerError(message, { cause: err });
    }
    const text = await res.text();
    if (!res.ok) {
      const message = this.redact(`Bybit ${method} ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
      this.trace({ ...asked, httpStatus: res.status, retCode: null, retMsg: message, result: null });
      throw new BridgeHttpError(message, res.status);
    }
    let json: { retCode?: unknown; retMsg?: unknown; result?: unknown };
    try {
      json = JSON.parse(text);
      if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("not an object");
    } catch {
      this.trace({ ...asked, httpStatus: res.status, retCode: null, retMsg: this.redact(text.slice(0, 200)), result: null });
      throw new Error(`Bybit ${method} ${path} returned something that isn't a JSON object.`);
    }
    const code = num(json.retCode);
    this.trace({ ...asked, httpStatus: res.status, retCode: code, retMsg: typeof json.retMsg === "string" ? json.retMsg : null, result: json.result ?? null });
    if (code === null) throw new Error(`Bybit ${method} ${path} answered without a retCode.`);
    if (code !== 0) throw new BybitApiError(this.redact(`Bybit refused ${method} ${path}: retCode ${code}: ${typeof json.retMsg === "string" ? json.retMsg : "no message"}`), code);
    return (json.result && typeof json.result === "object" ? json.result : {}) as Record<string, unknown>;
  }

  /** The connection check: a signed read that only works with a valid key. Returns the account's equity as Bybit gives it. */
  async checkConnection(): Promise<{ demo: true; totalEquity: number | null }> {
    const result = await this.call("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" }, { auth: true });
    const first = (Array.isArray(result.list) ? result.list[0] : undefined) as { totalEquity?: unknown } | undefined;
    this.log(`[bybit] connected to the demo account (${this.config.apiBase})`);
    return { demo: true, totalEquity: num(first?.totalEquity) };
  }

  /** The host is locked to Bybit's demo address when the settings are read, so this is always true. */
  async isPaperAccount(): Promise<boolean> {
    return true;
  }

  private deriveSymbol(underlying: string | undefined): string {
    if (underlying && underlying.toUpperCase() !== BYBIT_UNDERLYING_NAME) throw new OrderNotPlacedError(`Refused: the Bybit executor serves the BTC Bybit Bot only (its underlying is ${BYBIT_UNDERLYING_NAME}); this order is for ${underlying}, so nothing was sent to Bybit.`);
    return this.config.symbol;
  }

  /** What the account itself holds in the symbol. Throws when it cannot be read or when both sides are held (hedge mode), never a guess. */
  async getAccountPosition(opts: { retries?: number } = {}): Promise<BybitHeld> {
    const result = await this.call("GET", "/v5/position/list", { category: "linear", symbol: this.config.symbol }, { auth: true, ...(opts.retries !== undefined ? { retries: opts.retries } : {}) });
    if (!Array.isArray(result.list)) throw new Error("Bybit's position answer has no list of positions.");
    let buy = 0;
    let sell = 0;
    let value = 0;
    let mark: number | null = null;
    let pnl = 0;
    let sawPnl = false;
    let stopLoss: number | null = null;
    let takeProfit: number | null = null;
    let tpslMode: string | null = null;
    for (const raw of result.list as { side?: string; size?: string; avgPrice?: string; markPrice?: string; unrealisedPnl?: string; stopLoss?: string; takeProfit?: string; tpslMode?: string }[]) {
      const size = num(raw?.size) ?? 0;
      if (size <= 0) continue;
      if (raw.side === "Buy") buy += size;
      else if (raw.side === "Sell") sell += size;
      else throw new Error(`Bybit shows a position with the side "${raw.side ?? ""}" that this engine can't read.`);
      value += size * (num(raw.avgPrice) ?? 0);
      mark = num(raw.markPrice) ?? mark;
      const u = num(raw.unrealisedPnl);
      if (u !== null) {
        pnl += u;
        sawPnl = true;
      }
      const sl = num(raw.stopLoss);
      const tp = num(raw.takeProfit);
      stopLoss = sl !== null && sl > 0 ? sl : stopLoss;
      takeProfit = tp !== null && tp > 0 ? tp : takeProfit;
      if (typeof raw.tpslMode === "string" && raw.tpslMode) tpslMode = raw.tpslMode;
    }
    if (buy > 0 && sell > 0) throw new Error(`The Bybit account holds both a long (${buy}) and a short (${sell}) ${this.config.symbol} position (hedge mode). The bot works in one-way mode: fix this at Bybit.`);
    const size = round8(buy + sell);
    return { side: size === 0 ? null : buy > 0 ? "Buy" : "Sell", size, avgPrice: size === 0 ? null : value / size, markPrice: size === 0 ? null : mark, unrealisedPnl: size === 0 || !sawPnl ? null : pnl, stopLoss: size === 0 ? null : stopLoss, takeProfit: size === 0 ? null : takeProfit, tpslMode: size === 0 ? null : tpslMode };
  }

  /** The mark price (what the stops are worked out from) and the price tick, both from Bybit's public data. */
  private async marketRef(): Promise<{ mark: number; tick: number }> {
    const t = await this.call("GET", "/v5/market/tickers", { category: "linear", symbol: this.config.symbol }, { auth: false });
    const row = (Array.isArray(t.list) ? t.list[0] : undefined) as { markPrice?: string; lastPrice?: string } | undefined;
    const mark = num(row?.markPrice) ?? num(row?.lastPrice);
    if (mark === null || mark <= 0) throw new Error("Bybit gave no usable mark price, so the stop loss and take profit can't be worked out.");
    let tick = this.tickCache && this.clock() - this.tickCache.at < 3_600_000 ? this.tickCache.value : null;
    if (tick === null) {
      const i = await this.call("GET", "/v5/market/instruments-info", { category: "linear", symbol: this.config.symbol }, { auth: false });
      const found = num(((Array.isArray(i.list) ? i.list[0] : undefined) as { priceFilter?: { tickSize?: string } } | undefined)?.priceFilter?.tickSize);
      if (found === null || found <= 0) throw new Error("Bybit gave no price tick for the symbol, so the stop loss and take profit can't be worked out.");
      tick = found;
      this.tickCache = { value: tick, at: this.clock() };
    }
    return { mark, tick };
  }

  /**
   * The breakeven stop. Given what the account holds right now (read by the caller), when the trade is BREAKEVEN_TRIGGER_PERCENT in profit at the mark price the stop loss
   * is moved at Bybit (trading-stop, stop loss only: the take profit is not sent, so it stays) to BREAKEVEN_LOCK_PERCENT past the entry on the profit side. It only ever
   * tightens: a stop already at or past that price is left alone, and a stop already AT it is reported as set. Safe to run twice. It never closes anything itself:
   * "too_late" (the price is already beyond the new stop, or Bybit refused it for that reason, retCode 10001) tells the caller to close the trade instead.
   */
  async moveStopToBreakeven(held: BybitHeld): Promise<BreakevenOutcome> {
    const trigger = this.config.breakevenTriggerPercent;
    if (!(trigger > 0)) return { status: "off" };
    const entry = held.avgPrice;
    const mark = held.markPrice;
    if (held.side === null || entry === null || mark === null || !(entry > 0) || !(mark > 0)) return { status: "not_yet", profitPercent: null };
    const long = held.side === "Buy";
    const profitPercent = ((long ? mark - entry : entry - mark) / entry) * 100;
    if (profitPercent < trigger) return { status: "not_yet", profitPercent };
    const { tick } = await this.marketRef();
    const decimals = decimalsOf(tick);
    const lock = this.config.breakevenLockPercent;
    // Rounded toward the profit side, so the stop is never worse than the lock asked for.
    const raw = entry * (long ? 1 + lock / 100 : 1 - lock / 100);
    const newStop = Number(((long ? Math.ceil(raw / tick - 1e-9) : Math.floor(raw / tick + 1e-9)) * tick).toFixed(decimals));
    if (!(newStop > 0) || (long ? newStop < entry : newStop > entry)) throw new Error(`The breakeven stop ${newStop} is not on the profit side of the entry ${entry} (BREAKEVEN_LOCK_PERCENT ${lock}, price tick ${tick}): nothing was changed.`);
    const current = held.stopLoss;
    if (current !== null) {
      if (Math.abs(current - newStop) < tick / 2) return { status: "already_set", stopLoss: current };
      if (long ? current > newStop : current < newStop) return { status: "already_tighter", stopLoss: current };
    }
    // Price already beyond the new stop: Bybit would refuse it (or fire it at once). The caller closes the trade.
    if (long ? newStop >= mark : newStop <= mark) return { status: "too_late", newStop, reason: `the price (${mark}) is already beyond the new stop (${newStop})` };
    try {
      await this.call("POST", "/v5/position/trading-stop", { category: "linear", symbol: this.config.symbol, tpslMode: "Full", positionIdx: 0, stopLoss: newStop.toFixed(decimals), slTriggerBy: "MarkPrice", slOrderType: "Market" }, { auth: true });
    } catch (err) {
      if (err instanceof BybitApiError && err.retCode === TRADING_STOP_PRICE_REFUSED) return { status: "too_late", newStop, reason: err.message };
      throw err;
    }
    // Read it back: the stop must really be there now, and the take profit must not have moved.
    const after = await this.getAccountPosition();
    if (after.side !== held.side || after.stopLoss === null || Math.abs(after.stopLoss - newStop) >= tick / 2) {
      throw new Error(`Bybit accepted the new stop ${newStop} but the position shows a stop of ${after.stopLoss ?? "none"}: check the Bybit demo account.`);
    }
    if (held.takeProfit !== null && (after.takeProfit === null || Math.abs(after.takeProfit - held.takeProfit) >= tick / 2)) {
      throw new Error(`The stop was moved to ${newStop}, but the take profit now shows ${after.takeProfit ?? "none"} instead of ${held.takeProfit}: check the Bybit demo account.`);
    }
    this.log(`[bybit] breakeven: stop loss moved from ${current ?? "none"} to ${newStop} (entry ${entry}, price ${mark}, ${profitPercent.toFixed(3)}% in profit)`);
    return { status: "moved", stopLoss: newStop, previous: current };
  }

  private orderLinkIdFor(clientOrderId: string | undefined, attempt = 0): string {
    // Bybit allows 36 characters of letters, digits, "-" and "_". The engine's id has colons, so it is hashed (the same id always gives the same link id).
    return `bb${clientOrderId ? crypto.createHash("sha256").update(attempt > 0 ? `${clientOrderId}#${attempt}` : clientOrderId).digest("hex").slice(0, 32) : crypto.randomBytes(16).toString("hex")}`;
  }

  private async findOrder(query: { orderId?: string; orderLinkId?: string }): Promise<BybitOrderRow | null> {
    const params = { category: "linear", symbol: this.config.symbol, ...query };
    for (const path of ["/v5/order/realtime", "/v5/order/history"]) {
      const result = await this.call("GET", path, params, { auth: true });
      const row = (Array.isArray(result.list) ? result.list : []).find((r) => (query.orderId ? (r as BybitOrderRow).orderId === query.orderId : (r as BybitOrderRow).orderLinkId === query.orderLinkId)) as BybitOrderRow | undefined;
      if (row) return row;
    }
    return null;
  }

  /**
   * Sends one market order. A refusal from Bybit (retCode other than 0, or an HTTP 4xx) means no order exists. No answer, a timeout or an unreadable
   * answer is different: the order may exist, so it is looked for by its orderLinkId before anything is called failed, and if it still cannot be known the
   * error says to check Bybit before sending another.
   */
  private async submit(body: Record<string, string | number | boolean>): Promise<string> {
    const linkId = String(body.orderLinkId);
    try {
      const result = await this.call("POST", "/v5/order/create", body, { auth: true });
      const orderId = typeof result.orderId === "string" ? result.orderId : null;
      if (!orderId || !/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) throw new Error("Bybit accepted the order but returned no order id: check the Bybit demo account before sending anything again.");
      return orderId;
    } catch (err) {
      if (err instanceof BybitApiError && err.retCode === DUPLICATE_LINK_ID) {
        const existing = await this.findOrder({ orderLinkId: linkId }).catch(() => null);
        if (existing?.orderId) return existing.orderId;
      }
      if (err instanceof BybitApiError || (err instanceof BridgeHttpError && isRefusalStatus(err.status))) throw new OrderNotPlacedError(err.message, { cause: err });
      if (err instanceof Error && /returned no order id/.test(err.message)) throw err;
      // No answer: it may have gone through.
      const found = await this.findOrder({ orderLinkId: linkId }).catch(() => null);
      if (found?.orderId) {
        this.log(`[bybit] the order request got no answer, but Bybit has the order ${found.orderId}: using it`);
        return found.orderId;
      }
      throw new Error(`${err instanceof Error ? err.message : String(err)} The order may have gone through: check the Bybit demo account before sending another.`);
    }
  }

  /** Why a NEW entry is refused right now (the kill switch, the daily loss limit), or null. Reads our own records only. */
  async entryBlock(botId: string, now: number): Promise<{ outcome: "daily_loss_limit_reached" | "kill_switch"; reason: string } | null> {
    if (/^(true|1|yes|on)$/i.test((process.env.BYBIT_KILL_SWITCH ?? "").trim())) {
      return { outcome: "kill_switch", reason: "Skipped: the kill switch is on (BYBIT_KILL_SWITCH). No new orders are sent." };
    }
    if (botsStore.get(botId)?.killSwitch) return { outcome: "kill_switch", reason: "Skipped: the bot's kill switch is on. No new orders are sent." };
    const limit = dailyLimitBlock(botId, this.config.dailyMaxLossUsd, now, this.config.qty);
    return limit ? { outcome: "daily_loss_limit_reached", reason: limit } : null;
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------
  // STOP LOSS SAFETY. Rule: a position at Bybit never stays without a working stop loss that covers all of it. An unconfirmed stop is treated as a missing one:
  // repair it once, then close the position with reduce-only market orders, retried every second, until the account is protected or flat.
  // ---------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Called when a position is at risk (stop missing, wrong or unconfirmed; Bybit cannot be read) and when that is over. Set by the app (bybitWatchdog.ts); tests set their own. */
  onAlarm?: (alarm: { kind: "stop_problem" | "unreachable" | "resolved"; text: string }) => void;
  /** Called when an entry's stop loss has been CONFIRMED at Bybit (the entry stands). The ledger records it (ledger.ts): it is one of the facts a counted trade is made of. Set by the app. */
  onEntryProtected?: (e: { orderId: string; side: "Buy" | "Sell"; stopLoss: number; takeProfit: number | null; submittedAt: number; confirmedAt: number }) => void;
  /** True when the bot's own records say a Bybit position is held: an unreachable Bybit is then an alarm even if the last read showed flat. Set by the app. */
  exposedHint?: () => boolean;

  /** Time that also counts the pauses asked for, so a test with instant pauses still sees time pass. */
  private slept = 0;
  private mono(): number {
    return Date.now() + this.slept;
  }
  private async pause(ms: number): Promise<void> {
    this.slept += ms;
    await this.sleep(ms);
  }
  private alarm(kind: "stop_problem" | "unreachable" | "resolved", text: string): void {
    this.log(`[bybit] STOP ALARM (${kind}): ${text}`);
    try {
      this.onAlarm?.({ kind, text });
    } catch {
      /* an alarm must never break a trade */
    }
  }

  /** Entries currently confirming their stop: the watchdog leaves those positions to them. */
  private protecting = 0;

  private readonly watch: {
    active: boolean;
    busy: boolean;
    failures: number;
    firstFailAt: number | null;
    unreachableAlarmed: boolean;
    lastHeld: BybitHeld | null;
    episode: { since: number; repaired: boolean } | null;
    tpTried: string | null;
  } = { active: false, busy: false, failures: 0, firstFailAt: null, unreachableAlarmed: false, lastHeld: null, episode: null, tpTried: null };

  /** Whether new entries may go out: not while a position has no correct stop, nor after several failed reads in a row. Always fine until the watchdog has run once. */
  watchdogHealth(): { ok: boolean; reason?: string } {
    const w = this.watch;
    if (!w.active) return { ok: true };
    if (w.episode) return { ok: false, reason: "a position at Bybit has no correct stop loss and is being repaired or closed" };
    if (w.failures >= UNHEALTHY_AFTER_FAILURES) return { ok: false, reason: `Bybit could not be read ${w.failures} times in a row` };
    return { ok: true };
  }

  /** Sets the stop loss and/or take profit on the position as it stands, worked out from the real average fill price, covering all of it (Full mode). */
  private async setStops(side: "Buy" | "Sell", avg: number, which: { stopLoss: boolean; takeProfit: boolean }): Promise<void> {
    const { tick } = await this.marketRef();
    const p = protectionPrices(side, avg, tick, this.config.stopLossPercent, this.config.takeProfitPercent);
    await this.call(
      "POST",
      "/v5/position/trading-stop",
      {
        category: "linear",
        symbol: this.config.symbol,
        tpslMode: "Full",
        positionIdx: 0,
        ...(which.stopLoss ? { stopLoss: p.stopLoss, slTriggerBy: "MarkPrice", slOrderType: "Market" } : {}),
        ...(which.takeProfit ? { takeProfit: p.takeProfit, tpTriggerBy: "MarkPrice", tpOrderType: "Market" } : {}),
      },
      { auth: true },
    );
  }

  /** Read only: the stop orders still waiting at Bybit for this symbol (what a closed position might leave behind). */
  async workingStopOrders(): Promise<{ orderId: string; stopOrderType: string; orderStatus: string }[]> {
    const result = await this.call("GET", "/v5/order/realtime", { category: "linear", symbol: this.config.symbol, orderFilter: "StopOrder", limit: 50 }, { auth: true });
    const list = Array.isArray(result.list) ? (result.list as { orderId?: string; stopOrderType?: string; orderStatus?: string }[]) : [];
    return list
      .filter((o) => ["Untriggered", "New", "PartiallyFilled"].includes(o.orderStatus ?? ""))
      .map((o) => ({ orderId: String(o.orderId ?? ""), stopOrderType: String(o.stopOrderType ?? ""), orderStatus: String(o.orderStatus ?? "") }));
  }

  /** One reduce-only market close. It can never open or add to a position, so it is safe to send even when the position cannot be read. Returns the failure, or null. */
  private async sendReduceOnly(side: "Buy" | "Sell", size: number): Promise<string | null> {
    try {
      // Sent directly, with no look-up of an order whose answer was lost (submit does that): a close that was in fact taken makes the next one a harmless refusal
      // (nothing left to reduce), and a look-up would stretch "every second" to several.
      await this.call("POST", "/v5/order/create", { category: "linear", symbol: this.config.symbol, side: side === "Buy" ? "Sell" : "Buy", orderType: "Market", qty: formatQty(size), reduceOnly: true, positionIdx: 0, orderLinkId: this.orderLinkIdFor(undefined) }, { auth: true });
      return null;
    } catch (err) {
      const why = describeFailure(err);
      this.log(`[bybit] reduce-only close not accepted: ${why}`);
      return why;
    }
  }

  /**
   * After an entry the position must be at Bybit WITH a correct stop loss covering all of it, confirmed within STOP_CHECK_BUDGET_MS (5 seconds) however slow the reads are.
   * Missing, wrong (see stopVerdict), or not confirmable: repair it once, then close with reduce-only market orders every second until protected or flat. A position that
   * cannot be read is treated as unconfirmed. The alarm is raised at once for a missing or wrong stop, and after ALARM_AFTER_MS of failing reads. After UNPROTECTED_CAP_MS
   * this call gives up and reports, and the watchdog (watchdogStep) carries on. Throws in every case but success.
   */
  private async ensureProtected(side: "Buy" | "Sell", qty: number, orderId: string): Promise<void> {
    const t0 = this.mono();
    const long = side === "Buy";
    const word = long ? "long" : "short";
    // 1. Look for the position and its stop, for up to the budget.
    let held: BybitHeld | null = null;
    let sawFlat = false;
    let lastError = "";
    for (;;) {
      try {
        const h = await this.getAccountPosition({ retries: 0 });
        lastError = "";
        if (h.side === side && h.size > 0) {
          held = h;
          break;
        }
        if (h.side !== null) throw new Error(`Bybit shows a ${h.side === "Buy" ? "long" : "short"} ${formatQty(h.size)} ${this.config.symbol} after a ${word} entry. Check the Bybit demo account before sending anything again.`);
        sawFlat = true;
      } catch (err) {
        if (err instanceof Error && /after a (long|short) entry/.test(err.message)) throw err;
        lastError = describeFailure(err);
      }
      if (this.mono() - t0 >= STOP_CHECK_BUDGET_MS) break;
      await this.pause(300);
    }
    if (!held && sawFlat && lastError === "") await this.explainFlat(orderId, false, "");

    // 2. The hard rule.
    let current: BybitHeld | null = held;
    let repaired = false;
    let closed = false;
    let announced = false;
    let unreachableAlarmed = false;
    let why = "";
    let repairNote = "";
    const reason = () => [why || lastError, repairNote].filter(Boolean).join("; ");
    while (this.mono() - t0 < UNPROTECTED_CAP_MS) {
      if (current === null) {
        try {
          current = await this.getAccountPosition({ retries: 0 });
          lastError = "";
        } catch (err) {
          lastError = describeFailure(err);
        }
      }
      if (current === null) {
        // Cannot read: the stop cannot be confirmed. A reduce-only close is safe to send blind, and is the rule.
        if (!unreachableAlarmed && this.mono() - t0 >= ALARM_AFTER_MS) {
          unreachableAlarmed = true;
          this.alarm("unreachable", `A new ${word} ${formatQty(qty)} ${this.config.symbol} is open and Bybit cannot be read for ${Math.round((this.mono() - t0) / 1000)} seconds (${lastError}), so its stop loss cannot be confirmed. Closing it with reduce-only orders until Bybit answers.`);
        }
        why = `Bybit could not be read (${lastError})`;
        closed = true;
        await this.sendReduceOnly(side, qty);
        await this.pause(CLOSE_RETRY_MS);
        continue;
      }
      if (current.side === null) {
        await this.explainFlat(orderId, closed, reason());
        return;
      }
      const verdict = stopVerdict(current, this.config.stopLossPercent, { strict: true, tolerancePercent: this.config.stopTolerancePercent });
      if (verdict.ok) {
        if (announced) this.alarm("resolved", `The ${word} ${formatQty(current.size)} ${this.config.symbol} now has a correct stop loss at ${current.stopLoss}.`);
        if (verdict.takeProfitMissing && !repaired) {
          // The take profit is not the safety: set it once, and carry on if that fails.
          try {
            await this.setStops(side, current.avgPrice ?? current.markPrice ?? 0, { stopLoss: false, takeProfit: true });
          } catch (err) {
            this.log(`[bybit] the take profit could not be set: ${describeFailure(err)}`);
          }
        }
        if (current.size + 1e-9 < qty) this.log(`[bybit] partial fill: ${formatQty(current.size)} of ${formatQty(qty)} ${this.config.symbol} is held; its stop loss covers all of it (${current.tpslMode ?? "Full"} mode).`);
        return;
      }
      why = verdict.problems.join("; ");
      if (!announced) {
        announced = true;
        this.alarm("stop_problem", `A new ${word} ${formatQty(current.size)} ${this.config.symbol} has no correct stop loss: ${why}. Repairing it now; if that does not work the position is closed with reduce-only orders.`);
      }
      if (!repaired) {
        repaired = true;
        try {
          await this.setStops(side, current.avgPrice ?? current.markPrice ?? 0, { stopLoss: true, takeProfit: current.takeProfit === null });
        } catch (err) {
          repairNote = `setting it failed: ${describeFailure(err)}`;
        }
        current = null;
        continue;
      }
      closed = true;
      await this.sendReduceOnly(side, current.size);
      await this.pause(CLOSE_RETRY_MS);
      current = null;
    }
    this.alarm("stop_problem", `A new ${word} ${formatQty(qty)} ${this.config.symbol} is STILL not confirmed to have a correct stop loss after ${Math.round(UNPROTECTED_CAP_MS / 1000)} seconds (${reason()}). The stop-loss watchdog keeps closing it every second. Close it at Bybit now if it is still open.`);
    throw new Error(`UNPROTECTED POSITION: a ${word} ${formatQty(qty)} ${this.config.symbol} may be open at Bybit WITHOUT a confirmed stop loss (${reason()}). Closing it is being retried every second. Close it at Bybit now.`);
  }

  /** The account is flat after an entry: say what that means. A close we sent leaves nothing unprotected; an order Bybit ended is "not placed"; anything else needs a look. */
  private async explainFlat(orderId: string, closedByUs: boolean, why: string): Promise<never> {
    if (closedByUs) {
      throw new OrderNotPlacedError(`Entry closed again at once: the stop loss could not be confirmed on Bybit's side (${why || "not confirmed"}). The Bybit account is flat again; nothing is left without a stop.`);
    }
    const row = await this.findOrder({ orderId }).catch(() => null);
    const dead = row?.orderStatus === "Rejected" || row?.orderStatus === "Cancelled" || row?.orderStatus === "Deactivated";
    if (dead && (num(row?.cumExecQty) ?? 0) === 0) {
      throw new OrderNotPlacedError(`Bybit ended the entry order without filling it (${row?.orderStatus}${row?.rejectReason && row.rejectReason !== "EC_NoError" ? `: ${row.rejectReason}` : ""}). Nothing is held.`);
    }
    throw new Error(`Bybit took order ${orderId}, but the position it should have opened is not visible, so its stop loss could not be confirmed. Check the Bybit demo account before sending anything again.`);
  }

  /**
   * The stop-loss watchdog: one look at the account, run every WATCHDOG_INTERVAL_MS (1.5 seconds) by the app. ANY position at Bybit is in scope, whether the bot has a record
   * of it or not. A correct stop (see stopVerdict; a breakeven stop is fine) changes nothing. A missing or wrong one raises the alarm, is repaired once, and if it is still
   * wrong the position is closed with reduce-only market orders every CLOSE_RETRY_MS until flat. A Bybit that cannot be read is counted: new entries are refused after
   * UNHEALTHY_AFTER_FAILURES in a row, and the alarm goes off after ALARM_AFTER_MS when a position is at risk. The first look after a start is the startup check.
   * A position an entry is still confirming (ensureProtected) is left to it.
   */
  async watchdogStep(now: number = this.clock()): Promise<{ state: "flat" | "protected" | "repaired" | "closed" | "closing" | "unreadable" | "skipped"; startup: boolean; held?: BybitHeld; text?: string }> {
    const w = this.watch;
    if (w.busy || this.protecting > 0) return { state: "skipped", startup: false };
    w.busy = true;
    const startup = !w.active;
    w.active = true;
    try {
      let held: BybitHeld;
      try {
        held = await this.getAccountPosition({ retries: 0 });
      } catch (err) {
        w.failures++;
        w.firstFailAt ??= now;
        const exposed = w.lastHeld?.side != null || this.exposedHint?.() === true;
        if (exposed && !w.unreachableAlarmed && now - w.firstFailAt >= ALARM_AFTER_MS) {
          w.unreachableAlarmed = true;
          this.alarm("unreachable", `Bybit cannot be read for ${Math.round((now - w.firstFailAt) / 1000)} seconds while a position may be open (${describeFailure(err)}). Its stop loss cannot be confirmed from here; the stop at Bybit still works if it was set.`);
        }
        return { state: "unreadable", startup, text: describeFailure(err) };
      }
      if (w.failures > 0 && w.unreachableAlarmed) this.alarm("resolved", "Bybit can be read again.");
      w.failures = 0;
      w.firstFailAt = null;
      w.unreachableAlarmed = false;
      w.lastHeld = held;
      if (held.side === null) {
        w.episode = null;
        return { state: "flat", startup, held, text: startup ? "Startup check: the Bybit account holds no position." : undefined };
      }
      const side = held.side;
      const word = side === "Buy" ? "long" : "short";
      const verdict = stopVerdict(held, this.config.stopLossPercent, { tolerancePercent: this.config.stopTolerancePercent });
      if (verdict.ok) {
        const had = w.episode;
        w.episode = null;
        if (had) this.alarm("resolved", `The ${word} ${formatQty(held.size)} ${this.config.symbol} has a correct stop loss at ${held.stopLoss} again.`);
        if (verdict.takeProfitMissing) {
          const key = `${side}:${held.size}:${held.avgPrice}`;
          if (w.tpTried !== key) {
            w.tpTried = key;
            try {
              await this.setStops(side, held.avgPrice ?? held.markPrice ?? 0, { stopLoss: false, takeProfit: true });
            } catch (err) {
              this.log(`[bybit] watchdog: the take profit could not be set: ${describeFailure(err)}`);
            }
          }
        }
        return { state: "protected", startup, held, text: startup ? `Startup check: the ${word} ${formatQty(held.size)} ${this.config.symbol} has its stop loss at ${held.stopLoss}.` : undefined };
      }
      // A missing or wrong stop.
      const why = verdict.problems.join("; ");
      if (!w.episode) {
        w.episode = { since: this.mono(), repaired: false };
        this.alarm("stop_problem", `${startup ? "Startup check: " : ""}the ${word} ${formatQty(held.size)} ${this.config.symbol} at Bybit has no correct stop loss: ${why}. Repairing it now; if that does not work the position is closed with reduce-only orders every second.`);
      }
      if (!w.episode.repaired) {
        w.episode.repaired = true;
        try {
          await this.setStops(side, held.avgPrice ?? held.markPrice ?? 0, { stopLoss: true, takeProfit: held.takeProfit === null });
        } catch (err) {
          this.log(`[bybit] watchdog: setting the stop failed: ${describeFailure(err)}`);
        }
        try {
          const again = await this.getAccountPosition({ retries: 0 });
          if (again.side === null) {
            w.episode = null;
            return { state: "closed", startup, held: again, text: "The position was gone when the stop was repaired." };
          }
          if (stopVerdict(again, this.config.stopLossPercent, { tolerancePercent: this.config.stopTolerancePercent }).ok) {
            w.episode = null;
            this.alarm("resolved", `The ${word} ${formatQty(again.size)} ${this.config.symbol} stop loss was repaired: it is now at ${again.stopLoss}.`);
            return { state: "repaired", startup, held: again, text: `Repaired the stop loss: ${again.stopLoss}.` };
          }
        } catch {
          /* unreadable after the repair: the stop is unconfirmed, so the close rule applies */
        }
      }
      // Still wrong or unconfirmed: reduce-only closes, every second, until flat (a step gives up after UNPROTECTED_CAP_MS and the next one carries on).
      const stepStart = this.mono();
      while (this.mono() - stepStart < UNPROTECTED_CAP_MS) {
        await this.sendReduceOnly(side, held.size);
        await this.pause(CLOSE_RETRY_MS);
        try {
          const after = await this.getAccountPosition({ retries: 0 });
          if (after.side === null) {
            w.episode = null;
            w.lastHeld = after;
            this.alarm("resolved", `The ${word} ${formatQty(held.size)} ${this.config.symbol} without a correct stop was closed (reduce only). The account is flat.`);
            return { state: "closed", startup, held: after, text: "Closed: no correct stop could be set." };
          }
          held = after;
          if (stopVerdict(after, this.config.stopLossPercent, { tolerancePercent: this.config.stopTolerancePercent }).ok) {
            w.episode = null;
            this.alarm("resolved", `The ${word} ${formatQty(after.size)} ${this.config.symbol} has a correct stop loss at ${after.stopLoss} again.`);
            return { state: "repaired", startup, held: after };
          }
        } catch {
          /* cannot read: send the next close anyway */
        }
      }
      return { state: "closing", startup, held, text: why };
    } finally {
      w.busy = false;
    }
  }

  /** Opens at market, with a stop loss and a take profit on Bybit's side. Only from a flat account, and only when no rule blocks it. */
  async placeOpenOrder(req: OpenSpreadRequest): Promise<{ ref: string }> {
    this.assertInWindow("open");
    const symbol = this.deriveSymbol(req.underlying);
    if (req.quantity !== 1) throw new OrderNotPlacedError(`Refused: the Bybit executor trades one fixed size (POSITION_SIZE = ${formatQty(this.config.qty)} ${symbol}) per order, and this order asks for ${req.quantity} contracts. Set the bot's quantity to 1.`);
    const qty = this.config.qty;
    const side = openSideFor(req.positionType);
    // The same order id again with the same order gives the same answer; with a different order it is refused, as the other executors do.
    const hash = `${side}:${req.quantity}`;
    if (req.clientOrderId) {
      const seen = this.sent.get(req.clientOrderId);
      if (seen) {
        if (seen.hash === hash) return { ref: seen.ref };
        throw new OrderNotPlacedError("Refused: this order id was already used with a different order.");
      }
    }
    const blocked = await this.entryBlock(req.botId, this.clock());
    if (blocked) {
      this.log(`[bybit] ${blocked.reason}`);
      throw new OrderNotPlacedError(blocked.reason);
    }
    // No new position while the stop-loss watchdog says something is wrong (a position without a correct stop, or Bybit unreadable several times in a row).
    const health = this.watchdogHealth();
    if (!health.ok) throw new OrderNotPlacedError(`Refused: the stop-loss watchdog is not healthy (${health.reason}), so no new position is opened until it is. Nothing was sent.`);
    // An open from anything but flat would add to a position, or (the other way) quietly close part of one. It is refused, and nothing is sent.
    let held: BybitHeld;
    try {
      held = await this.getAccountPosition();
    } catch (err) {
      throw new OrderNotPlacedError(`Refused: the Bybit account's position could not be checked first, so nothing was sent: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (held.side !== null) throw new OrderNotPlacedError(`Refused: the Bybit demo account already holds ${held.side === "Buy" ? "a long" : "a short"} ${formatQty(held.size)} ${symbol}. The bot opens from flat only (one position per symbol), so nothing was sent. Close it at Bybit or with Close position.`);
    let protection: { stopLoss: string; takeProfit: string };
    let mark: number;
    try {
      const ref = await this.marketRef();
      mark = ref.mark;
      protection = protectionPrices(side, ref.mark, ref.tick, this.config.stopLossPercent, this.config.takeProfitPercent);
    } catch (err) {
      throw new OrderNotPlacedError(`Refused: the stop loss and take profit could not be worked out, so no entry was sent (an entry never goes out without them): ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const linkId = this.orderLinkIdFor(req.clientOrderId, req.clientOrderId ? (this.burned.get(req.clientOrderId) ?? 0) : 0);
    const submittedAt = this.clock();
    // From the moment the order goes out until its stop is confirmed, the watchdog leaves this position to the entry.
    this.protecting++;
    let orderId: string;
    try {
      orderId = await this.submit({
        category: "linear",
        symbol,
        side,
        orderType: "Market",
        qty: formatQty(qty),
        positionIdx: 0,
        orderLinkId: linkId,
        stopLoss: protection.stopLoss,
        takeProfit: protection.takeProfit,
        slTriggerBy: "MarkPrice",
        tpTriggerBy: "MarkPrice",
        tpslMode: "Full",
        slOrderType: "Market",
        tpOrderType: "Market",
      });
      this.log(`[bybit] opened: ${side} ${formatQty(qty)} ${symbol} at market (mark ${mark}), stop loss ${protection.stopLoss}, take profit ${protection.takeProfit}, order ${orderId}`);
      await this.ensureProtected(side, qty, orderId);
      try {
        this.onEntryProtected?.({ orderId, side, stopLoss: Number(protection.stopLoss), takeProfit: Number(protection.takeProfit) || null, submittedAt, confirmedAt: this.clock() });
      } catch {
        /* a record of the entry must never break it */
      }
    } catch (err) {
      // An entry that was closed again used up its order link id: the same engine order, tried again, gets a new one.
      if (err instanceof OrderNotPlacedError && req.clientOrderId) this.burned.set(req.clientOrderId, (this.burned.get(req.clientOrderId) ?? 0) + 1);
      throw err;
    } finally {
      this.protecting--;
    }
    const ref = this.mkRef("open", orderId);
    if (req.clientOrderId) this.sent.set(req.clientOrderId, { hash, ref });
    return { ref };
  }

  /** Closes at market with a reduce-only order on the opposite side. Only when the account holds this side in at least the size to close. */
  async placeCloseOrder(position: Position, options?: CloseOrderOptions): Promise<{ ref: string }> {
    if (options?.manual !== true) this.assertInWindow("close");
    if (!this.readRef(position.brokerOrderRef)) throw new OrderNotPlacedError("Refused: this position has no Bybit order, so there is nothing to close.");
    const symbol = this.config.symbol;
    const units = options?.quantity ?? (position.filledQuantity || position.requestedQuantity);
    if (!(units > 0) || !Number.isFinite(units)) throw new OrderNotPlacedError(`Refused: ${units} is not a size to close.`);
    const qty = round8(this.config.qty * units);
    const heldSide = openSideFor(position.type);
    const closeSide = heldSide === "Buy" ? "Sell" : "Buy";
    const hash = `${closeSide}:${units}`;
    if (options?.clientOrderId) {
      const seen = this.sent.get(options.clientOrderId);
      if (seen) {
        if (seen.hash === hash) return { ref: seen.ref };
        throw new OrderNotPlacedError("Refused: this order id was already used with a different order.");
      }
    }
    let held: BybitHeld;
    try {
      held = await this.getAccountPosition();
    } catch (err) {
      throw new OrderNotPlacedError(`Refused: the Bybit account's position could not be checked first, so nothing was sent: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    // The position is checked against the account itself, not our own records: a reduce-only order can't open the other side, but it is also not sent for a size that isn't there.
    if (held.side !== heldSide || held.size + 1e-9 < qty) {
      const has = held.side === null ? "nothing" : `${held.side === "Buy" ? "a long" : "a short"} ${formatQty(held.size)}`;
      throw new OrderNotPlacedError(`Refused: the Bybit demo account does not hold this position to close. Needed ${heldSide === "Buy" ? "a long" : "a short"} of ${formatQty(qty)} ${symbol}; it holds ${has}. Nothing was sent.`, { needsResolve: true });
    }
    const orderId = await this.submit({ category: "linear", symbol, side: closeSide, orderType: "Market", qty: formatQty(qty), reduceOnly: true, positionIdx: 0, orderLinkId: this.orderLinkIdFor(options?.clientOrderId) });
    const ref = this.mkRef("close", orderId);
    this.log(`[bybit] closed: ${closeSide} ${formatQty(qty)} ${symbol} at market, reduce only, order ${orderId}`);
    if (options?.clientOrderId) this.sent.set(options.clientOrderId, { hash, ref });
    return { ref };
  }

  /** Reads an order back from Bybit. An open's price is its entry; a close's price is built from its exit and the position's entry (see UNITS). */
  async getOrder(ref: string): Promise<OrderState> {
    const parsed = this.readRef(ref);
    if (!parsed) throw new Error(`"${ref}" is not a Bybit order reference.`);
    const row = await this.findOrder({ orderId: parsed.orderId });
    if (!row) throw new Error(`Bybit has no order ${parsed.orderId} on this account (looked in the live orders and the order history).`);
    if (typeof row.orderStatus !== "string") throw new Error(`Bybit's order ${parsed.orderId} has no status.`);
    const status = mapBybitStatus(row.orderStatus);
    const executed = num(row.cumExecQty) ?? 0;
    const filledQuantity = round8(executed / this.config.qty);
    const reason = typeof row.rejectReason === "string" && row.rejectReason && row.rejectReason !== "EC_NoError" ? row.rejectReason : undefined;
    const state: OrderState = { status, filledQuantity, ibkrStatus: row.orderStatus, ...(reason ? { rejectReason: reason } : {}) };
    if (filledQuantity <= 0) return state;
    const avg = num(row.avgPrice);
    if (avg === null || avg <= 0) throw new Error(`Bybit's order ${parsed.orderId} filled but gave no average price: check the Bybit demo account.`);
    if (parsed.kind === "open") return { ...state, averagePrice: toEngineUnits(avg, this.config.qty) };
    // A close: the position it closes gives the entry.
    const position = positionsStore.query((p) => p.brokerOrderRef === ref)[0];
    if (!position || position.credit == null) throw new Error(`The position closed by Bybit order ${parsed.orderId} has no entry price on record, so its result can't be worked out here: read it at Bybit.`);
    const exit = toEngineUnits(avg, this.config.qty);
    // Closing a long is a Sell: the engine's close price is (2 x entry - exit); closing a short is a Buy: the close price is the exit itself.
    const closePrice = row.side === "Sell" ? round8(2 * position.credit - exit) : exit;
    return { ...state, averagePrice: closePrice };
  }

  /**
   * Bybit's own realised profit and loss for the closing order a reference names, net of fees. `settled` once Bybit lists it. While it is not listed there is no
   * result (the position keeps the figure worked out from the real fill prices). Never worked out from anything else. A read, so it works at any hour.
   */
  async getContractResult(ref: string): Promise<{ settled: boolean; profit: number | null; status: string } | null> {
    const parsed = this.readRef(ref);
    if (!parsed || parsed.kind !== "close") return null;
    const result = await this.call("GET", "/v5/position/closed-pnl", { category: "linear", symbol: this.config.symbol, limit: 50 }, { auth: true });
    const rows = (Array.isArray(result.list) ? result.list : []) as { orderId?: string; closedPnl?: string }[];
    const mine = rows.filter((r) => r.orderId === parsed.orderId);
    if (mine.length === 0) return { settled: false, profit: null, status: "not listed yet" };
    const profit = mine.reduce((sum, r) => sum + (num(r.closedPnl) ?? NaN), 0);
    return { settled: true, profit: Number.isFinite(profit) ? round8(profit) : null, status: "closed" };
  }

  /** A market order is filled when it is answered, but if one is still working when the engine gives up on it, it is cancelled for real. */
  async cancelOrder(ref: string): Promise<void> {
    const parsed = this.readRef(ref);
    if (!parsed) throw new Error(`"${ref}" is not a Bybit order reference.`);
    try {
      await this.call("POST", "/v5/order/cancel", { category: "linear", symbol: this.config.symbol, orderId: parsed.orderId }, { auth: true });
    } catch (err) {
      // Already filled, cancelled or unknown: the order is over, which is what a cancel wants.
      if (err instanceof BybitApiError && ORDER_NOT_FOUND.includes(err.retCode)) {
        this.log(`[bybit] nothing to cancel for ${ref}: the order is already over (${err.retCode})`);
        return;
      }
      throw err;
    }
  }

  /**
   * The trades Bybit itself lists as closed on this account (its closed-pnl records, newest first), whoever placed them, with how each closing order came about. Reads only.
   * The profit and loss is Bybit's own, net of fees.
   */
  async getClosedTrades(limit = 100): Promise<BybitClosedTrade[]> {
    const pnl = await this.call("GET", "/v5/position/closed-pnl", { category: "linear", symbol: this.config.symbol, limit }, { auth: true });
    const history = await this.call("GET", "/v5/order/history", { category: "linear", symbol: this.config.symbol, limit: 50 }, { auth: true }).catch(() => null);
    const byId = new Map(((Array.isArray(history?.list) ? history!.list : []) as BybitOrderRow[]).filter((r) => typeof r.orderId === "string").map((r) => [r.orderId as string, r]));
    const out: BybitClosedTrade[] = [];
    for (const raw of (Array.isArray(pnl.list) ? pnl.list : []) as { orderId?: string; side?: string; qty?: string; closedSize?: string; avgEntryPrice?: string; avgExitPrice?: string; closedPnl?: string; openFee?: string; closeFee?: string; leverage?: string; cumEntryValue?: string; cumExitValue?: string; updatedTime?: string; createdTime?: string }[]) {
      const closedPnl = num(raw.closedPnl);
      if (typeof raw.orderId !== "string" || closedPnl === null || (raw.side !== "Buy" && raw.side !== "Sell")) continue;
      const row = byId.get(raw.orderId);
      const kindText = `${row?.stopOrderType ?? ""} ${row?.createType ?? ""} ${row?.orderType ?? ""}`;
      const kind = !row ? null : /StopLoss/i.test(kindText) ? "stop_loss" : /TakeProfit/i.test(kindText) ? "take_profit" : /Liq|Bust|Adl/i.test(kindText) ? "liquidation" : "user";
      const fees = (num(raw.openFee) ?? 0) + (num(raw.closeFee) ?? 0);
      out.push({
        orderId: raw.orderId,
        // the record's side is the closing order's: a Sell closes a long
        side: raw.side === "Sell" ? "Long" : "Short",
        size: num(raw.closedSize) ?? num(raw.qty) ?? 0,
        entryPrice: num(raw.avgEntryPrice),
        exitPrice: num(raw.avgExitPrice),
        pnl: closedPnl,
        fees: raw.openFee === undefined && raw.closeFee === undefined ? null : round8(fees),
        openFee: num(raw.openFee),
        closeFee: num(raw.closeFee),
        leverage: num(raw.leverage),
        entryValue: num(raw.cumEntryValue),
        exitValue: num(raw.cumExitValue),
        closedAt: num(raw.updatedTime) ?? num(raw.createdTime) ?? 0,
        kind,
      });
    }
    return out.sort((a, b) => b.closedAt - a.closedAt);
  }

  /** Our own rows for this bot. */
  async listPositions(botId: string): Promise<Position[]> {
    return positionsStore.query((p) => p.botId === botId);
  }

  /** The filled order that closed a position at Bybit without us: the latest reduce-only or stop order on the other side since it opened. */
  private async findClosingFill(p: Position): Promise<(BybitOrderRow & { orderId: string }) | null> {
    const closeSide = openSideFor(p.type) === "Buy" ? "Sell" : "Buy";
    const result = await this.call("GET", "/v5/order/history", { category: "linear", symbol: this.config.symbol, limit: 50 }, { auth: true });
    // Only an order made AFTER this position's own entry order can have closed it, so the bound is the entry's time as Bybit lists it (not our clock: seen on the demo, the
    // previous trade's close 4 seconds earlier was taken for this one's stop). When the entry is no longer in the list, our own opening time less 5 seconds. And never an
    // order that already closed another position of ours.
    const all = (Array.isArray(result.list) ? result.list : []) as BybitOrderRow[];
    const entryId = this.readRef(p.brokerOrderRef)?.kind === "open" ? this.readRef(p.brokerOrderRef)!.orderId : null;
    const entryTime = entryId ? num(all.find((r) => r.orderId === entryId)?.createdTime) : null;
    const since = entryTime ?? (p.openedAt ?? 0) - 5_000;
    const used = new Set(positionsStore.query((x) => x.id !== p.id && x.venue === "bybit").map((x) => this.readRef(x.brokerOrderRef)?.orderId).filter((id): id is string => !!id));
    const rows = all
      .filter((r): r is BybitOrderRow & { orderId: string } => typeof r.orderId === "string" && !used.has(r.orderId) && r.orderStatus === "Filled" && r.side === closeSide && (r.reduceOnly === true || (!!r.stopOrderType && r.stopOrderType !== "UNKNOWN")) && (num(r.updatedTime) ?? 0) >= since)
      .sort((a, b) => (num(b.updatedTime) ?? 0) - (num(a.updatedTime) ?? 0));
    return rows[0] ?? null;
  }

  /**
   * Bybit's order history lags the position by about a second: the account can already be flat while the stop's own order is not listed yet (seen on the demo). So a
   * closing order that is not there at first is looked for a few more times before the close is recorded without it.
   */
  private async findClosingFillPatiently(p: Position): Promise<(BybitOrderRow & { orderId: string }) | null> {
    let last: (BybitOrderRow & { orderId: string }) | null = null;
    for (let i = 0; i < 6 && !last; i++) {
      if (i > 0) await this.sleep(1000);
      last = await this.findClosingFill(p);
    }
    return last;
  }

  /**
   * A close recorded without Bybit's closing order (it was not listed yet) is looked at again on the next passes for a while: when the order appears, the exit price, the
   * reason and the order are filled in and the "unknown" is cleared. Returns how many it repaired.
   */
  private async repairUnpricedCloses(botId: string, now: number): Promise<number> {
    const waiting = positionsStore.query((p) => p.botId === botId && p.venue === "bybit" && p.status === "closed" && p.closeReason === "closed_at_broker" && p.closePrice == null && p.closedAt != null && now - p.closedAt < 15 * 60_000);
    let repaired = 0;
    for (const p of waiting) {
      let fill: Awaited<ReturnType<BybitExecutor["findClosingFill"]>> = null;
      try {
        fill = await this.findClosingFill(p);
      } catch {
        continue;
      }
      const exit = fill ? num(fill.avgPrice) : null;
      if (!fill || exit === null || exit <= 0 || p.credit == null) continue;
      const how = this.classify(fill, p.breakevenStop !== undefined);
      const exitU = toEngineUnits(exit, this.config.qty);
      const closedAt = num(fill.updatedTime) ?? p.closedAt!;
      positionsStore.update(p.id, { closePrice: openSideFor(p.type) === "Buy" ? round8(2 * p.credit - exitU) : exitU, closeReason: how.reason, closedAt, brokerOrderRef: this.mkRef("close", fill.orderId), resultUnknown: undefined });
      ordersStore.insert({ id: `ord-${now}-${crypto.randomUUID()}`, positionId: p.id, kind: "close", status: "filled", limitPrice: 0, filledQuantity: positionQuantity(p), ref: this.mkRef("close", fill.orderId), createdAt: closedAt, updatedAt: closedAt });
      const text = `Bybit's closing order is now listed: the trade was closed by ${how.text} at ${exit} (order ${fill.orderId}). The exit price and result are filled in.`;
      this.log(`[bybit] ${text}`);
      logDecision({ signalId: null, botId, outcome: "closed", reason: text, detail: { positionId: p.id, closeReason: how.reason, orderId: fill.orderId, exitPrice: exit, repaired: true }, now });
      repaired++;
    }
    return repaired;
  }

  /** How a closing fill came about: Bybit's stop loss, its take profit, a liquidation, or a person at Bybit. */
  private classify(fill: BybitOrderRow | null, breakeven = false): { reason: CloseReason; text: string } {
    const kind = `${fill?.stopOrderType ?? ""} ${fill?.createType ?? ""} ${fill?.orderType ?? ""}`;
    // A stop that fired on a trade whose stop had been moved to breakeven is the breakeven stop.
    if (/StopLoss/i.test(kind)) return breakeven ? { reason: "breakeven_stop", text: "Bybit's breakeven stop (the stop loss moved to breakeven)" } : { reason: "stop_loss", text: "Bybit's stop loss" };
    if (/TakeProfit/i.test(kind)) return { reason: "take_profit", text: "Bybit's take profit" };
    if (/Liq|Bust|Adl/i.test(kind)) return { reason: "liquidation", text: "a liquidation" };
    return { reason: "closed_at_broker", text: "an order placed at Bybit" };
  }

  /**
   * Finds out what became of this bot's open positions at Bybit. A position the account no longer holds was closed there (by its stop loss or take profit, or by hand):
   * it is marked closed with how it closed and its real exit price, so the bot is flat in our records too and the next signal opens normally. A position whose
   * size or side does not match the account is not changed: the bot is flagged for a person. Reads, then records; sends no order.
   */
  async syncPositions(botId: string, now: number): Promise<number> {
    const repaired = await this.repairUnpricedCloses(botId, now);
    const open = positionsStore.query((p) => p.botId === botId && p.venue === "bybit" && p.status === "open");
    const closing = positionsStore.query((p) => p.botId === botId && p.venue === "bybit" && p.status === "closing");
    if (open.length === 0 && closing.length === 0) {
      this.closingSeenFlat.clear();
      return repaired;
    }
    const held = await this.getAccountPosition();
    let changed = repaired + (await this.repairStuckClosing(botId, closing, held, now));
    for (const p of open) {
      const want = openSideFor(p.type);
      const qty = round8(this.config.qty * positionQuantity(p));
      if (held.side === want && held.size + 1e-9 >= qty) continue;
      if (held.side !== null) {
        const text = `The Bybit account holds ${held.side === "Buy" ? "a long" : "a short"} ${formatQty(held.size)} ${this.config.symbol}, which does not match the bot's open ${want === "Buy" ? "long" : "short"} of ${formatQty(qty)}. Nothing was changed: check the Bybit demo account.`;
        if (botsStore.get(botId)?.needsAttentionReason !== text) {
          botsStore.update(botId, { needsAttention: true, needsAttentionReason: text });
          logDecision({ signalId: null, botId, outcome: "executor_error", reason: text, detail: { positionId: p.id, sync: true }, now });
        }
        continue;
      }
      // Flat at Bybit: it was closed there.
      await this.recordClosedAtBroker(botId, p, want, now, "");
      changed++;
    }
    return changed;
  }
  /** The account is flat, so this position was closed at Bybit: record how it closed and its real exit price. `note` is put in front of the Log line. */
  private async recordClosedAtBroker(botId: string, p: Position, want: "Buy" | "Sell", now: number, note: string): Promise<void> {
    let fill: Awaited<ReturnType<BybitExecutor["findClosingFill"]>> = null;
    try {
      fill = await this.findClosingFillPatiently(p);
    } catch (err) {
      this.log(`[bybit] the account is flat but the closing order could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    const how = this.classify(fill, p.breakevenStop !== undefined);
    const exit = fill ? num(fill.avgPrice) : null;
    let closePrice: number | null = null;
    if (exit !== null && exit > 0 && p.credit != null) {
      const exitU = toEngineUnits(exit, this.config.qty);
      closePrice = want === "Buy" ? round8(2 * p.credit - exitU) : exitU;
    }
    const closedAt = fill ? (num(fill.updatedTime) ?? now) : now;
    positionsStore.update(p.id, {
      status: "closed",
      closedAt,
      closePrice,
      closeReason: how.reason,
      ...(fill ? { brokerOrderRef: this.mkRef("close", fill.orderId) } : {}),
      ...(closePrice === null ? { resultUnknown: unknownResultFor("bybit") } : {}),
    });
    if (fill) {
      ordersStore.insert({ id: `ord-${now}-${crypto.randomUUID()}`, positionId: p.id, kind: "close", status: "filled", limitPrice: 0, filledQuantity: positionQuantity(p), ref: this.mkRef("close", fill.orderId), createdAt: closedAt, updatedAt: closedAt });
    }
    const text = `${note}Closed at Bybit by ${how.text}${exit !== null ? ` at ${exit}` : ""} (order ${fill?.orderId ?? "not found"}). The bot is flat again; the next signal opens normally.`;
    this.log(`[bybit] ${text}`);
    logDecision({ signalId: null, botId, outcome: "closed", reason: text, detail: { positionId: p.id, closeReason: how.reason, ...(fill ? { orderId: fill.orderId } : {}), ...(exit !== null ? { exitPrice: exit } : {}), sync: true }, now });
  }

  /**
   * A position left "closing" (a close whose answer was lost, or whose position check failed) while the account holds nothing: Bybit has closed it, so the record
   * is closed the same way a stop-out is, and the bot is no longer stuck. Only after the account has shown flat for a while, so a close being finished right now
   * is never overtaken; a position the account still holds is left for a person (Resolve). Sends no order.
   */
  private async repairStuckClosing(botId: string, closing: Position[], held: { side: "Buy" | "Sell" | null; size: number }, now: number): Promise<number> {
    const stillClosing = new Set(closing.map((p) => p.id));
    for (const id of [...this.closingSeenFlat.keys()]) if (!stillClosing.has(id) || held.side !== null) this.closingSeenFlat.delete(id);
    if (held.side !== null || closing.length === 0) return 0;
    const wait = this.config.closingRepairAfterMs ?? CLOSING_REPAIR_AFTER_MS;
    let repaired = 0;
    for (const p of closing) {
      const first = this.closingSeenFlat.get(p.id) ?? now;
      this.closingSeenFlat.set(p.id, first);
      if (now - first < wait) continue;
      await this.recordClosedAtBroker(botId, p, openSideFor(p.type), now, `The position was stuck in "closing" and the Bybit account holds nothing. `);
      this.closingSeenFlat.delete(p.id);
      repaired++;
    }
    const bot = botsStore.get(botId);
    if (repaired > 0 && bot?.needsAttention && /stuck in "closing"/.test(bot.needsAttentionReason ?? "") && positionsStore.query((p) => p.botId === botId && p.venue === "bybit" && p.status === "closing").length === 0) {
      botsStore.update(botId, { needsAttention: false, needsAttentionReason: null });
    }
    return repaired;
  }

}
