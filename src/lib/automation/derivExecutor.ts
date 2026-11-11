import "server-only";
import { parseClockMinutes } from "./config";
import { OrderNotPlacedError } from "./orderErrors";
import { positionsStore } from "./store";
import { describeWindow, easternMinutesOfDay, hoursConfigFor, isWithinTradingHours, windowEndMinutes } from "./tradingHours";
import type { BrokerExecutor, CloseOrderOptions, ExecutorVenue, OpenSpreadRequest, OrderState, Position, UnderlyingQuote } from "./types";

/**
 * The Deriv backend: opens and closes contracts on Deriv's US Tech 100 (symbol OTC_NDX) for the NDX bot, in response to the same signals the
 * other executors take. A new backend behind the same interface - the decision engine is unchanged.
 *
 * HOW IT TALKS TO DERIV (checked against the live API, see docs/deriv.md)
 *   1. REST: POST {apiBase}/trading/v1/options/accounts/{accountId}/otp with `Authorization: Bearer <token>` and `Deriv-App-ID` gives
 *      { data: { url } }: a WebSocket URL with a one-time password (valid 120 s, single use).
 *   2. The URL is connected to at once and used for one operation (proposal -> buy, or proposal_open_contract -> sell), then closed. A fresh
 *      OTP per operation means nothing is held open and nothing goes stale.
 *   3. Prices for the underlying come from the PUBLIC WebSocket (no token): ticks_history, count 1.
 *   Fields used: proposal {contract_type, amount, basis:"stake", currency, underlying_symbol, duration, duration_unit | multiplier},
 *   buy {buy:<proposal id>, price:<max price>}, sell {sell:<contract_id>, price:0 = at market}, proposal_open_contract {contract_id}.
 *
 * WHICH CONTRACT. The task asked for Multipliers on US Tech 100, but Deriv does not offer them on OTC_NDX (checked live: MULTUP/MULTDOWN are
 * not offered for that symbol; what it offers is Rise/Fall (CALL/PUT), Higher/Lower, Touch, Stays In/Out and the like). So the default
 * product is "rise_fall": a bullish signal buys CALL, a bearish one buys PUT, for a fixed duration, and a close sells the contract back
 * before it expires. DERIV_PRODUCT=multiplier is supported for symbols that do offer them, and FAILS LOUDLY for one that does not.
 *
 * UNITS. The engine counts a credit spread's price in points and its result as (credit - close price) x 100 x contracts. A Deriv contract has
 * a stake in dollars and a sale value in dollars. To keep the engine's arithmetic right without changing it, prices are reported in hundredths of
 * a dollar per contract: the "credit" of an opening is stake / 100 and the "close price" is (2 x stake - sale value) / 100, so the engine's
 * (credit - close price) x 100 comes out as exactly the profit in dollars. The strikes and width the engine builds are carried on the position but
 * mean nothing to Deriv.
 *
 * TRADING WINDOW. Orders are only sent inside DERIV_HOURS_START to DERIV_HOURS_END (default 09:35 to 15:55), New York time (America/New_York, so it follows
 * daylight saving by itself), Monday to Friday, on the NYSE calendar like the other bots (no holidays; an early-close day ends the same distance before 1:00pm).
 * This is separate from the hours Deriv itself has the instrument open. Outside it nothing is sent to Deriv at all - not even a sign-in - and the reason says so.
 * A person's own Close position is the one exception, so a position can never be left unable to close. Reads (a price, an order's status) are not orders and are not limited.
 *
 * LAST BUY TIME. A new contract is only bought up to (window end - the contract's duration - DERIV_LAST_BUY_MARGIN_MINUTES): 14:50 New York time for a 1 hour
 * contract with the default 5 minute margin. After it a new signal is skipped as "after last buy time" (the engine logs it; nothing is sent, nothing is marked rejected),
 * so a contract that cannot be sold back at the end of the day still expires before the end-of-day sell. Closes are never held to it.
 *
 * RESULTS. A Deriv position's profit or loss is never worked out from strikes or a credit. A sold contract's result is its sale against its stake (Deriv's own numbers); a
 * contract that expired or was not sold gets Deriv's own `profit` for it (see getContractResult), or is marked "unknown, check Deriv". Nothing is estimated.
 *
 * SAFETY. Demo only unless DERIV_ALLOW_REAL=true: a real account's OTP URL is refused before anything is sent. A failed sign-in or OTP is
 * an error, never swallowed. The token and app id never appear in an error message or a log line.
 */

export const DEFAULT_API_BASE = "https://api.derivws.com";
export const DERIV_ORDER_PREFIX = { buy: "deriv-buy-", sell: "deriv-sell-" } as const;
/** The engine's symbols this executor takes, and the Deriv symbol each one is traded as. */
const NDX_NAME = "NDX";

export class DerivConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerivConfigError";
  }
}

/** The REST sign-in (the OTP exchange) was refused, or the connection could not be opened. */
export class DerivAuthError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "DerivAuthError";
  }
}

/** Deriv answered a WebSocket call with an error. */
/** A new contract was refused because it is after the last buy time. Nothing was sent to Deriv. */
export class AfterLastBuyError extends OrderNotPlacedError {
  constructor(message: string) {
    super(message);
    this.name = "AfterLastBuyError";
  }
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** An order was refused because it is outside the trading window. Nothing was sent to Deriv. */
export class TradingWindowError extends OrderNotPlacedError {
  constructor(message: string) {
    super(message);
    this.name = "TradingWindowError";
  }
}

export class DerivApiError extends Error {
  constructor(message: string, readonly code: string, readonly details?: unknown) {
    super(message);
    this.name = "DerivApiError";
  }
}

export type DerivProduct = "rise_fall" | "multiplier";
type DurationUnit = "s" | "m" | "h" | "d";

export interface DerivConfig {
  token: string;
  appId: string;
  accountId: string;
  apiBase: string;
  /** Deriv's symbol for the NDX bot's underlying. */
  symbol: string;
  product: DerivProduct;
  /** Dollars staked per contract the engine asks for. */
  stake: number;
  /** The most one order may stake in total: a larger one is refused. */
  maxStake: number;
  currency: string;
  duration: number;
  durationUnit: DurationUnit;
  /** Multiplier product only. */
  multiplier?: number;
  /** A buy is sent with a ceiling this much (a fraction) above the quoted price. */
  maxSlippage: number;
  allowReal: boolean;
  timeoutMs: number;
  /** The hours orders may be sent in, New York time "HH:MM" (DERIV_HOURS_START / DERIV_HOURS_END). */
  hoursStart: string;
  hoursEnd: string;
  /** Minutes kept between the last buy and the end of the day on top of the contract's duration (DERIV_LAST_BUY_MARGIN_MINUTES, default 5). */
  lastBuyMarginMinutes: number;
}

type Env = Record<string, string | undefined>;

/** The contract's length in minutes (a Multiplier has none). */
export function durationMinutes(c: Pick<DerivConfig, "product" | "duration" | "durationUnit">): number {
  if (c.product === "multiplier") return 0;
  return c.duration * (c.durationUnit === "s" ? 1 / 60 : c.durationUnit === "m" ? 1 : c.durationUnit === "h" ? 60 : 1440);
}

/** DERIV_HOURS_START / DERIV_HOURS_END: "HH:MM" New York time, default 09:35 and 15:55; the start must be before the end. */
function readWindow(get: (n: string) => string): { hoursStart: string; hoursEnd: string } {
  const hoursStart = get("DERIV_HOURS_START") || "09:35";
  const hoursEnd = get("DERIV_HOURS_END") || "15:55";
  let start: number;
  let end: number;
  try {
    start = parseClockMinutes(hoursStart, "DERIV_HOURS_START");
    end = parseClockMinutes(hoursEnd, "DERIV_HOURS_END");
  } catch (err) {
    throw new DerivConfigError(err instanceof Error ? err.message : String(err));
  }
  if (start >= end) throw new DerivConfigError(`DERIV_HOURS_START (${hoursStart}) must be before DERIV_HOURS_END (${hoursEnd}).`);
  return { hoursStart, hoursEnd };
}

/** Reads the settings. Names every missing required one at once. Values are never put in an error. */
export function readDerivConfig(env: Env = process.env): DerivConfig {
  const get = (n: string) => (env[n] ?? "").trim();
  const missing = ["DERIV_API_TOKEN", "DERIV_APP_ID", "DERIV_ACCOUNT_ID"].filter((n) => !get(n));
  if (missing.length > 0) throw new DerivConfigError(`Deriv is selected but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`);
  const num = (name: string, fallback: number, min: number): number => {
    const raw = get(name);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) throw new DerivConfigError(`${name} must be a number of at least ${min}.`);
    return n;
  };
  const productRaw = (get("DERIV_PRODUCT") || "rise_fall").toLowerCase();
  if (productRaw !== "rise_fall" && productRaw !== "multiplier") throw new DerivConfigError(`DERIV_PRODUCT must be "rise_fall" or "multiplier", got "${productRaw}".`);
  const unit = (get("DERIV_DURATION_UNIT") || "h").toLowerCase();
  if (unit !== "s" && unit !== "m" && unit !== "h" && unit !== "d") throw new DerivConfigError(`DERIV_DURATION_UNIT must be s, m, h or d, got "${unit}".`);
  const base = (get("DERIV_API_BASE") || DEFAULT_API_BASE).replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) throw new DerivConfigError("DERIV_API_BASE must be an https:// address.");
  const stake = num("DERIV_STAKE", 10, 0.35);
  const multiplier = get("DERIV_MULTIPLIER") ? num("DERIV_MULTIPLIER", 0, 1) : undefined;
  if (productRaw === "multiplier" && multiplier === undefined) throw new DerivConfigError("DERIV_PRODUCT=multiplier needs DERIV_MULTIPLIER (a value Deriv offers for the symbol).");
  const built: DerivConfig = {
    token: get("DERIV_API_TOKEN"),
    appId: get("DERIV_APP_ID"),
    accountId: get("DERIV_ACCOUNT_ID"),
    apiBase: base,
    symbol: get("DERIV_SYMBOL") || "OTC_NDX",
    product: productRaw,
    stake,
    maxStake: num("DERIV_MAX_STAKE", 100, stake),
    currency: (get("DERIV_CURRENCY") || "USD").toUpperCase(),
    duration: num("DERIV_DURATION", 1, 1),
    durationUnit: unit,
    ...(multiplier !== undefined ? { multiplier } : {}),
    maxSlippage: num("DERIV_MAX_SLIPPAGE", 0.02, 0),
    allowReal: get("DERIV_ALLOW_REAL").toLowerCase() === "true",
    timeoutMs: num("DERIV_TIMEOUT_MS", 15_000, 1000),
    ...readWindow(get),
    lastBuyMarginMinutes: num("DERIV_LAST_BUY_MARGIN_MINUTES", 5, 0),
  };
  // The contract must be able to finish inside the day: a last buy time at or before the start of the window means no contract of this length could ever be bought.
  const lastBuy = parseClockMinutes(built.hoursEnd, "DERIV_HOURS_END") - durationMinutes(built) - built.lastBuyMarginMinutes;
  if (built.product === "rise_fall" && lastBuy <= parseClockMinutes(built.hoursStart, "DERIV_HOURS_START")) {
    throw new DerivConfigError(`A ${built.duration}${built.durationUnit} contract cannot finish inside the trading window ${built.hoursStart} to ${built.hoursEnd} with a ${built.lastBuyMarginMinutes} minute margin: the last buy time would be before the window opens. Use a shorter DERIV_DURATION.`);
  }
  return built;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The wire: a REST fetch and a WebSocket, both injectable so tests never touch a network.
// ---------------------------------------------------------------------------------------------------------------------------------

export type DerivFetch = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The parts of a WebSocket this uses (the global WebSocket of Node 22 has them). */
export interface DerivSocket {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string) => DerivSocket;

const defaultSocketFactory: SocketFactory = (url) => {
  const WS = (globalThis as { WebSocket?: new (url: string) => DerivSocket }).WebSocket;
  if (!WS) throw new DerivAuthError("This Node version has no WebSocket (Node 22 or newer is needed).");
  return new WS(url);
};

type Msg = Record<string, unknown> & { error?: { code?: string; message?: string; details?: unknown } };

/** One WebSocket conversation: each call carries a req_id and waits for the answer with the same one. Any error answer, a timeout or a closed socket is a thrown error. */
export class DerivSession {
  private nextId = 0;
  private waiting = new Map<number, { resolve: (m: Msg) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closedError: Error | null = null;

  private constructor(private readonly ws: DerivSocket, private readonly timeoutMs: number, private readonly redact: (s: string) => string) {
    ws.onmessage = (ev) => {
      let msg: Msg;
      try {
        msg = JSON.parse(String(ev.data)) as Msg;
      } catch {
        return;
      }
      const id = typeof msg.req_id === "number" ? msg.req_id : null;
      const w = id !== null ? this.waiting.get(id) : undefined;
      if (!w || id === null) return;
      clearTimeout(w.timer);
      this.waiting.delete(id);
      if (msg.error) {
        const e = msg.error;
        w.reject(new DerivApiError(this.redact(`Deriv refused the request: ${e.code ?? "error"}: ${e.message ?? "no message"}`), String(e.code ?? "error"), e.details));
      } else w.resolve(msg);
    };
    ws.onclose = () => this.fail(new DerivAuthError("The Deriv connection closed before an answer came."));
    ws.onerror = () => this.fail(new DerivAuthError("The Deriv connection failed."));
  }

  private fail(err: Error): void {
    this.closedError ??= err;
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(err);
      this.waiting.delete(id);
    }
  }

  /** Opens the socket and waits for it to be usable. Fails (loudly) on an error, a close, or too long a wait. */
  static open(url: string, factory: SocketFactory, timeoutMs: number, redact: (s: string) => string): Promise<DerivSession> {
    return new Promise((resolve, reject) => {
      let ws: DerivSocket;
      try {
        ws = factory(url);
      } catch (err) {
        return reject(err);
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new DerivAuthError(`The Deriv WebSocket did not open within ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new DerivSession(ws, timeoutMs, redact));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new DerivAuthError("The Deriv WebSocket could not be opened (the one-time password may have expired or been used already)."));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new DerivAuthError("The Deriv WebSocket closed while opening."));
      };
    });
  }

  call(payload: Record<string, unknown>): Promise<Msg> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = ++this.nextId;
    return new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new DerivAuthError(`Deriv did not answer "${Object.keys(payload)[0]}" within ${Math.round(this.timeoutMs / 1000)} seconds.`));
      }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ ...payload, req_id: id }));
      } catch (err) {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------------------------

const cents = (n: number) => Math.round(n * 100) / 100;
/** Prices are carried in hundredths of a dollar per contract (see the note at the top). */
export const toEngineUnits = (dollars: number) => dollars / 100;

export function contractTypeFor(product: DerivProduct, positionType: OpenSpreadRequest["positionType"]): string {
  const up = positionType === "short_put_spread"; // bullish: the put spread gains when the market holds or rises
  return product === "multiplier" ? (up ? "MULTUP" : "MULTDOWN") : up ? "CALL" : "PUT";
}

/** The contract id inside one of this executor's order references, or null. */
export function contractIdOf(ref: string | null | undefined): number | null {
  if (!ref) return null;
  for (const prefix of Object.values(DERIV_ORDER_PREFIX)) {
    if (ref.startsWith(prefix)) {
      const n = Number(ref.slice(prefix.length));
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  }
  return null;
}

/** True when the WebSocket address the OTP exchange returned is the DEMO one. */
export const isDemoUrl = (url: string): boolean => {
  try {
    return new URL(url).pathname.split("/").includes("demo");
  } catch {
    return false;
  }
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------------------------------------------------------------

export class DerivExecutor implements BrokerExecutor {
  readonly venue: ExecutorVenue = "deriv";
  private demo: boolean | null = null;
  private readonly sent = new Map<string, { hash: string; ref: string }>();

  /** `fetchImpl`, `socketFactory` and `log` are injectable so tests never touch the network. Constructing the executor makes no request. */
  constructor(
    private readonly config: DerivConfig,
    private readonly fetchImpl: DerivFetch = (url, init) => fetch(url, init),
    private readonly socketFactory: SocketFactory = defaultSocketFactory,
    private readonly log: (line: string) => void = (line) => console.info(line),
    /** The clock, injectable so a test can stand at any moment. */
    private readonly clock: () => number = Date.now,
  ) {}

  /** The hours orders may be sent in, for the underlying this executor trades; null for any other. */
  tradingWindowFor(underlying: string): { start: string; end: string } | null {
    return underlying.toUpperCase() === NDX_NAME ? { start: this.config.hoursStart, end: this.config.hoursEnd } : null;
  }

  /** The last minute (minutes after midnight New York time, on the day of `now`) a new contract may be bought, or null for an underlying this executor does not trade. */
  lastBuyMinutesFor(underlying: string, now: number): number | null {
    if (underlying.toUpperCase() !== NDX_NAME) return null;
    const hours = hoursConfigFor({ start: this.config.hoursStart, end: this.config.hoursEnd });
    return windowEndMinutes(now, hours) - Math.ceil(durationMinutes(this.config)) - this.config.lastBuyMarginMinutes;
  }

  /** Throws (and sends nothing) when a new contract can no longer be bought today. */
  private assertBeforeLastBuy(): void {
    const now = this.clock();
    const last = this.lastBuyMinutesFor(NDX_NAME, now);
    if (last === null || easternMinutesOfDay(now) <= last) return;
    const message = `Skipped: after last buy time (${clock(last)} New York time: the window ends ${this.config.hoursEnd}, less the ${this.config.duration}${this.config.durationUnit} contract and a ${this.config.lastBuyMarginMinutes} minute margin): the open was not sent to Deriv.`;
    this.log(`[deriv] ${message}`);
    throw new AfterLastBuyError(message);
  }

  /** Throws (and sends nothing, not even a sign-in) when now is outside the trading window. */
  private assertInWindow(action: string): void {
    const hours = hoursConfigFor({ start: this.config.hoursStart, end: this.config.hoursEnd });
    if (isWithinTradingHours(this.clock(), hours)) return;
    const message = `Skipped: outside trading window (${describeWindow(hours)} New York time, Monday to Friday): the ${action} was not sent to Deriv.`;
    this.log(`[deriv] ${message}`);
    throw new TradingWindowError(message);
  }

  /** Blanks the token and the app id in any text. One shorter than 4 characters is skipped: it would blank ordinary digits and words (the app id is not a secret, the token is long). */
  private redact = (s: string): string => [this.config.token, this.config.appId].filter((v) => v.length >= 4).reduce((text, v) => text.split(v).join("***"), s);

  private get wsBase(): string {
    return this.config.apiBase.replace(/^https:/, "wss:");
  }

  /** Step 1: the one-time WebSocket address. Any refusal is thrown with Deriv's own words; the token is never in them. */
  async getOtpUrl(): Promise<string> {
    const { apiBase, accountId, token, appId, timeoutMs } = this.config;
    let res: Awaited<ReturnType<DerivFetch>>;
    try {
      res = await this.fetchImpl(`${apiBase}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Deriv-App-ID": appId, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DerivAuthError(this.redact(`The Deriv sign-in request could not be sent: ${err instanceof Error ? err.message : String(err)}`));
    }
    const text = await res.text();
    let body: { data?: { url?: unknown }; errors?: { status?: number; code?: string; message?: string }[] } | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const e = body?.errors?.[0];
      throw new DerivAuthError(this.redact(`Deriv refused the sign-in (HTTP ${res.status}${e?.code ? `, ${e.code}` : ""}): ${e?.message ?? text.slice(0, 200)}`), res.status, e?.code);
    }
    const url = body?.data?.url;
    if (typeof url !== "string" || !/^wss:\/\//.test(url)) throw new DerivAuthError("Deriv answered the sign-in without a WebSocket address.", res.status);
    this.demo = isDemoUrl(url);
    if (!this.demo && !this.config.allowReal) {
      throw new DerivAuthError("Refused: this Deriv account is not a demo account (its WebSocket address is not the demo one). Real money needs DERIV_ALLOW_REAL=true, set on purpose.");
    }
    return url;
  }

  private async withTrading<T>(fn: (s: DerivSession) => Promise<T>): Promise<T> {
    const url = await this.getOtpUrl();
    const s = await DerivSession.open(url, this.socketFactory, this.config.timeoutMs, this.redact);
    try {
      return await fn(s);
    } finally {
      s.close();
    }
  }

  private async withPublic<T>(fn: (s: DerivSession) => Promise<T>): Promise<T> {
    const s = await DerivSession.open(`${this.wsBase}/trading/v1/options/ws/public`, this.socketFactory, this.config.timeoutMs, this.redact);
    try {
      return await fn(s);
    } finally {
      s.close();
    }
  }

  /** Signs in and pings: the whole path up to a usable, authenticated session. Throws on any failure. Returns what it learned. */
  async checkConnection(): Promise<{ demo: boolean; accountId: string }> {
    await this.withTrading(async (s) => {
      await s.call({ ping: 1 });
    });
    this.log(`[deriv] connected to account ${this.config.accountId} (${this.demo ? "demo" : "REAL"})`);
    return { demo: this.demo === true, accountId: this.config.accountId };
  }

  async isPaperAccount(): Promise<boolean> {
    if (this.demo === null) {
      try {
        await this.getOtpUrl();
      } catch {
        return false;
      }
    }
    return this.demo === true;
  }

  private deriveSymbol(underlying: string | undefined): string {
    if (underlying && underlying.toUpperCase() !== NDX_NAME) throw new OrderNotPlacedError(`Refused: the Deriv executor trades ${NDX_NAME} only (this order is for ${underlying}).`);
    return this.config.symbol;
  }

  /** A live price for the underlying from the public feed: the latest tick. Null for an underlying this executor does not trade. */
  async getUnderlyingQuote(symbol: string): Promise<UnderlyingQuote | null> {
    if (symbol.toUpperCase() !== NDX_NAME) return null;
    const msg = await this.withPublic((s) => s.call({ ticks_history: this.config.symbol, end: "latest", count: 1, style: "ticks" }));
    const h = msg.history as { prices?: unknown[]; times?: unknown[] } | undefined;
    const price = num(h?.prices?.[0]);
    const epoch = num(h?.times?.[0]);
    if (price === null || price <= 0 || epoch === null || epoch <= 0) return null;
    return { symbol: NDX_NAME, price, asOf: epoch * 1000, delayed: false };
  }

  /** A price proposal for the contract an opening would buy: what it would cost, without buying. Throws Deriv's own words when it is refused. */
  async getProposal(positionType: OpenSpreadRequest["positionType"], quantity = 1): Promise<{ id: string; askPrice: number; spot: number | null; payout: number | null; contractType: string }> {
    const contractType = contractTypeFor(this.config.product, positionType);
    return this.withTrading((s) => this.proposal(s, contractType, quantity));
  }

  private proposalRequest(contractType: string, quantity: number): Record<string, unknown> {
    const c = this.config;
    return {
      proposal: 1,
      contract_type: contractType,
      amount: cents(c.stake * quantity),
      basis: "stake",
      currency: c.currency,
      underlying_symbol: c.symbol,
      ...(c.product === "multiplier" ? { multiplier: c.multiplier } : { duration: c.duration, duration_unit: c.durationUnit }),
    };
  }

  private async proposal(s: DerivSession, contractType: string, quantity: number) {
    if (this.config.product === "multiplier") await this.assertOffered(s, contractType);
    const msg = await s.call(this.proposalRequest(contractType, quantity));
    const p = msg.proposal as { id?: unknown; ask_price?: unknown; spot?: unknown; payout?: unknown } | undefined;
    const askPrice = num(p?.ask_price);
    if (!p || typeof p.id !== "string" || askPrice === null || askPrice <= 0) throw new DerivApiError("Deriv answered the proposal without a usable id and price.", "BadProposal");
    return { id: p.id, askPrice, spot: num(p.spot), payout: num(p.payout), contractType };
  }

  /** A product that Deriv does not offer for the symbol is refused here, in plain words, before anything is bought. */
  private async assertOffered(s: DerivSession, contractType: string): Promise<void> {
    const msg = await s.call({ active_symbols: "brief", contract_type: [contractType] });
    const list = (msg.active_symbols as { underlying_symbol?: string }[] | undefined) ?? [];
    if (!list.some((x) => x.underlying_symbol === this.config.symbol)) {
      throw new DerivApiError(
        `Deriv does not offer ${contractType} (Multipliers) on ${this.config.symbol}. Set DERIV_PRODUCT=rise_fall to trade it with Rise/Fall contracts instead.`,
        "ProductNotOffered",
      );
    }
  }

  async placeOpenOrder(req: OpenSpreadRequest): Promise<{ ref: string }> {
    this.assertInWindow("open");
    this.assertBeforeLastBuy();
    const symbol = this.deriveSymbol(req.underlying);
    if (!Number.isInteger(req.quantity) || req.quantity < 1) throw new OrderNotPlacedError(`Refused: ${req.quantity} is not a whole number of contracts.`);
    const c = this.config;
    const stake = cents(c.stake * req.quantity);
    if (stake > c.maxStake) throw new OrderNotPlacedError(`Refused: staking $${stake} is over the limit of $${c.maxStake} per order (DERIV_MAX_STAKE).`);
    const contractType = contractTypeFor(c.product, req.positionType);
    // The same order id again with the same order gives the same answer; with a different order it is refused, as the IBKR bridge does.
    const hash = `${contractType}:${req.quantity}`;
    if (req.clientOrderId) {
      const seen = this.sent.get(req.clientOrderId);
      if (seen) {
        if (seen.hash === hash) return { ref: seen.ref };
        throw new OrderNotPlacedError("Refused: this order id was already used with a different order.");
      }
    }
    let buyRequestSent = false;
    try {
      const ref = await this.withTrading(async (s) => {
        const p = await this.proposal(s, contractType, req.quantity);
        const ceiling = cents(p.askPrice * (1 + c.maxSlippage));
        buyRequestSent = true;
        const msg = await s.call({ buy: p.id, price: ceiling });
        const b = msg.buy as { contract_id?: unknown; buy_price?: unknown; transaction_id?: unknown; longcode?: unknown } | undefined;
        const contractId = num(b?.contract_id);
        if (!b || contractId === null) throw new DerivApiError("Deriv answered the buy without a contract id: check the Deriv portfolio before sending anything again.", "BadBuy");
        this.log(`[deriv] bought contract ${contractId}: ${contractType} ${symbol} stake $${num(b.buy_price) ?? stake}, transaction ${num(b.transaction_id) ?? "?"}, account ${c.accountId}${typeof b.longcode === "string" ? ` - ${b.longcode}` : ""}`);
        return `${DERIV_ORDER_PREFIX.buy}${contractId}`;
      });
      if (req.clientOrderId) this.sent.set(req.clientOrderId, { hash, ref });
      return { ref };
    } catch (err) {
      // Deriv's own refusal of the proposal or the buy means no contract exists; anything after the buy was sent that is not an answer is unclear.
      if (err instanceof DerivApiError && err.code !== "BadBuy") throw new OrderNotPlacedError(err.message, { cause: err });
      if (!buyRequestSent) throw err instanceof DerivApiError || err instanceof DerivAuthError || err instanceof DerivConfigError ? new OrderNotPlacedError(err.message, { cause: err }) : err;
      throw new Error(`${err instanceof Error ? err.message : String(err)} The buy may have gone through: check the Deriv portfolio before sending another.`);
    }
  }

  /** Sells the contract back at market. The contract id is the one the opening logged. */
  async placeCloseOrder(position: Position, options?: CloseOrderOptions): Promise<{ ref: string }> {
    if (options?.manual !== true) this.assertInWindow("close");
    const contractId = contractIdOf(position.brokerOrderRef);
    if (contractId === null) throw new OrderNotPlacedError("Refused: this position has no Deriv contract id, so there is nothing to sell.");
    const total = position.filledQuantity || position.requestedQuantity;
    if (options?.quantity !== undefined && options.quantity < total) throw new OrderNotPlacedError("Refused: a Deriv contract can't be closed in part.");
    return this.withTrading(async (s) => {
      const poc = await this.openContract(s, contractId);
      const sellRef = `${DERIV_ORDER_PREFIX.sell}${contractId}`;
      if (poc.is_sold === 1) {
        this.log(`[deriv] contract ${contractId} is already sold; reading its sale instead of selling again`);
        return { ref: sellRef };
      }
      if (poc.is_valid_to_sell !== 1) {
        throw new OrderNotPlacedError(`Refused: Deriv says contract ${contractId} can't be sold now${typeof poc.validation_error === "string" ? `: ${poc.validation_error}` : ""}.`);
      }
      let msg: Msg;
      try {
        msg = await s.call({ sell: contractId, price: 0 });
      } catch (err) {
        if (err instanceof DerivApiError) throw new OrderNotPlacedError(err.message, { cause: err });
        throw err;
      }
      const sold = msg.sell as { sold_for?: unknown; transaction_id?: unknown } | undefined;
      const soldFor = num(sold?.sold_for);
      if (!sold || soldFor === null) throw new Error(`Deriv answered the sell for contract ${contractId} without a sale price: check the Deriv portfolio.`);
      this.log(`[deriv] sold contract ${contractId} for $${soldFor}, transaction ${num(sold.transaction_id) ?? "?"}, account ${this.config.accountId}`);
      return { ref: sellRef };
    });
  }

  private async openContract(s: DerivSession, contractId: number): Promise<Record<string, unknown>> {
    const msg = await s.call({ proposal_open_contract: 1, contract_id: contractId });
    const poc = msg.proposal_open_contract as Record<string, unknown> | undefined;
    if (!poc) throw new DerivApiError(`Deriv has no contract ${contractId} on this account.`, "ContractNotFound");
    return poc;
  }

  /** Reads an order back from the contract: a buy is filled once the contract exists; a sell is filled once the contract is sold. */
  async getOrder(ref: string): Promise<OrderState> {
    const contractId = contractIdOf(ref);
    if (contractId === null) throw new Error(`"${ref}" is not a Deriv order reference.`);
    const poc = await this.withTrading((s) => this.openContract(s, contractId));
    const buyTotal = num(poc.buy_price);
    const quantity = buyTotal !== null && buyTotal > 0 ? Math.max(1, Math.round(buyTotal / this.config.stake)) : 1;
    if (ref.startsWith(DERIV_ORDER_PREFIX.buy)) {
      if (buyTotal === null) throw new Error(`Deriv's contract ${contractId} has no buy price.`);
      return { status: "filled", filledQuantity: quantity, averagePrice: toEngineUnits(buyTotal / quantity) };
    }
    if (poc.is_sold !== 1) return { status: "working", filledQuantity: 0 };
    const sale = num(poc.sell_price) ?? num(poc.bid_price);
    if (sale === null || buyTotal === null) throw new Error(`Deriv's contract ${contractId} is sold but gave no sale price.`);
    // (credit - close price) x 100 must be the profit in dollars: credit = stake / 100, so close price = (2 x stake - sale) / 100, per contract.
    const perContract = { stake: buyTotal / quantity, sale: sale / quantity };
    return { status: "filled", filledQuantity: quantity, averagePrice: toEngineUnits(2 * perContract.stake - perContract.sale) };
  }

  /**
   * Deriv's own result for the contract an order reference names. `settled` once Deriv says the contract is sold, won, lost or cancelled, and `profit` is the profit
   * field Deriv reports for it (negative for a loss). While the contract is still open, or when Deriv gives no profit, there is no result: the caller shows
   * "unknown, check Deriv". Never worked out from anything else. A read, so it works at any hour.
   */
  async getContractResult(ref: string): Promise<{ settled: boolean; profit: number | null; status: string } | null> {
    const contractId = contractIdOf(ref);
    if (contractId === null) return null;
    const poc = await this.withTrading((s) => this.openContract(s, contractId));
    const status = typeof poc.status === "string" ? poc.status : poc.is_sold === 1 ? "sold" : "open";
    const settled = status === "sold" || status === "won" || status === "lost" || status === "cancelled" || poc.is_sold === 1;
    return { settled, profit: settled ? num(poc.profit) : null, status };
  }

  /** A Deriv buy or sell is filled when it is answered: there is no working order to cancel. */
  async cancelOrder(ref: string): Promise<void> {
    this.log(`[deriv] nothing to cancel for ${ref}: Deriv orders are filled when they are accepted`);
  }

  /** Our own rows for this bot. */
  async listPositions(botId: string): Promise<Position[]> {
    return positionsStore.query((p) => p.botId === botId);
  }
}
