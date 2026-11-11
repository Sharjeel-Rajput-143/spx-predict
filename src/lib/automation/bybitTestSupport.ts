// A fake Bybit demo exchange for tests, in memory. No network, and no real key exists. It checks the signature the way Bybit does, enforces reduce only,
// fills a market order at once at `price`, keeps one one-way position with its stop loss and take profit, closes it by itself when the price crosses one
// (an order with stopOrderType StopLoss or TakeProfit, as Bybit lists it), and can be told to fail, to lose an answer, or to drop the stops.
import crypto from "node:crypto";
import type { BybitFetch } from "./bybitExecutor";

export const API_KEY = "bybit-key-VALUE-1234";
export const API_SECRET = "bybit-secret-VALUE-5678";

export interface FakeCall {
  method: string;
  path: string;
  /** The query (GET) or the JSON body (POST), as sent. */
  params: Record<string, unknown>;
  headers: Record<string, string>;
  url: string;
}

export interface FakeOrder {
  orderId: string;
  orderLinkId: string;
  side: "Buy" | "Sell";
  qty: number;
  reduceOnly: boolean;
  orderStatus: string;
  cumExecQty: number;
  avgPrice: number;
  rejectReason: string;
  stopOrderType: string;
  createType: string;
  createdTime: number;
  updatedTime: number;
}

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const ok = (result: unknown) => reply(200, { retCode: 0, retMsg: "OK", result, retExtInfo: {}, time: 0 });
const refuse = (retCode: number, retMsg: string) => reply(200, { retCode, retMsg, result: {}, retExtInfo: {}, time: 0 });

export class FakeBybit {
  calls: FakeCall[] = [];
  /** The market price an order fills at, and the mark price. */
  price = 76_000;
  /** What the account holds: a signed size (long positive, short negative), its average entry, and the stops set on it (0 = none). */
  position = { size: 0, avg: 0, stopLoss: 0, takeProfit: 0 };
  orders = new Map<string, FakeOrder>();
  /** The account's margin mode and leverage, as a real account has them (a new account starts on cross margin). Used by the live side's checks. */
  account = {
    marginMode: "REGULAR_MARGIN",
    leverage: 10,
    refuseMarginSwitch: false,
    refuseLeverage: false,
    /** How the position record shows the leverage: "string" is what Bybit sends ("10"); the others are the cases a flat account may come back with. */
    leverageStyle: "string" as "string" | "number" | "missing" | "empty" | "zero",
    /** The position list comes back with no row at all while the account is flat. */
    noRowWhenFlat: false,
  };
  /** What /v5/user/query-api says about the key: its permissions, whether it is read only, and the IPs it is limited to. */
  keyInfo: { readOnly: number; ips: string[]; permissions: Record<string, string[]> } = {
    readOnly: 0,
    ips: ["203.0.113.5"],
    permissions: { ContractTrade: ["Order", "Position"], Spot: [], Wallet: [], Options: [], Derivatives: [], CopyTrading: [], BlockTrade: [], Exchange: [], NFT: [], Affiliate: [] },
  };
  closedPnl: { orderId: string; closedPnl: string; side?: string; qty?: string; closedSize?: string; leverage?: string; cumEntryValue?: string; cumExitValue?: string; avgEntryPrice?: string; avgExitPrice?: string; openFee?: string; closeFee?: string; updatedTime?: string; createdTime?: string }[] = [];
  /** Per path: how the next call fails. "lose" runs the call but throws instead of answering (a lost answer); "timeout" throws without running it. */
  failures = new Map<string, { kind: "timeout" | "lose" | "http" | "ret"; status?: number; code?: number; msg?: string; times: number }>();
  /** Per path: the whole answer, replacing the fake's own. */
  overrides = new Map<string, () => ReturnType<typeof reply>>();
  /** When false, the closed-pnl endpoint is "not supported" on this account, as it may be on the demo. */
  closedPnlSupported = true;
  /** The account's equity and available balance, as Bybit reports them ("0" = an empty demo account). */
  equity = "50000.12";
  /** When true, an entry comes back WITHOUT its stop loss and take profit (Bybit ignored them), as a test of the fallback. */
  dropStops = false;
  /** The next N reads of the order history do not list the orders Bybit itself placed for a stop (Bybit's history lags the position by about a second). */
  historyLag = 0;
  /** When set, an entry comes back with only the OTHER stop (this one is dropped). */
  dropOnly: "stopLoss" | "takeProfit" | null = null;
  /** When false, an order Bybit places for a stop is not flagged reduce-only (only its stopOrderType says what it is). */
  stopReduceOnly = true;
  /** When true, /v5/position/trading-stop is refused. */
  tradingStopFails = false;
  /** The fake's clock, for order times (a test points it at its own). */
  clock: () => number = Date.now;
  /** Runs right after an order is created, so a test can change what Bybit did with it (reject it, drop the position...). */
  onCreated?: (order: FakeOrder) => void;
  /** When true, every call fails the way a cut network does ("fetch failed"), whatever the path. */
  down = false;
  /** An entry fills this many dollars away from the price (against the buyer), so the stop worked out from the mark price is off from the real fill. */
  fillSlip = 0;
  /** The fraction of an entry order that fills (1 = all). */
  fillFraction = 1;
  /** When true, the position list reports Bybit's "Partial" TP/SL mode (the stop covers only part of the position). */
  partialMode = false;
  /** Entries that ended with a position held and no stop loss on it (counted when the order is created, before anyone repairs it). */
  unprotectedMoments = 0;
  private seq = 1000;

  /** Make the account hold something before the bot starts (a person's own trade). */
  hold(size: number, avg = this.price): void {
    this.position = { size, avg, stopLoss: 0, takeProfit: 0 };
  }

  /** What a person does by hand at Bybit: the stop loss is removed from the position. */
  deleteStop(): void {
    this.position.stopLoss = 0;
  }

  fail(path: string, f: { kind: "timeout" | "lose" | "http" | "ret"; status?: number; code?: number; msg?: string; times?: number }): void {
    this.failures.set(path, { times: 1, ...f });
  }

  of(path: string, method?: string): FakeCall[] {
    return this.calls.filter((c) => c.path === path && (method === undefined || c.method === method));
  }

  /** The orders that were sent to create. */
  get created(): FakeCall[] {
    return this.of("/v5/order/create");
  }

  /** The market moves. If it crosses the stop loss or the take profit of the position, Bybit closes the position at once, as its own order. */
  movePrice(to: number): "StopLoss" | "TakeProfit" | null {
    this.price = to;
    const { size, stopLoss, takeProfit } = this.position;
    if (size === 0) return null;
    const long = size > 0;
    const hitSl = stopLoss > 0 && (long ? to <= stopLoss : to >= stopLoss);
    const hitTp = takeProfit > 0 && (long ? to >= takeProfit : to <= takeProfit);
    if (!hitSl && !hitTp) return null;
    const kind = hitSl ? "StopLoss" : "TakeProfit";
    const orderId = String(++this.seq);
    const now = this.clock();
    const order: FakeOrder = { orderId, orderLinkId: "", side: long ? "Sell" : "Buy", qty: Math.abs(size), reduceOnly: this.stopReduceOnly, orderStatus: "Filled", cumExecQty: Math.abs(size), avgPrice: to, rejectReason: "EC_NoError", stopOrderType: kind, createType: `CreateBy${kind}`, createdTime: now, updatedTime: now };
    this.orders.set(orderId, order);
    this.apply(order, long ? -Math.abs(size) : Math.abs(size));
    return kind;
  }

  fetch: BybitFetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const isPost = init.method === "POST";
    const params: Record<string, unknown> = isPost ? JSON.parse(init.body ?? "{}") : Object.fromEntries(u.searchParams.entries());
    this.calls.push({ method: init.method, path, params, headers: init.headers, url });

    if (this.down) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    const isPublic = path.startsWith("/v5/market/");
    if (!isPublic) {
      const h = init.headers;
      if (h["X-BAPI-API-KEY"] !== API_KEY) return refuse(10003, "API key is invalid.");
      const payload = isPost ? (init.body ?? "") : u.search.replace(/^\?/, "");
      const expected = crypto.createHmac("sha256", API_SECRET).update(`${h["X-BAPI-TIMESTAMP"]}${API_KEY}${h["X-BAPI-RECV-WINDOW"]}${payload}`).digest("hex");
      if (h["X-BAPI-SIGN"] !== expected) return refuse(10004, "error sign!");
    }

    const f = this.failures.get(path);
    if (f && f.times > 0) {
      f.times--;
      if (f.kind === "timeout") throw new Error("The operation was aborted due to timeout");
      if (f.kind === "http") return reply(f.status ?? 500, f.msg ?? "server error");
      if (f.kind === "ret") return refuse(f.code ?? 10016, f.msg ?? "Server Error");
      // "lose": run the call below, then throw instead of answering.
      this.route(path, params);
      throw new Error("The operation was aborted due to timeout");
    }
    const over = this.overrides.get(path);
    if (over) return over();
    return this.route(path, params);
  };

  private route(path: string, params: Record<string, unknown>): ReturnType<typeof reply> {
    switch (path) {
      case "/v5/order/create":
        return this.create(params);
      case "/v5/order/cancel":
        return refuse(110001, "Order does not exist");
      case "/v5/order/realtime":
        return this.query(params);
      case "/v5/order/history": {
        const lagging = this.historyLag > 0;
        if (lagging) this.historyLag--;
        return this.query(params, lagging);
      }
      case "/v5/position/list":
        return ok({ category: "linear", list: this.account.noRowWhenFlat && this.position.size === 0 ? [] : [this.positionRow()] });
      case "/v5/position/trading-stop":
        return this.tradingStop(params);
      case "/v5/user/query-api":
        return ok({ id: "1", note: "test", apiKey: "k", readOnly: this.keyInfo.readOnly, permissions: this.keyInfo.permissions, ips: this.keyInfo.ips, type: 1, deadlineDay: -1 });
      case "/v5/account/info":
        return ok({ marginMode: this.account.marginMode, unifiedMarginStatus: 4, isMasterTrader: false, spotHedgingStatus: "OFF" });
      case "/v5/account/set-margin-mode": {
        if (this.account.refuseMarginSwitch) return ok({ reasons: [{ reasonCode: "100028", reasonMsg: "the account is not allowed to change margin mode" }] });
        const mode = String(params.setMarginMode ?? "");
        if (mode !== "ISOLATED_MARGIN" && mode !== "REGULAR_MARGIN" && mode !== "PORTFOLIO_MARGIN") return refuse(10001, "invalid margin mode");
        this.account.marginMode = mode;
        return ok({ reasons: [] });
      }
      case "/v5/position/set-leverage": {
        if (this.account.refuseLeverage) return refuse(110026, "cross/isolated margin mode is not modified");
        const buy = Number(params.buyLeverage);
        const sell = Number(params.sellLeverage);
        if (!(buy > 0) || buy !== sell) return refuse(10001, "invalid leverage");
        if (buy === this.account.leverage) return refuse(110043, "Set leverage not modified");
        this.account.leverage = buy;
        return ok({});
      }
      case "/v5/position/closed-pnl":
        return this.closedPnlSupported ? ok({ category: "linear", list: this.closedPnl }) : refuse(10001, "This endpoint is not supported on demo trading.");
      case "/v5/market/time":
        return ok({ timeSecond: String(Math.floor(Date.now() / 1000)), timeNano: String(BigInt(Date.now()) * 1000000n) });
      case "/v5/market/instruments-info":
        return ok({ category: "linear", list: [{ symbol: "BTCUSDT", priceFilter: { tickSize: "0.10" }, lotSizeFilter: { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5", maxMktOrderQty: "150" } }] });
      case "/v5/market/tickers":
        return ok({ category: "linear", list: [{ symbol: "BTCUSDT", lastPrice: String(this.price), markPrice: String(this.price) }] });
      case "/v5/execution/list":
        return ok({ category: "linear", list: [...this.orders.values()].map((o) => ({ orderId: o.orderId, execQty: String(o.cumExecQty), execPrice: String(o.avgPrice), execFee: "0.04" })) });
      case "/v5/account/wallet-balance":
        return ok({ list: [{ accountType: "UNIFIED", totalEquity: this.equity, totalAvailableBalance: this.equity }] });
      default:
        return reply(404, "not found");
    }
  }

  private positionRow() {
    const { size, avg, stopLoss, takeProfit } = this.position;
    const pnl = size === 0 ? 0 : (this.price - avg) * size;
    return {
      symbol: "BTCUSDT",
      side: size > 0 ? "Buy" : size < 0 ? "Sell" : "",
      size: String(Math.abs(size)),
      avgPrice: size === 0 ? "0" : String(avg),
      markPrice: String(this.price),
      unrealisedPnl: size === 0 ? "0" : pnl.toFixed(4),
      stopLoss: stopLoss > 0 ? String(stopLoss) : "",
      takeProfit: takeProfit > 0 ? String(takeProfit) : "",
      // As at Bybit: tradeMode is deprecated and ALWAYS 0, whatever the margin mode is (the margin mode is only in /v5/account/info).
      tradeMode: 0,
      ...this.leverageField(),
      positionIdx: 0,
      tpslMode: this.partialMode ? "Partial" : "Full",
    };
  }

  private leverageField(): Record<string, unknown> {
    const n = this.account.leverage;
    switch (this.account.leverageStyle) {
      case "number":
        return { leverage: n };
      case "missing":
        return {};
      case "empty":
        return { leverage: "" };
      case "zero":
        return { leverage: "0" };
      default:
        return { leverage: String(n) };
    }
  }

  private tradingStop(p: Record<string, unknown>): ReturnType<typeof reply> {
    if (this.tradingStopFails) return refuse(34036, "trading stop is not allowed");
    if (this.position.size === 0) return refuse(10001, "position is empty");
    // As at Bybit: a field that is not sent stays as it was ("0" would cancel it), and a stop on the wrong side of the price is refused.
    const long = this.position.size > 0;
    if (p.stopLoss !== undefined) {
      const sl = Number(p.stopLoss) || 0;
      if (sl > 0 && (long ? sl >= this.price : sl <= this.price)) return refuse(10001, "StopLoss:" + sl + " set for " + (long ? "Buy" : "Sell") + " position should " + (long ? "lower" : "higher") + " than base_price");
      this.position.stopLoss = sl;
    }
    if (p.takeProfit !== undefined) this.position.takeProfit = Number(p.takeProfit) || 0;
    return ok({});
  }

  private create(p: Record<string, unknown>): ReturnType<typeof reply> {
    if (p.category !== "linear" || p.orderType !== "Market" || typeof p.symbol !== "string") return refuse(10001, "params error");
    const side = p.side as "Buy" | "Sell";
    if (side !== "Buy" && side !== "Sell") return refuse(10001, "side invalid");
    const qty = Number(p.qty);
    if (!(qty >= 0.001)) return refuse(10001, "Qty invalid");
    const linkId = String(p.orderLinkId ?? "");
    if ([...this.orders.values()].some((o) => o.orderLinkId === linkId)) return refuse(110072, "OrderLinkedID is duplicate");
    const reduceOnly = p.reduceOnly === true;
    // An entry may fill only in part, and away from the price (see fillFraction and fillSlip); a close fills in full at the price.
    const filled = reduceOnly ? qty : qty * this.fillFraction;
    const signed = side === "Buy" ? filled : -filled;
    const fillPrice = reduceOnly ? this.price : this.price + (side === "Buy" ? this.fillSlip : -this.fillSlip);
    if (reduceOnly) {
      const { size } = this.position;
      if (size === 0 || Math.sign(size) === Math.sign(signed) || Math.abs(signed) > Math.abs(size) + 1e-12) {
        return refuse(110017, "Reduce-only rule not satisfied");
      }
    }
    const sl = p.stopLoss !== undefined ? Number(p.stopLoss) : 0;
    const tp = p.takeProfit !== undefined ? Number(p.takeProfit) : 0;
    // Bybit refuses a stop on the wrong side of the market.
    if (!reduceOnly && sl > 0 && (side === "Buy" ? sl >= this.price : sl <= this.price)) return refuse(10001, "StopLoss:" + sl + " set for Buy position should lower than base_price");
    if (!reduceOnly && tp > 0 && (side === "Buy" ? tp <= this.price : tp >= this.price)) return refuse(10001, "TakeProfit:" + tp + " set for Buy position should greater than base_price");
    const orderId = String(++this.seq);
    const now = this.clock();
    const order: FakeOrder = { orderId, orderLinkId: linkId, side, qty, reduceOnly, orderStatus: "Filled", cumExecQty: filled, avgPrice: fillPrice, rejectReason: "EC_NoError", stopOrderType: "", createType: "CreateByUser", createdTime: now, updatedTime: now };
    this.orders.set(orderId, order);
    this.apply(order, signed);
    if (!reduceOnly && !this.dropStops) {
      this.position.stopLoss = this.dropOnly === "stopLoss" ? 0 : sl;
      this.position.takeProfit = this.dropOnly === "takeProfit" ? 0 : tp;
    }
    if (!reduceOnly && this.position.size !== 0 && this.position.stopLoss === 0) this.unprotectedMoments++;
    this.onCreated?.(order);
    return ok({ orderId, orderLinkId: linkId });
  }

  private apply(order: FakeOrder, signed: number): void {
    const { size, avg } = this.position;
    const next = size + signed;
    if (size !== 0 && Math.sign(size) !== Math.sign(signed)) {
      // reducing: realise the profit on the part closed
      const closed = Math.min(Math.abs(size), Math.abs(signed));
      const exit = order.avgPrice;
      const pnl = (exit - avg) * closed * Math.sign(size) - exit * closed * 0.00055 - avg * closed * 0.00055;
      this.closedPnl.unshift({ orderId: order.orderId, closedPnl: pnl.toFixed(4), side: order.side, qty: String(closed), closedSize: String(closed), avgEntryPrice: String(avg), avgExitPrice: String(exit), leverage: "10", cumEntryValue: String(avg * closed), cumExitValue: String(exit * closed), openFee: (avg * closed * 0.00055).toFixed(6), closeFee: (exit * closed * 0.00055).toFixed(6), updatedTime: String(order.updatedTime), createdTime: String(order.createdTime) });
      const flat = Math.abs(next) < 1e-12;
      this.position = { size: flat ? 0 : next, avg, stopLoss: flat ? 0 : this.position.stopLoss, takeProfit: flat ? 0 : this.position.takeProfit };
    } else {
      this.position = { size: next, avg: size === 0 ? order.avgPrice : (avg * Math.abs(size) + order.avgPrice * Math.abs(signed)) / Math.abs(next), stopLoss: 0, takeProfit: 0 };
    }
  }

  private query(p: Record<string, unknown>, hideStops = false): ReturnType<typeof reply> {
    const limit = p.limit ? Number(p.limit) : 500;
    const list = [...this.orders.values()]
      .filter((o) => (p.orderId ? o.orderId === p.orderId : p.orderLinkId ? o.orderLinkId === p.orderLinkId : true))
      .filter((o) => !(hideStops && o.stopOrderType))
      .sort((a, b) => Number(b.orderId) - Number(a.orderId))
      .slice(0, limit);
    return ok({
      category: "linear",
      list: list.map((o) => ({
        orderId: o.orderId,
        orderLinkId: o.orderLinkId,
        side: o.side,
        orderStatus: o.orderStatus,
        orderType: "Market",
        cumExecQty: String(o.cumExecQty),
        avgPrice: String(o.avgPrice),
        rejectReason: o.rejectReason,
        qty: String(o.qty),
        reduceOnly: o.reduceOnly,
        stopOrderType: o.stopOrderType,
        createType: o.createType,
        createdTime: String(o.createdTime),
        updatedTime: String(o.updatedTime),
      })),
    });
  }
}
