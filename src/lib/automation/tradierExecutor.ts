import "server-only";
import type { LegQuotes } from "./smartPricing";
import type { BrokerBalances, BrokerExecutor, BrokerPosition, ExecutorVenue, OpenSpreadRequest, OrderState, OrderStatus, Position, SpreadQuoteRequest } from "./types";
import { positionsStore } from "./store";

/**
 * Tradier behind the BrokerExecutor interface. IMPLEMENTED BUT DISABLED: the
 * app only builds it when EXECUTOR=tradier, and the default is the mock.
 *
 * Nothing in this file has been run against a real Tradier account. It is
 * covered by unit tests with a fake `fetch` and SAMPLE response shapes written
 * from Tradier's docs - they are not recordings from a live account. Every
 * point the docs do not settle is marked TODO(unconfirmed) below and in
 * docs/tradier-executor-research.md. Nothing here guesses past them silently.
 */

export const TRADIER_SANDBOX_URL = "https://sandbox.tradier.com/v1";
export const TRADIER_PRODUCTION_URL = "https://api.tradier.com/v1";

const SANDBOX_HOST = "sandbox.tradier.com";
const PRODUCTION_HOST = "api.tradier.com";
const REQUEST_TIMEOUT_MS = 15_000;

export class TradierConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TradierConfigError";
  }
}

export interface TradierConfig {
  token: string;
  accountId: string;
  /** Always one of the two Tradier hosts; sandbox unless production was explicitly allowed. */
  baseUrl: string;
  sandbox: boolean;
  /** Hard caps on any single OPENING order (closing is never capped). Required for production, optional in the sandbox. */
  maxContracts?: number | null;
  maxRiskPerOrder?: number | null;
}

type Env = Record<string, string | undefined>;

/** Reads and validates the Tradier settings. Throws a plain-language error
 * rather than starting half-configured:
 *   - TRADIER_TOKEN and TRADIER_ACCOUNT_ID are required (no defaults);
 *   - the base URL defaults to the SANDBOX;
 *   - the production host is refused unless TRADIER_ALLOW_PRODUCTION=true is
 *     set separately, and any other host is refused outright. */
export function readTradierConfig(env: Env = process.env): TradierConfig {
  const missing = ["TRADIER_TOKEN", "TRADIER_ACCOUNT_ID"].filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new TradierConfigError(`EXECUTOR=tradier cannot start - required setting${missing.length === 1 ? "" : "s"} not set: ${missing.join(", ")}. No defaults on purpose; nothing is sent until they are set.`);
  }

  const raw = (env.TRADIER_BASE_URL?.trim() || TRADIER_SANDBOX_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TradierConfigError(`TRADIER_BASE_URL is not a valid URL: "${raw}".`);
  }
  if (url.protocol !== "https:") throw new TradierConfigError("TRADIER_BASE_URL must be https.");
  if (url.hostname === PRODUCTION_HOST) {
    if (env.TRADIER_ALLOW_PRODUCTION !== "true") {
      throw new TradierConfigError(`Refusing to use Tradier's PRODUCTION URL (${raw}). The default is the sandbox (${TRADIER_SANDBOX_URL}). Production needs its own explicit setting, TRADIER_ALLOW_PRODUCTION=true, and Blue's approval.`);
    }
  } else if (url.hostname !== SANDBOX_HOST) {
    throw new TradierConfigError(`TRADIER_BASE_URL host "${url.hostname}" is not a Tradier host. Allowed: ${SANDBOX_HOST} (default), and ${PRODUCTION_HOST} only with TRADIER_ALLOW_PRODUCTION=true.`);
  }

  const sandbox = url.hostname === SANDBOX_HOST;
  const cap = (name: string): number | null => {
    const v = env[name]?.trim();
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new TradierConfigError(`${name} must be a number above 0, got "${v}".`);
    return n;
  };
  const maxContracts = cap("TRADIER_MAX_CONTRACTS_PER_ORDER");
  const maxRiskPerOrder = cap("TRADIER_MAX_RISK_PER_ORDER");
  // Real money gets hard limits on what one order can be. They have no defaults: someone has to choose the numbers.
  if (!sandbox && (maxContracts === null || maxRiskPerOrder === null)) {
    throw new TradierConfigError("Production Tradier needs TRADIER_MAX_CONTRACTS_PER_ORDER and TRADIER_MAX_RISK_PER_ORDER set (no defaults): the most contracts, and the most dollars at risk, one opening order may carry.");
  }
  return { token: env.TRADIER_TOKEN!.trim(), accountId: env.TRADIER_ACCOUNT_ID!.trim(), baseUrl: raw, sandbox, maxContracts, maxRiskPerOrder };
}

/** OCC-style option symbol: ROOT + YYMMDD + C|P + strike x 1000 in 8 digits
 * (e.g. NDXP261006P20975000).
 * TODO(unconfirmed): Tradier's docs only show an equity example
 * (AAPL251017C00247500). Whether the index roots (NDXP, SPXW) are sent bare
 * like this, or padded, is not confirmed - check a real `markets/options/lookup`
 * response for NDX before the first order. */
export function occSymbol(root: string, expiry: string, right: "call" | "put", strike: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (!m) throw new Error(`Bad expiry "${expiry}" - expected YYYY-MM-DD.`);
  const thousandths = strike * 1000;
  if (!Number.isInteger(thousandths) || thousandths < 0 || thousandths >= 1e8) throw new Error(`Strike ${strike} can't be written as an option symbol.`);
  return `${root}${m[1].slice(2)}${m[2]}${m[3]}${right === "call" ? "C" : "P"}${String(thousandths).padStart(8, "0")}`;
}

/** TODO(unconfirmed): the docs say an order's `status` is one of these eight
 * values; how `exec_quantity` / `avg_fill_price` / the reject reason are named
 * on a multileg order comes from memory of Tradier's response, not a recording. */
export function mapTradierOrder(order: Record<string, unknown>): OrderState {
  const status = String(order.status ?? "");
  const quantity = Number(order.quantity ?? 0);
  const filled = Number(order.exec_quantity ?? 0) || 0;
  const avg = order.avg_fill_price == null ? undefined : Number(order.avg_fill_price);
  const averagePrice = avg !== undefined && Number.isFinite(avg) && filled > 0 ? avg : undefined;

  let mapped: OrderStatus;
  switch (status) {
    case "filled":
      mapped = "filled";
      break;
    case "partially_filled":
      mapped = "partially_filled";
      break;
    case "canceled":
    case "expired":
      mapped = "canceled";
      break;
    case "rejected":
      mapped = "rejected";
      break;
    case "pending":
    case "open":
    case "pending_cancel": // still live until the cancel lands
      mapped = filled > 0 && filled < quantity ? "partially_filled" : "working";
      break;
    default:
      throw new Error(`Tradier returned an order status this engine doesn't know: "${status}".`);
  }
  const reason = typeof order.reason_description === "string" ? order.reason_description : undefined;
  return { status: mapped, filledQuantity: filled, ...(averagePrice !== undefined ? { averagePrice } : {}), ...(mapped === "rejected" ? { rejectReason: reason ?? "Rejected by Tradier." } : {}) };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class TradierExecutor implements BrokerExecutor {
  readonly venue: ExecutorVenue = "tradier";

  /** `fetchImpl` is injectable so tests never touch the network. Constructing
   * the executor makes no request. */
  constructor(
    private readonly config: TradierConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  private async call(method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, string>): Promise<Record<string, unknown>> {
    const url = `${this.config.baseUrl}/accounts/${encodeURIComponent(this.config.accountId)}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/json",
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      // Never echo the token; the body is Tradier's own message.
      throw new Error(`Tradier ${method} ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Tradier ${method} ${path} returned something that isn't JSON.`);
    }
  }

  /** Market data lives outside the account's path: GET {base}/markets/... */
  private async market(path: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    const url = `${this.config.baseUrl}${path}?${new URLSearchParams(query).toString()}`;
    const res = await this.fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${this.config.token}`, Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Tradier GET ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Tradier GET ${path} returned something that isn't JSON.`);
    }
  }

  private legs(args: { root: string | undefined; underlying: string | undefined; expiry: string; type: Position["type"]; shortStrike: number; longStrike: number }) {
    if (!args.root) throw new Error("No option root is configured for this bot (e.g. NDXP, SPXW), and the Tradier executor will not guess one. Set it in the bot's settings. TODO(unconfirmed): the right root for daily index expirations.");
    if (!args.underlying) throw new Error("No underlying symbol on this order.");
    const right = args.type === "short_put_spread" ? "put" : "call";
    return {
      underlying: args.underlying,
      short: occSymbol(args.root, args.expiry, right, args.shortStrike),
      long: occSymbol(args.root, args.expiry, right, args.longStrike),
    };
  }

  private async submit(form: Record<string, string>): Promise<{ ref: string }> {
    const json = await this.call("POST", "/orders", form);
    const id = (json.order as { id?: unknown } | undefined)?.id;
    if (id === undefined || id === null || id === "") throw new Error("Tradier accepted the request but returned no order id.");
    return { ref: String(id) };
  }

  /** Opening credit spread: sell the short leg, buy the long leg.
   * TODO(unconfirmed): how a CREDIT price is expressed on a multileg order -
   * the docs only say `price` is "the limit price". Sent here as a positive
   * number with type=credit; confirm with Tradier's preview-order call before
   * the first real order. */
  async placeOpenOrder(req: OpenSpreadRequest): Promise<{ ref: string }> {
    this.checkOpeningLimits(req);
    const { underlying, short, long } = this.legs({ root: req.optionRoot, underlying: req.underlying, expiry: req.expiry, type: req.positionType, shortStrike: req.shortStrike, longStrike: req.longStrike });
    return this.submit({
      class: "multileg",
      symbol: underlying,
      type: "credit",
      duration: "day",
      price: String(req.limitCredit),
      "option_symbol[0]": short,
      "side[0]": "sell_to_open",
      "quantity[0]": String(req.quantity),
      "option_symbol[1]": long,
      "side[1]": "buy_to_open",
      "quantity[1]": String(req.quantity),
    });
  }

  /** The hard caps on one opening order. Checked before anything is sent; they exist so a wrong setting
   * can't turn into a big order. A limit price that isn't a credit below the width is refused too. */
  private checkOpeningLimits(req: OpenSpreadRequest): void {
    const width = Math.abs(req.shortStrike - req.longStrike);
    if (!(req.limitCredit > 0) || req.limitCredit >= width) throw new Error(`Refused: a limit credit of ${req.limitCredit} is not a credit between 0 and the width (${width}).`);
    const { maxContracts, maxRiskPerOrder } = this.config;
    if (maxContracts != null && req.quantity > maxContracts) throw new Error(`Refused: ${req.quantity} contracts is over the limit of ${maxContracts} per order (TRADIER_MAX_CONTRACTS_PER_ORDER).`);
    const risk = Math.round((width - req.limitCredit) * 100 * req.quantity * 100) / 100;
    if (maxRiskPerOrder != null && risk > maxRiskPerOrder) throw new Error(`Refused: this order risks $${risk}, over the limit of $${maxRiskPerOrder} per order (TRADIER_MAX_RISK_PER_ORDER).`);
  }

  /** The bid and ask of each leg. TODO(unconfirmed): the response shape of GET /markets/quotes for index option
   * symbols (a single quote comes back as an object, several as a list), and that the sandbox serves them (its
   * option data is delayed). Missing or unusable answers return null and the engine falls back to one price. */
  async getSpreadQuote(req: SpreadQuoteRequest): Promise<LegQuotes | null> {
    const { short, long } = this.legs({ root: req.optionRoot, underlying: req.underlying, expiry: req.expiry, type: req.type, shortStrike: req.shortStrike, longStrike: req.longStrike });
    const json = await this.market("/markets/quotes", { symbols: `${short},${long}` });
    const raw = (json.quotes as { quote?: unknown } | undefined)?.quote;
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as { symbol?: string; bid?: unknown; ask?: unknown }[];
    const pick = (symbol: string) => {
      const q = list.find((x) => x.symbol === symbol);
      const bid = q?.bid == null ? NaN : Number(q.bid);
      const ask = q?.ask == null ? NaN : Number(q.ask);
      return Number.isFinite(bid) && Number.isFinite(ask) ? { bid, ask } : null;
    };
    const s = pick(short);
    const l = pick(long);
    return s && l ? { short: s, long: l } : null;
  }

  /** Closing: buy back the short, sell the long. With a limit debit from the SmartPricing ladder it is a
   * debit order at that price; with none it is a market multileg order.
   * TODO(unconfirmed): that the sandbox/production accept type=market for a multileg index spread. */
  async placeCloseOrder(position: Position, options?: { pricePercent?: number; limitDebit?: number }): Promise<{ ref: string }> {
    const { underlying, short, long } = this.legs({ root: position.optionRoot, underlying: position.underlying, expiry: position.expiry, type: position.type, shortStrike: position.shortStrike, longStrike: position.longStrike });
    const quantity = String(position.filledQuantity || position.requestedQuantity);
    return this.submit({
      class: "multileg",
      symbol: underlying,
      type: options?.limitDebit !== undefined ? "debit" : "market",
      duration: "day",
      ...(options?.limitDebit !== undefined ? { price: String(options.limitDebit) } : {}),
      "option_symbol[0]": short,
      "side[0]": "buy_to_close",
      "quantity[0]": quantity,
      "option_symbol[1]": long,
      "side[1]": "sell_to_close",
      "quantity[1]": quantity,
    });
  }

  async getOrder(ref: string): Promise<OrderState> {
    const json = await this.call("GET", `/orders/${encodeURIComponent(ref)}`);
    const order = json.order as Record<string, unknown> | undefined;
    if (!order) throw new Error(`Tradier returned no order for ${ref}.`);
    return mapTradierOrder(order);
  }

  async cancelOrder(ref: string): Promise<void> {
    await this.call("DELETE", `/orders/${encodeURIComponent(ref)}`);
  }

  /** The account's balances. TODO(unconfirmed): the field names under `balances` (total_equity, total_cash,
   * margin.option_buying_power / cash.* by account type) are from memory of Tradier's docs. Anything missing is null. */
  async getBalances(): Promise<BrokerBalances> {
    const json = await this.call("GET", "/balances");
    const b = (json.balances ?? {}) as Record<string, unknown> & { margin?: Record<string, unknown>; cash?: Record<string, unknown>; pdt?: Record<string, unknown> };
    const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      accountId: this.config.accountId,
      totalEquity: num(b.total_equity),
      optionBuyingPower: num(b.margin?.option_buying_power ?? b.cash?.cash_available ?? b.option_buying_power),
      cash: num(b.total_cash),
    };
  }

  /** What Tradier itself holds. TODO(unconfirmed): the response shape - Tradier answers `"null"` when there are
   * none, an object for one position and a list for several. */
  async listBrokerPositions(): Promise<BrokerPosition[]> {
    const json = await this.call("GET", "/positions");
    const raw = json.positions as { position?: unknown } | string | null | undefined;
    if (!raw || typeof raw === "string") return [];
    const list = (Array.isArray(raw.position) ? raw.position : raw.position ? [raw.position] : []) as { symbol?: string; quantity?: unknown }[];
    return list.filter((p) => typeof p.symbol === "string").map((p) => ({ symbol: p.symbol!, quantity: Number(p.quantity ?? 0) }));
  }

  /** Our own rows for this bot. TODO(unconfirmed): reconciling against Tradier's
   * account positions - they aren't labelled by bot, so they can't be matched
   * to a bot without the order ids we already store. */
  async listPositions(botId: string): Promise<Position[]> {
    return positionsStore.query((p) => p.botId === botId);
  }
}
