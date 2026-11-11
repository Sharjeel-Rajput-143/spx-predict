import "server-only";
import { BybitApiError, BybitConfigError, BybitExecutor, readBybitConfig, type BybitConfig, type BybitFetch } from "./bybitExecutor";
import { dailyLimitBlock } from "./bybitDay";
import { DEMO_ENV, ISOLATED_MARGIN, LIVE_API_BASE, LIVE_ENV, LIVE_LIMITS, LIVE_ORDER_PREFIX, STAGE_LEVERAGE, clampDailyLoss, type LiveStage } from "./bybitLiveLimits";
import { OrderNotPlacedError } from "./orderErrors";
import type { OpenSpreadRequest, Position } from "./types";

/**
 * THE LIVE BYBIT EXECUTOR (real money, OFF by default). It is the demo executor with these differences, and nothing else:
 *   - it can reach https://api.bybit.com only (the demo executor can reach the demo host only: see assertHost);
 *   - its own key (BYBIT_LIVE_API_KEY / BYBIT_LIVE_API_SECRET), never the demo one, and never the same one;
 *   - hard ceilings written in bybitLiveLimits.ts: 0.001 BTC per order, a daily loss limit that cannot be set above $3, 5 trades a day, one position at a time;
 *   - before EVERY entry it asks Bybit what the key may do (withdraw or transfer rights = refused, and the switch goes OFF), puts the account on isolated margin and the
 *     stage's leverage ITSELF, reads both back, and refuses if either is not what it set (cross margin is never accepted);
 *   - it sends nothing while the live switch is OFF (a close is never held back: a position it holds can always be closed);
 *   - a STOP LOSS ALARM, a tripped daily cap or a failed check turns the switch OFF.
 * The stop rules (hard rule, 5 s cap, 1.5 s watchdog) are the demo executor's, unchanged: this class inherits them.
 */

/** Everything the live executor needs to know about the live switch and the day. The app wires the real records in; tests wire their own. */
export interface LiveGuard {
  /** The "Live enabled" switch. */
  switchOn(): boolean;
  stage(): LiveStage;
  /** The daily loss limit chosen (the executor clamps it to the ceiling again). */
  dailyLossUsd(): number;
  /** Live positions opened so far in the current New York day. */
  tradesToday(now: number): number;
  /** The executor has decided live must switch itself off (and why). */
  onAutoOff?(reason: string): void;
}

export type LivePreflight = {
  ok: boolean;
  /** Why not: definite findings (rights the key must not have, cross margin, a leverage that would not stick). The switch goes OFF for these. */
  problems: string[];
  /** Not a block: shown in red on the page (no IP restriction on the key). */
  warnings: string[];
  /** Bybit could not be read: this entry is refused, but nothing is wrong that needs the switch turned off. */
  unreadable?: string;
  marginMode?: string;
  leverage?: number;
};

/** Reads the live settings. Throws a BybitConfigError naming what is missing (never a value). The demo key is never read here. */
export function readLiveConfig(env: Record<string, string | undefined> = process.env): BybitConfig {
  const get = (n: string) => (env[n] ?? "").trim();
  const missing = [LIVE_ENV.key, LIVE_ENV.secret].filter((n) => !get(n));
  if (missing.length > 0) throw new BybitConfigError(`The live bot will not trade until these are set in .env.local: ${missing.join(", ")} (a key made for live trading with trade permission only, no withdrawal rights).`);
  if (get(LIVE_ENV.key) === get(DEMO_ENV.key) || get(LIVE_ENV.secret) === get(DEMO_ENV.secret)) throw new BybitConfigError("The live key must not be the demo key: use the key made on the real Bybit account.");
  const rawQty = get("BYBIT_LIVE_POSITION_SIZE");
  const qty = rawQty ? Number(rawQty) : LIVE_LIMITS.maxQty;
  if (!Number.isFinite(qty) || qty <= 0 || qty > LIVE_LIMITS.maxQty) throw new BybitConfigError(`BYBIT_LIVE_POSITION_SIZE must be above 0 and at most ${LIVE_LIMITS.maxQty} BTC (a ceiling written in the code), got "${rawQty}".`);
  // Everything else (stop and take profit percentages, breakeven, hours, timeouts) is read by the same rules as the demo bot, from the same settings.
  const base = readBybitConfig({ ...env, BYBIT_DEMO_API_KEY: get(LIVE_ENV.key), BYBIT_DEMO_API_SECRET: get(LIVE_ENV.secret), BYBIT_API_BASE: "", POSITION_SIZE: String(qty), DAILY_MAX_LOSS_USD: String(LIVE_LIMITS.dailyLossCeilingUsd) });
  return { ...base, apiBase: LIVE_API_BASE, symbol: "BTCUSDT", qty, dailyMaxLossUsd: LIVE_LIMITS.dailyLossCeilingUsd };
}

type Api = (method: "GET" | "POST", path: string, params?: Record<string, string | number | boolean>) => Promise<Record<string, unknown>>;

/** True for a permission name or category that means moving money out or between accounts. */
const MONEY_MOVING = /withdraw|transfer/i;

/** What the key may do. Returns the definite problems and the warnings. */
export function judgeKey(info: Record<string, unknown>): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (Number(info.readOnly) === 1) problems.push("The live key is read only, so it cannot trade.");
  const permissions = (info.permissions && typeof info.permissions === "object" ? info.permissions : {}) as Record<string, unknown>;
  const money: string[] = [];
  for (const [category, list] of Object.entries(permissions)) {
    const names = Array.isArray(list) ? list.map(String) : [];
    if (MONEY_MOVING.test(category) && names.length > 0) money.push(`${category}: ${names.join(", ")}`);
    for (const n of names) if (MONEY_MOVING.test(n)) money.push(`${category}: ${n}`);
  }
  if (money.length > 0) problems.push(`The live key has rights that can move money (${[...new Set(money)].join("; ")}). Make a new key with trade permission only. The bot will not run with this one.`);
  const trade = permissions.ContractTrade;
  if (!Array.isArray(trade) || !trade.map(String).includes("Order") || !trade.map(String).includes("Position")) problems.push("The live key lacks contract trading rights (Order and Position).");
  const ips = Array.isArray(info.ips) ? info.ips.map(String).filter(Boolean) : [];
  if (ips.length === 0 || ips.includes("*") || ips.includes("0.0.0.0/0")) warnings.push("The live key has no IP restriction: anyone who gets the key could use it from anywhere. Add this Mac's IP to the key at Bybit.");
  return { problems, warnings };
}

/** One leverage field as a number, or NaN when it is not usable: a string ("10", "10.00") or a number is fine; missing, empty, zero, negative or not a number is not. */
export function parseLeverage(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : NaN;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : NaN;
  }
  return NaN;
}

/** The leverage the position records show: NaN when none shows a usable one; when rows disagree, a value that is NOT the target (so a wrong one is never hidden behind a right one). */
export function leverageFromRows(rows: Record<string, unknown>[], target: number): number {
  const seen = rows.map((r) => parseLeverage(r.leverage)).filter((n) => Number.isFinite(n));
  if (seen.length === 0) return NaN;
  return seen.find((n) => n !== target) ?? seen[0];
}

const rowsOf = (result: Record<string, unknown>): Record<string, unknown>[] => (Array.isArray(result.list) ? (result.list as Record<string, unknown>[]) : []);

/**
 * The checks before an entry, and the two settings the code makes itself: isolated margin and the stage's leverage. It reads them back and trusts only what it reads.
 * Never changes anything while the account holds a position (it then only checks).
 */
export async function livePreflight(api: Api, opts: { stage: LiveStage; symbol: string }): Promise<LivePreflight> {
  const target = STAGE_LEVERAGE[opts.stage];
  const out: LivePreflight = { ok: false, problems: [], warnings: [] };
  try {
    // 1. The key.
    const info = await api("GET", "/v5/user/query-api");
    const judged = judgeKey(info);
    out.problems.push(...judged.problems);
    out.warnings.push(...judged.warnings);
    if (out.problems.length > 0) return out; // do not touch the account's settings with a key that must not be used
    // 2. Isolated margin.
    const position = async () => rowsOf(await api("GET", "/v5/position/list", { category: "linear", symbol: opts.symbol }));
    const held = (await position()).some((r) => Number(r.size) > 0);
    let mode = String((await api("GET", "/v5/account/info")).marginMode ?? "");
    if (mode !== ISOLATED_MARGIN && !held) {
      const res = await api("POST", "/v5/account/set-margin-mode", { setMarginMode: ISOLATED_MARGIN });
      const reasons = Array.isArray(res.reasons) ? res.reasons : [];
      if (reasons.length > 0) out.problems.push(`Bybit would not switch the account to isolated margin (${reasons.map((r) => String((r as { reasonMsg?: string }).reasonMsg ?? "no reason given")).join("; ")}). Cross margin is never accepted.`);
      mode = String((await api("GET", "/v5/account/info")).marginMode ?? "");
    }
    out.marginMode = mode;
    if (mode !== ISOLATED_MARGIN) {
      out.problems.push(`The account is on ${mode || "an unknown margin mode"}, not isolated margin. Cross margin is never accepted.`);
      return out;
    }
    // 3. Leverage, read back from the position record. (The record's own tradeMode field is NOT used: Bybit documents it as deprecated and always 0, so it says nothing about the margin mode.
    //    The margin mode is judged above, from the account's marginMode read back after any switch.)
    let rows = await position();
    let level = leverageFromRows(rows, target);
    if (level !== target && !held) {
      try {
        await api("POST", "/v5/position/set-leverage", { category: "linear", symbol: opts.symbol, buyLeverage: String(target), sellLeverage: String(target) });
      } catch (err) {
        if (!(err instanceof BybitApiError && err.retCode === 110043)) throw err; // 110043: already at that leverage. Any other answer ends the check as unreadable.
      }
      // Here Bybit has said the leverage is now (or already was) the target.
      rows = await position();
      level = leverageFromRows(rows, target);
      // The record shows no usable leverage at all (an account with no position can come back without the field, empty, or with no row): the only proof left is Bybit's own answer to the change.
      // That is accepted ONLY when nothing readable contradicts it, and it is said out loud. A leverage that IS readable and wrong is always refused.
      if (!Number.isFinite(level)) {
        level = target;
        out.warnings.push(`Bybit does not show the leverage while the account holds no position. It was set to ${target}x and Bybit confirmed it, but it could not be read back. It can be read once a trade is open.`);
      }
    }
    out.leverage = level;
    if (out.leverage !== target) out.problems.push(`The leverage is ${Number.isFinite(out.leverage) ? `${out.leverage}x` : "not readable"}, not the ${target}x that stage ${opts.stage} requires, and it could not be set.`);
    out.ok = out.problems.length === 0;
    return out;
  } catch (err) {
    out.unreadable = err instanceof Error ? err.message : String(err);
    out.ok = false;
    return out;
  }
}

export class LiveBybitExecutor extends BybitExecutor {
  protected override readonly refPrefixes = LIVE_ORDER_PREFIX;
  /** The result of the last pre-trade check, for the page. */
  lastPreflight: LivePreflight | null = null;

  constructor(config: BybitConfig, private readonly guard: LiveGuard, fetchImpl?: BybitFetch, log?: (line: string) => void, clock?: () => number) {
    super(config, fetchImpl, log, clock, { live: true });
    if (!(config.qty > 0) || config.qty > LIVE_LIMITS.maxQty) throw new BybitConfigError(`The live size is ${config.qty} BTC; the ceiling written in the code is ${LIVE_LIMITS.maxQty}.`);
  }

  /** The loss limit in force: what was chosen, never above the ceiling. The risk monitor reads this. */
  override get dailyMaxLossUsd(): number {
    return clampDailyLoss(this.guard.dailyLossUsd());
  }

  /** A STOP LOSS ALARM turns the live switch off. `handler` is the app's own alarm (the log line, banner and bell). */
  setAlarmHandler(handler: (alarm: { kind: "stop_problem" | "unreachable" | "resolved"; text: string }) => void): void {
    this.onAlarm = (alarm) => {
      if (alarm.kind !== "resolved") this.guard.onAutoOff?.(`STOP LOSS ALARM: ${alarm.text}`);
      handler(alarm);
    };
  }

  /** Asks Bybit about the key and sets/reads isolated margin and leverage. Used before each entry and when the switch is turned on. */
  async preflight(): Promise<LivePreflight> {
    const result = await livePreflight((method, path, params) => this.call(method, path, params, { auth: true }), { stage: this.guard.stage(), symbol: this.config.symbol });
    this.lastPreflight = result;
    return result;
  }

  /** Why a NEW entry is refused right now, or null. A close is never held to this. */
  override async entryBlock(botId: string, now: number): Promise<{ outcome: "daily_loss_limit_reached" | "kill_switch"; reason: string } | null> {
    if (!this.guard.switchOn()) return { outcome: "kill_switch", reason: "Skipped: the live switch is OFF. No new live orders are sent (a position already held can still be closed)." };
    const limit = this.dailyMaxLossUsd;
    const hit = dailyLimitBlock(botId, limit, now, this.config.qty);
    if (hit) {
      this.guard.onAutoOff?.(`the daily loss limit of $${limit.toFixed(2)} was reached`);
      return { outcome: "daily_loss_limit_reached", reason: hit };
    }
    return super.entryBlock(botId, now);
  }

  override async placeOpenOrder(req: OpenSpreadRequest): Promise<{ ref: string }> {
    const now = this.clock();
    const blocked = await this.entryBlock(req.botId, now);
    if (blocked) throw new OrderNotPlacedError(blocked.reason);
    if (this.guard.tradesToday(now) >= LIVE_LIMITS.maxTradesPerDay) throw new OrderNotPlacedError(`Refused: ${LIVE_LIMITS.maxTradesPerDay} live trades have already been opened today (the ceiling written in the code). Nothing was sent.`);
    // A trade already open: no second entry, and no settings are looked at under it (the stop watchdog is the one watching an open trade).
    try {
      const open = await this.getAccountPosition();
      if (open.side !== null) throw new OrderNotPlacedError(`Refused: the Bybit live account already holds ${open.side === "Buy" ? "a long" : "a short"} ${open.size} ${this.config.symbol}. Nothing was sent.`);
    } catch (err) {
      if (err instanceof OrderNotPlacedError) throw err;
      throw new OrderNotPlacedError(`Refused: the live account's position could not be checked first, so nothing was sent: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const pre = await this.preflight();
    if (pre.unreadable) throw new OrderNotPlacedError(`Refused: Bybit could not be asked about the live key and account settings, so nothing was sent: ${pre.unreadable}`);
    if (!pre.ok) {
      const why = pre.problems.join(" ");
      this.guard.onAutoOff?.(`pre-trade check failed: ${why}`);
      throw new OrderNotPlacedError(`Refused, and the live switch was turned OFF: ${why} Nothing was sent.`);
    }
    const entered = await super.placeOpenOrder(req);
    // THE OFF RACE: the switch is checked before the order goes out, but the reads that come right before the order take a moment. If OFF was clicked (or a safety trip turned it OFF) in that
    // moment, the entry has gone out with its stop loss and take profit, and the person said OFF. So it is closed again at once, with a reduce-only order.
    if (this.guard.switchOn()) return entered;
    return this.closeEntryTurnedOff(req, entered.ref);
  }

  /**
   * An entry went out while the switch turned OFF: close it again at once (reduce only, via the same close the Close position button uses) and refuse the open in words, so the engine records no trade.
   * If it cannot be closed or confirmed flat, nothing is hidden: the entry is returned as made (the engine records it as a real trade), it keeps its stop loss and take profit at Bybit, and the log says so.
   */
  private async closeEntryTurnedOff(req: OpenSpreadRequest, ref: string): Promise<{ ref: string }> {
    this.log("[live] The live switch was turned OFF while an entry was going out. Closing that entry again at once (reduce only).");
    const entry = { id: `off-race-${ref}`, botId: req.botId, type: req.positionType, venue: "bybit", brokerOrderRef: ref, filledQuantity: 1, requestedQuantity: 1 } as unknown as Position;
    try {
      await this.placeCloseOrder(entry, { manual: true });
      for (let i = 0; i < 8; i++) {
        const held = await this.getAccountPosition({ retries: 0 });
        if (held.side === null) {
          this.log("[live] That entry was closed again: the live account is flat.");
          throw new OrderNotPlacedError("The live switch was turned OFF while this entry was going out, so it was closed again at once (reduce only). The live account is flat; no trade was kept.");
        }
        await this.sleep(300);
      }
      throw new Error("the close was sent but the account was not seen flat");
    } catch (err) {
      if (err instanceof OrderNotPlacedError && /closed again at once/.test(err.message)) throw err;
      this.log(`[live] That entry could NOT be closed again (${err instanceof Error ? err.message : String(err)}). It stays open with its stop loss and take profit at Bybit; close it with Close position.`);
      return { ref };
    }
  }
}
