import "server-only";
import { occSymbol } from "./tradierExecutor";
import type { LegQuotes } from "./smartPricing";
import { positionsStore } from "./store";
import type { BrokerExecutor, BrokerPosition, CloseOrderOptions, ExecutorVenue, OpenSpreadRequest, OrderState, OrderStatus, Position, SpreadQuoteRequest, UnderlyingQuote } from "./types";

/**
 * Interactive Brokers (paper) behind the BrokerExecutor interface, reached through the BRIDGE: a small always-on server that holds the
 * IB Gateway login and speaks plain HTTPS+JSON to this app. This file is only the client for it; the contract it expects is written down in
 * docs/ibkr-bridge-contract.md. Selected with BROKER=ibkr (default is the internal simulation).
 *
 * Nothing here has run against a real bridge yet: the unit tests use a fake `fetch` and response shapes written from the contract.
 *
 * Safety, in this order:
 *  - BRIDGE_URL must be https (plain http only for the machine itself), with no password in it, and BRIDGE_SECRET is sent in a header;
 *  - orders are only sent to a PAPER account (the id starts with "DU") unless IBKR_ALLOW_LIVE=true is set on purpose; the bridge checks
 *    the same thing, so a mistake here is not the only lock;
 *  - live mode also needs hard caps on one order (IBKR_MAX_CONTRACTS_PER_ORDER, IBKR_MAX_RISK_PER_ORDER), with no defaults;
 *  - an order is never sent twice by this client: a timeout leaves the outcome unknown, the engine keeps the position blocking, and the
 *    bridge refuses a repeated clientOrderId;
 *  - an answer that isn't in the agreed shape is an error, never a guess (an unknown order status is not read as "working").
 */

export const IBKR_PAPER_ACCOUNT_PREFIX = "DU";
const ORDER_TIMEOUT_MS = 10_000;
const QUOTE_TIMEOUT_MS = 4_000;
/** The "am I connected, and to which account" answer is reused this long before an order asks again. */
const HEALTH_TTL_MS = 30_000;
const DEFAULT_MAX_QUOTE_AGE_MS = 60_000;
const MIN_SECRET_LENGTH = 16;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class IbkrConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IbkrConfigError";
  }
}

export interface IbkrConfig {
  baseUrl: string;
  secret: string;
  /** Real-money accounts allowed. Off unless IBKR_ALLOW_LIVE=true. */
  allowLive: boolean;
  /** Hard caps on any single OPENING order (closing is never capped). Required when live is allowed. */
  maxContracts: number | null;
  maxRiskPerOrder: number | null;
  /** A quote from the bridge older than this is not a price (paper data without a subscription is often delayed). */
  maxQuoteAgeMs: number;
}

type Env = Record<string, string | undefined>;

export function readIbkrConfig(env: Env = process.env): IbkrConfig {
  const missing = ["BRIDGE_URL", "BRIDGE_SECRET"].filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new IbkrConfigError(`BROKER=ibkr cannot start - required setting${missing.length === 1 ? "" : "s"} not set: ${missing.join(", ")}. No defaults on purpose; nothing is sent until they are set.`);
  }
  const raw = env.BRIDGE_URL!.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IbkrConfigError("BRIDGE_URL is not a valid URL.");
  }
  if (url.username || url.password) throw new IbkrConfigError("BRIDGE_URL must not contain a user name or password; the secret goes in BRIDGE_SECRET.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new IbkrConfigError("BRIDGE_URL must be https (plain http is only allowed for localhost).");
  }
  const secret = env.BRIDGE_SECRET!.trim();
  if (secret.length < MIN_SECRET_LENGTH) throw new IbkrConfigError(`BRIDGE_SECRET is too short: use at least ${MIN_SECRET_LENGTH} characters.`);

  const num = (name: string): number | null => {
    const v = env[name]?.trim();
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new IbkrConfigError(`${name} must be a number above 0, got "${v}".`);
    return n;
  };
  const allowLive = env.IBKR_ALLOW_LIVE === "true";
  const maxContracts = num("IBKR_MAX_CONTRACTS_PER_ORDER");
  const maxRiskPerOrder = num("IBKR_MAX_RISK_PER_ORDER");
  if (allowLive && (maxContracts === null || maxRiskPerOrder === null)) {
    throw new IbkrConfigError("Live IBKR needs IBKR_MAX_CONTRACTS_PER_ORDER and IBKR_MAX_RISK_PER_ORDER set (no defaults): the most contracts, and the most dollars at risk, one opening order may carry.");
  }
  return { baseUrl: raw, secret, allowLive, maxContracts, maxRiskPerOrder, maxQuoteAgeMs: num("BRIDGE_MAX_QUOTE_AGE_MS") ?? DEFAULT_MAX_QUOTE_AGE_MS };
}

/** The bridge's order states are ours already (working, partially_filled, filled, canceled, rejected). Anything else is an error. */
export function mapBridgeOrder(order: Record<string, unknown>): OrderState {
  const status = String(order.status ?? "");
  if (status !== "working" && status !== "partially_filled" && status !== "filled" && status !== "canceled" && status !== "rejected") {
    throw new Error(`The bridge returned an order status this engine doesn't know: "${status}".`);
  }
  const filled = Number(order.filledQuantity ?? 0);
  if (!Number.isFinite(filled) || filled < 0) throw new Error("The bridge returned an order with an unusable filled quantity.");
  const avg = order.averagePrice == null ? undefined : Number(order.averagePrice);
  const averagePrice = avg !== undefined && Number.isFinite(avg) && filled > 0 ? avg : undefined;
  const reason = typeof order.rejectReason === "string" && order.rejectReason ? order.rejectReason : undefined;
  return { status: status as OrderStatus, filledQuantity: filled, ...(averagePrice !== undefined ? { averagePrice } : {}), ...(status === "rejected" ? { rejectReason: reason ?? "Rejected by the broker." } : {}) };
}

export type BridgeFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface BridgeHealth {
  connected: boolean;
  account: string | null;
}

const SYMBOL = /^[A-Za-z]{1,6}$/;

export class IbkrExecutor implements BrokerExecutor {
  readonly venue: ExecutorVenue = "ibkr";
  private health: { at: number; value: BridgeHealth } | null = null;

  /** `fetchImpl` is injectable so tests never touch the network. Constructing the executor makes no request. */
  constructor(
    private readonly config: IbkrConfig,
    private readonly fetchImpl: BridgeFetch = (url, init) => fetch(url, init),
    private readonly clock: () => number = Date.now,
  ) {}

  private async call(method: "GET" | "POST" | "DELETE", path: string, opts: { query?: Record<string, string>; body?: Record<string, unknown>; timeoutMs: number }): Promise<Record<string, unknown>> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
    const res = await this.fetchImpl(`${this.config.baseUrl}${path}${qs}`, {
      method,
      headers: { "X-Bridge-Secret": this.config.secret, Accept: "application/json", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const text = await res.text();
    // The secret is never echoed: only the bridge's own message, shortened.
    if (!res.ok) throw new Error(`Bridge ${method} ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    try {
      const json = JSON.parse(text) as unknown;
      if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("not an object");
      return json as Record<string, unknown>;
    } catch {
      throw new Error(`Bridge ${method} ${path} returned something that isn't a JSON object.`);
    }
  }

  /** Is the Gateway connected, and to which account. */
  async getHealth(): Promise<BridgeHealth> {
    const json = await this.call("GET", "/health", { timeoutMs: QUOTE_TIMEOUT_MS });
    const account = typeof json.account === "string" && json.account.trim() ? json.account.trim() : null;
    return { connected: json.connected === true, account };
  }

  /** Orders only go out when the Gateway is connected and the account is a paper one (unless live was allowed on purpose).
   * Only an answer that passed is kept for a while; a refusal is never reused, so the next order asks again. */
  private async assertReadyToTrade(): Promise<void> {
    const now = this.clock();
    if (this.health && now - this.health.at <= HEALTH_TTL_MS) return;
    this.health = null;
    const { connected, account } = await this.getHealth();
    if (!connected) throw new Error("Refused: the bridge says IB Gateway is not connected, so no order was sent.");
    if (!account) throw new Error("Refused: the bridge did not say which account it is connected to, so no order was sent.");
    if (!this.config.allowLive && !account.startsWith(IBKR_PAPER_ACCOUNT_PREFIX)) {
      throw new Error(`Refused: account ${account} is not a paper account (paper ids start with ${IBKR_PAPER_ACCOUNT_PREFIX}). Real money needs IBKR_ALLOW_LIVE=true, set on purpose.`);
    }
    this.health = { at: now, value: { connected, account } };
  }

  private legs(args: { root: string | undefined; underlying: string | undefined; expiry: string; type: Position["type"]; shortStrike: number; longStrike: number }) {
    if (!args.root) throw new Error("No option root is configured for this bot (e.g. NDXP), and the IBKR executor will not guess one. Set it in the bot's settings.");
    if (!args.underlying) throw new Error("No underlying symbol on this order.");
    const right = args.type === "short_put_spread" ? "put" : "call";
    // Building the option symbols also checks the expiry and strikes are well-formed before anything is sent.
    occSymbol(args.root, args.expiry, right, args.shortStrike);
    occSymbol(args.root, args.expiry, right, args.longStrike);
    return { underlying: args.underlying, root: args.root, expiry: args.expiry, type: args.type, right, shortStrike: args.shortStrike, longStrike: args.longStrike } as const;
  }

  private async submit(path: "/open_spread" | "/close_spread", body: Record<string, unknown>): Promise<{ ref: string }> {
    const json = await this.call("POST", path, { body, timeoutMs: ORDER_TIMEOUT_MS });
    const ref = json.ref;
    if (typeof ref !== "string" || !ref.trim()) throw new Error("The bridge accepted the request but returned no order reference.");
    return { ref: ref.trim() };
  }

  /** Opening credit spread, as ONE combo order so both legs fill together. */
  async placeOpenOrder(req: OpenSpreadRequest): Promise<{ ref: string }> {
    const legs = this.legs({ root: req.optionRoot, underlying: req.underlying, expiry: req.expiry, type: req.positionType, shortStrike: req.shortStrike, longStrike: req.longStrike });
    this.checkOpeningLimits(req);
    await this.assertReadyToTrade();
    return this.submit("/open_spread", { ...legs, ...(req.clientOrderId ? { clientOrderId: req.clientOrderId } : {}), quantity: req.quantity, limitCredit: req.limitCredit, tif: "DAY" });
  }

  /** Hard caps on one opening order, checked before anything is sent. A limit that isn't a credit below the width is refused too. */
  private checkOpeningLimits(req: OpenSpreadRequest): void {
    const width = Math.abs(req.shortStrike - req.longStrike);
    if (!Number.isInteger(req.quantity) || req.quantity < 1) throw new Error(`Refused: ${req.quantity} is not a whole number of contracts.`);
    if (!(req.limitCredit > 0) || req.limitCredit >= width) throw new Error(`Refused: a limit credit of ${req.limitCredit} is not a credit between 0 and the width (${width}).`);
    const { maxContracts, maxRiskPerOrder } = this.config;
    if (maxContracts != null && req.quantity > maxContracts) throw new Error(`Refused: ${req.quantity} contracts is over the limit of ${maxContracts} per order (IBKR_MAX_CONTRACTS_PER_ORDER).`);
    const risk = Math.round((width - req.limitCredit) * 100 * req.quantity * 100) / 100;
    if (maxRiskPerOrder != null && risk > maxRiskPerOrder) throw new Error(`Refused: this order risks $${risk}, over the limit of $${maxRiskPerOrder} per order (IBKR_MAX_RISK_PER_ORDER).`);
  }

  /** Closing: buy back the short, sell the long, as one combo order. With a limit debit it is a limit order; with none, a market order. */
  async placeCloseOrder(position: Position, options?: CloseOrderOptions): Promise<{ ref: string }> {
    const legs = this.legs({ root: position.optionRoot, underlying: position.underlying, expiry: position.expiry, type: position.type, shortStrike: position.shortStrike, longStrike: position.longStrike });
    const quantity = options?.quantity ?? (position.filledQuantity || position.requestedQuantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`Refused: ${quantity} is not a whole number of contracts to close.`);
    if (options?.limitDebit !== undefined && !(options.limitDebit > 0)) throw new Error(`Refused: a limit debit of ${options.limitDebit} is not above 0.`);
    await this.assertReadyToTrade();
    return this.submit("/close_spread", {
      ...legs,
      positionId: position.id,
      ...(options?.clientOrderId ? { clientOrderId: options.clientOrderId } : {}),
      quantity,
      orderType: options?.limitDebit !== undefined ? "limit" : "market",
      ...(options?.limitDebit !== undefined ? { limitDebit: options.limitDebit } : {}),
      tif: "DAY",
    });
  }

  async getOrder(ref: string): Promise<OrderState> {
    return mapBridgeOrder(await this.call("GET", `/order/${encodeURIComponent(ref)}`, { timeoutMs: ORDER_TIMEOUT_MS }));
  }

  async cancelOrder(ref: string): Promise<void> {
    await this.call("DELETE", `/order/${encodeURIComponent(ref)}`, { timeoutMs: ORDER_TIMEOUT_MS });
  }

  /** The bid and ask of each leg (and nothing else is guessed): missing or unusable numbers give null and the engine prices from one number. */
  async getSpreadQuote(req: SpreadQuoteRequest): Promise<LegQuotes | null> {
    const l = this.legs({ root: req.optionRoot, underlying: req.underlying, expiry: req.expiry, type: req.type, shortStrike: req.shortStrike, longStrike: req.longStrike });
    const json = await this.call("GET", "/quote/spread", {
      query: { underlying: l.underlying, root: l.root, expiry: l.expiry, type: l.type, shortStrike: String(l.shortStrike), longStrike: String(l.longStrike) },
      timeoutMs: QUOTE_TIMEOUT_MS,
    });
    const leg = (v: unknown) => {
      const o = (v ?? {}) as { bid?: unknown; ask?: unknown };
      const bid = o.bid == null ? NaN : Number(o.bid);
      const ask = o.ask == null ? NaN : Number(o.ask);
      return Number.isFinite(bid) && Number.isFinite(ask) && bid >= 0 && ask >= bid ? { bid, ask } : null;
    };
    const short = leg(json.short);
    const long = leg(json.long);
    return short && long ? { short, long } : null;
  }

  /** The bridge's quote for an index. Null when it has no usable one, or the one it has is older than BRIDGE_MAX_QUOTE_AGE_MS. */
  async getUnderlyingQuote(symbol: string): Promise<UnderlyingQuote | null> {
    if (!SYMBOL.test(symbol)) throw new Error(`"${symbol}" is not a symbol the bridge can quote.`);
    const json = await this.call("GET", `/quote/${symbol.toLowerCase()}`, { timeoutMs: QUOTE_TIMEOUT_MS });
    const price = Number(json.price);
    const asOf = Number(json.asOf);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(asOf) || asOf <= 0) return null;
    if (this.clock() - asOf > this.config.maxQuoteAgeMs) return null;
    return { symbol: symbol.toUpperCase(), price, asOf, ...(json.delayed === true ? { delayed: true } : {}) };
  }

  /** What the account itself holds, as option symbols and signed contracts. A malformed answer is an error, never an empty list: an empty one would read as "nothing is open". */
  async listBrokerPositions(): Promise<BrokerPosition[]> {
    const json = await this.call("GET", "/positions", { timeoutMs: ORDER_TIMEOUT_MS });
    if (!Array.isArray(json.positions)) throw new Error("The bridge's positions answer has no list of positions.");
    return json.positions.map((p: unknown) => {
      const o = p as { symbol?: unknown; quantity?: unknown };
      const quantity = Number(o?.quantity);
      if (typeof o?.symbol !== "string" || !o.symbol || !Number.isFinite(quantity)) throw new Error("The bridge returned a position this engine can't read.");
      return { symbol: o.symbol, quantity };
    });
  }

  /** Our own rows for this bot; the broker's account positions are checked against them by reconcile. */
  async listPositions(botId: string): Promise<Position[]> {
    return positionsStore.query((p) => p.botId === botId);
  }
}
