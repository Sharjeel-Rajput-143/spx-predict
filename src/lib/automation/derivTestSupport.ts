// A fake Deriv for tests: the REST sign-in and the WebSocket, in memory. No network, and no real token exists.
import type { DerivFetch, DerivSocket } from "./derivExecutor";

// A fake Deriv: the REST sign-in and the WebSocket, in memory. Nothing here touches a network, and no real token exists.
export const TOKEN = "pat-secret-VALUE-1234";
export const APP_ID = "app-id-VALUE-5678";
export const ACCOUNT = "VRTC1234567";
export const DEMO_URL = "wss://api.derivws.com/trading/v1/options/ws/demo?otp=otp-1";
export const REAL_URL = "wss://api.derivws.com/trading/v1/options/ws/real?otp=otp-1";

type Handler = (req: Record<string, unknown>) => Record<string, unknown>;

export class FakeDeriv {
  restCalls: { url: string; method: string; headers: Record<string, string> }[] = [];
  sent: Record<string, unknown>[] = [];
  opened: string[] = [];
  closedCount = 0;
  otpStatus = 200;
  otpBody: unknown = null; // overrides the answer
  otpUrl = DEMO_URL;
  usedOtps = new Set<string>();
  silent = new Set<string>(); // calls that never get an answer
  /** Contracts the fake account holds: id -> state */
  contracts = new Map<number, { buy: number; sold: boolean; sale: number; valid: boolean; error?: string; /** an expired contract: Deriv's own status and profit for it */ settled?: { status: "won" | "lost"; profit: number } }>();
  nextContract = 987654321;
  proposalAsk = 10;
  handlers: Record<string, Handler> = {};
  otpSeq = 0;

  fetch: DerivFetch = async (url, init) => {
    this.restCalls.push({ url, method: init.method, headers: init.headers });
    if (init.headers["Authorization"] !== `Bearer ${TOKEN}`) return reply(401, { errors: [{ status: 401, code: "InvalidToken", message: "The token is not valid" }] });
    if (!init.headers["Deriv-App-ID"]) return reply(401, { errors: [{ status: 401, code: "AppIdRequired", message: "Deriv-App-ID header is required for PAT tokens" }] });
    if (this.otpStatus !== 200) return reply(this.otpStatus, this.otpBody ?? { errors: [{ status: this.otpStatus, code: "ServerError", message: "Try later" }] });
    if (this.otpBody) return reply(200, this.otpBody);
    this.otpSeq++;
    return reply(200, { data: { url: this.otpUrl.replace(/otp=[^&]+/, `otp=otp-${this.otpSeq}`) } });
  };

  socketFactory = (url: string): DerivSocket => {
    this.opened.push(url);
    const otp = /otp=([^&]+)/.exec(url)?.[1];
    const sock: DerivSocket = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: (data: string) => {
        const req = JSON.parse(data) as Record<string, unknown>;
        this.sent.push(req);
        const call = Object.keys(req).find((k) => !["req_id", "passthrough"].includes(k) && this.handlers[k] !== undefined || this.known.includes(k)) ?? "";
        if (this.silent.has(call)) return;
        const body = (this.handlers[call] ?? this.defaultFor(call))(req);
        setTimeout(() => sock.onmessage?.({ data: JSON.stringify({ ...body, echo_req: req, msg_type: call, req_id: req.req_id }) }), 0);
      },
      close: () => {
        this.closedCount++;
      },
    };
    setTimeout(() => {
      if (otp && url.includes("/ws/") && !url.endsWith("/public") && !url.includes("/public")) {
        if (this.usedOtps.has(otp)) return sock.onerror?.({});
        this.usedOtps.add(otp);
      }
      sock.onopen?.({});
    }, 0);
    return sock;
  };

  known = ["ping", "proposal", "buy", "sell", "proposal_open_contract", "active_symbols", "ticks_history"];

  defaultFor(call: string): Handler {
    switch (call) {
      case "ping":
        return () => ({ ping: "pong" });
      case "ticks_history":
        return () => ({ history: { prices: [29284.55], times: [1793044542] }, pip_size: 2 });
      case "active_symbols":
        return (req) => ({ active_symbols: (req.contract_type as string[]).some((t) => t.startsWith("MULT")) ? [{ underlying_symbol: "R_100" }] : [{ underlying_symbol: "OTC_NDX" }, { underlying_symbol: "R_100" }] });
      case "proposal":
        return (req) => ({ proposal: { id: "prop-1", ask_price: this.proposalAsk, spot: 29290.1, payout: 18.15, date_start: 1793044600, longcode: `${String(req.contract_type)} on US Tech 100`, spot_time: 1793044599 } });
      case "buy":
        return (req) => {
          const id = this.nextContract++;
          const buy = Number(this.sent.filter((r) => r.proposal === 1).at(-1)?.amount ?? this.proposalAsk);
          this.contracts.set(id, { buy, sold: false, sale: 0, valid: true });
          return { buy: { contract_id: id, buy_price: buy, balance_after: 9990, transaction_id: 5550001, longcode: "Win payout if US Tech 100 is higher", start_time: 1793044601, purchase_time: 1793044601, shortcode: "CALL_OTC_NDX", payout: 18.15 }, echo: req.price };
        };
      case "proposal_open_contract":
        return (req) => {
          const c = this.contracts.get(Number(req.contract_id));
          if (!c) return { error: { code: "ContractNotFound", message: "Contract not found." } };
          if (c.settled) return { proposal_open_contract: { contract_id: Number(req.contract_id), is_sold: 1, is_expired: 1, is_valid_to_sell: 0, buy_price: String(c.buy), sell_price: String(c.buy + c.settled.profit), status: c.settled.status, profit: String(c.settled.profit) } };
          return { proposal_open_contract: { contract_id: Number(req.contract_id), is_sold: c.sold ? 1 : 0, is_valid_to_sell: c.valid && !c.sold ? 1 : 0, buy_price: String(c.buy), sell_price: c.sold ? String(c.sale) : null, bid_price: String(c.sale || c.buy), status: c.sold ? "sold" : "open", ...(c.sold ? { profit: String(Math.round((c.sale - c.buy) * 100) / 100) } : {}), ...(c.error ? { validation_error: c.error } : {}) } };
        };
      case "sell":
        return (req) => {
          const c = this.contracts.get(Number(req.sell));
          if (!c) return { error: { code: "ContractNotFound", message: "Contract not found." } };
          if (!c.valid) return { error: { code: "SellRefused", message: "This contract cannot be sold." } };
          c.sold = true;
          c.sale = this.saleValue ?? c.buy;
          return { sell: { sold_for: c.sale, contract_id: Number(req.sell), balance_after: 10005, reference_id: 1, transaction_id: 5550002 } };
        };
      default:
        return () => ({ error: { code: "UnrecognisedRequest", message: "unknown call" } });
    }
  }
  saleValue: number | null = null;
  calls = (name: string) => this.sent.filter((r) => name in r);
}

export const reply = (status: number, json: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(json) });

