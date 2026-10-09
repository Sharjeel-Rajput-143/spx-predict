export type SignalDirection = "bullish" | "bearish";

import type { LegQuotes, SmartPricingMode } from "./smartPricing";

export type PositionType = "short_put_spread" | "short_call_spread";

/** How the short strike is snapped onto the strike grid. "outward" (the default):
 * the short put rounds DOWN and the short call rounds UP - the out-of-the-money
 * side of the target price. "nearest" rounds to the closest strike.
 * TODO(unconfirmed): verify against Option Alpha's real behavior. */
export type StrikeRounding = "outward" | "nearest";

export type PositionStatus = "opening" | "open" | "closing" | "closed" | "expired" | "rejected";

/** Every check that asks "does a position exist" counts all three, like Option Alpha's "any status":
 * a position mid-transition is still live, a closing one is not gone yet, and a failed or stuck order keeps
 * its slot (in the limits, the allocation and the overlap check) until it is cleared. */
export const ACTIVE_POSITION_STATUSES: readonly PositionStatus[] = ["opening", "open", "closing"];

export type OrderKind = "open" | "close";

export type OrderStatus = "working" | "partially_filled" | "filled" | "canceled" | "rejected";

/** Every reason a signal can be stopped or acted on, one per decision log row. */
export type DecisionOutcome =
  /** A signal was accepted but its run never finished (the server stopped or restarted partway): a person should check the positions. */
  | "run_interrupted"
  | "automations_off"
  /** The kill switch is on: nothing runs for this bot. */
  | "kill_switch"
  /** A Close Monitor closed a position that was on the wrong side of the latest confirmed signal. */
  | "monitor_closed"
  /** A webhook was attached to, changed on, or detached from a trigger (logged, never with the URL). */
  | "webhook_attached"
  | "webhook_changed"
  | "webhook_detached"
  /** The bot is off, and a webhook is closing the opposite position (it may close, never open). */
  | "bot_off_close_only"
  | "outside_hours"
  | "duplicate_signal"
  | "already_in_position"
  | "total_position_limit_reached"
  | "daily_limit_reached"
  | "allocation_limit_reached"
  | "invalid_strikes"
  | "symbol_mismatch"
  | "price_out_of_range"
  | "overlapping_strikes"
  /** The Open step's entry or position criteria, or the size it works out to, said not to open (nothing is wrong: it simply did not qualify). */
  | "entry_criteria_not_met"
  /** A webhook call was refused because the alert's text did not agree with the URL's direction. */
  | "webhook_text_mismatch"
  | "position_criteria_not_met"
  | "size_too_small"
  /** A position was closed by its exit options (profit taking, stop loss, touch). */
  | "exit_closed"
  | "close_rejected"
  | "close_timeout"
  | "close_partial_fill"
  | "close_in_flight"
  /** Strike price from a live quote was asked for, and there wasn't a usable one. */
  | "no_live_price"
  | "closed"
  | "opened"
  | "open_rejected"
  | "open_timeout_no_fill"
  | "executor_error"
  | "config_error"
  | "cooldown_active"
  | "trigger_disabled"
  | "day_trading_blocked"
  | "position_moved"
  /** The bot switched itself off: 10 errors in a trading day. */
  | "error_failsafe"
  | "eod_sweep"
  | "dry_run";

/** Where the price the strikes are built from comes from: the price recorded when the call arrived (the bot's own live quote: a webhook carries no price), or a fresh quote taken when the Open step runs. */
export type StrikePriceSource = "alert" | "live";
export const STRIKE_PRICE_SOURCES: readonly StrikePriceSource[] = ["alert", "live"];

export interface BotStaticConfig {
  id: string;
  name: string;
  /** Positions in the same account (across bots) are checked for leg overlap. */
  accountId: string;
  underlying: string;
  quantity: number;
  widthPoints: number;
  strikeIncrement: number;
  /** Signed points from signal price. Short put is typically negative (below
   * price), short call typically positive (above price). */
  putShortOffset: number;
  callShortOffset: number;
  allocationLimit: number;
  /** Phase 1 has no real option chain/pricing - this is the configured
   * expected credit per spread, used both as the opening order's limit price
   * and as the pre-trade estimate for the allocation-limit check. */
  openingCreditEstimate: number;
  /** The option series root ("NDXP" for NDX dailies). Informational until a
   * real broker executor needs it to build option symbols. */
  optionRoot?: string;
  /** Default "alert". "live" needs a real-time quote source; with none (or a stale quote) the bot refuses to open rather than guess. */
  strikePriceSource?: StrikePriceSource;
  /** Default "outward". See StrikeRounding. */
  strikeRounding?: StrikeRounding;
  /** The order price as a percent of the bid/ask, for opening and closing orders
   * (Option Alpha: "100% of bid/ask"). Unset = 100.
   * TODO(unconfirmed): the exact meaning - confirm with the owner. Carried on the
   * order as `pricePercent`; the mock has no bid/ask, so nothing is computed from it yet. */
  openPricePercent?: number;
  closePricePercent?: number;
  /** SmartPricing preset for opening and closing orders (default normal) - used only when the executor can quote the spread. */
  smartPricing?: SmartPricingMode;
  /** This bot's own total-position limit; unset = the global default. A safeguard
   * set on the bot (Settings > Safeguards) still wins. */
  totalPositionLimit?: number;
  /** "HH:MM" America/New_York: when this bot's positions are swept to expired.
   * Unset = 4:05pm ET. Index options can trade later than equities, so a
   * bot on such a series sets its own. */
  eodSweepTime?: string;
  /** What the sweep does with positions still active at that time. Default "estimate". */
  eodSweepMode?: EodSweepMode;
  /** Sanity bounds for the signal's price. A price outside is refused, so a
   * signal from the wrong chart can't produce strikes for this underlying. */
  priceRange?: { min: number; max: number };
  /** This bot's own signal window ("HH:MM" ET, inclusive). Unset = the global one. */
  hours?: { start: string; end: string };
}

/** What the end-of-day sweep does with a position still held near the series' close.
 * estimate: marks it expired and estimates its P/L from the underlying's price (default).
 * market: sends a close order at market.
 * manual: marks it expired and waits for a person to enter its P/L. */
export type EodSweepMode = "estimate" | "market" | "manual";
export const EOD_SWEEP_MODES: readonly EodSweepMode[] = ["estimate", "market", "manual"];

/** A Close Monitor (Option Alpha's "BullishSpx Close Monitor"): every minute inside the trading window it looks for a position
 * on the wrong side of the latest confirmed signal and closes it. OFF by default, as in Option Alpha. */
export interface CloseMonitorSettings {
  enabled: boolean;
  /** Written on the position it closes (the Close Position form's Memo). */
  memo?: string;
  /** Labels added to the position it closes (the form's Tags). */
  tags?: string[];
}
export type MonitorKey = "bullishClose" | "bearishClose";

/** The inputs a bot trades with - everything in BotStaticConfig except its id. */
export type BotInputs = Omit<BotStaticConfig, "id">;

/** Per-bot overrides of the global safeguard defaults (unset = use the default). */
export interface BotSafeguards {
  allocationLimit?: number;
  dailyNewPositionLimit?: number;
  totalPositionLimit?: number;
  maxPositionsPerType?: number;
  /** False = a signal never closes a position that was opened the same day. Unset = allowed. */
  dayTrading?: boolean;
}

/** Which kinds of events raise an in-app alert for this bot. */
export interface BotAlerts {
  open: boolean;
  close: boolean;
  warning: boolean;
  error: boolean;
}

export const DEFAULT_ALERTS: BotAlerts = { open: true, close: true, warning: true, error: true };

/** The mutable, store-backed half of a bot's state. The static half comes from
 * bots.ts: env for the built-in bot, `config` for bots created in the UI (and
 * as a full override once the built-in bot's inputs are edited there). */
export interface Bot {
  id: string;
  /** The user this record belongs to (a reference to `users`). A record without one belongs to the owner: the login set in the environment. */
  userId?: string;
  enabled: boolean;
  /** The kill switch: while on, a webhook run does nothing at all - no close, no open. Separate from `enabled`
   * (the bot's On/Off, which still lets a webhook close the opposite position). The end-of-day sweep and the
   * Close position button are never blocked by either. Only a person turns it off. */
  killSwitch?: boolean;
  needsAttention: boolean;
  needsAttentionReason: string | null;
  createdAt: number;
  name?: string;
  /** Free-form grouping label ("Bot Group"). */
  group?: string | null;
  tags?: string[];
  notes?: string;
  /** Archived bots are switched off and hidden from the default list. */
  archived?: boolean;
  config?: BotInputs;
  /** A bot created with just a name, account and allocation: its trading
   * inputs are required but not yet entered, so it can't trade (it reports
   * "setup needed", like the built-in bot with its env offsets unset). Saving
   * the full inputs replaces this with `config`. */
  draftInputs?: Partial<BotInputs>;
  safeguards?: BotSafeguards;
  /** Each signal direction can be switched off on its own; unset = on. */
  triggers?: { bullish: boolean; bearish: boolean };
  /** Option Alpha's trigger setting "Always On - run even if automations are turned off", per direction; unset = on.
   * Copied only for closes: with the bot off, an Always On trigger may still close the opposite position and never opens.
   * Off = with the bot off the trigger does nothing at all. */
  alwaysOn?: { bullish: boolean; bearish: boolean };
  /** The position checks edited on each trigger's canvas (see positionChecks.ts). Unset = the engine's defaults. */
  positionChecks?: import("./positionChecks").PositionChecks;
  /** The Memo and Tags on each trigger's Close Position step: written on the position that step closes. */
  /** What each trigger's Open Position step is set to do (see openSettings.ts). Unset = the bot's own inputs. */
  openSettings?: Partial<Record<"bullish" | "bearish", import("./openSettings").OpenSettings>>;
  closeSettings?: Partial<Record<"bullish" | "bearish", { memo?: string; tags?: string[]; pricing?: import("./closePricing").ClosePricing; quantity?: import("./closePricing").CloseQuantity }>>;
  /** Close Monitors, by key. Unset = off. */
  monitors?: Partial<Record<MonitorKey, CloseMonitorSettings>>;
  alerts?: BotAlerts;
  /** The Log view hides entries before this; the data itself is kept. */
  logClearedAt?: number;
  /** "Reset" on the daily-positions counter: only openings after this count. */
  dailyResetAt?: number;
}

/** A saved set of bot inputs, offered in the Library to start new bots from. */
export interface BotTemplate {
  id: string;
  /** The user this record belongs to (a reference to `users`). A record without one belongs to the owner: the login set in the environment. */
  userId?: string;
  name: string;
  config: BotInputs;
  safeguards?: BotSafeguards;
  createdAt: number;
}

export interface Signal {
  id: string;
  /** The user this record belongs to (a reference to `users`). A record without one belongs to the owner: the login set in the environment. */
  userId?: string;
  botId: string;
  /** "bullish" | "bearish" for every `status: "accepted"` row - loosely typed
   * so a `status: "rejected"` row (bad secret, malformed body) can still log
   * whatever string arrived without a cast. */
  signal: string;
  barTime: string;
  price: number;
  interval: string;
  receivedAt: number;
  status: "accepted" | "rejected";
  rejectReason?: string;
  raw: unknown;
}

export interface Position {
  id: string;
  /** The user this record belongs to (a reference to `users`). A record without one belongs to the owner: the login set in the environment. */
  userId?: string;
  botId: string;
  /** Needed to scope the leg-overlap check across bots sharing an account. */
  underlying: string;
  type: PositionType;
  shortStrike: number;
  longStrike: number;
  requestedQuantity: number;
  filledQuantity: number;
  /** YYYY-MM-DD, the America/New_York trading date this 0DTE position expires. */
  expiry: string;
  status: PositionStatus;
  /** Realized credit per spread once an open fill reports one; null until then. */
  credit: number | null;
  openedAt: number | null;
  closedAt: number | null;
  openSignalId: string | null;
  closeSignalId: string | null;
  /** Most recent order ref placed against this position (open or close). */
  brokerOrderRef: string | null;
  /** Debit per spread the closing order filled at; unset when the executor
   * reported no fill price (the mock executor, unless pricing is simulated). */
  closePrice?: number | null;
  /** Underlying price at the signal that opened / closed it. */
  underlyingAtOpen?: number | null;
  underlyingAtClose?: number | null;
  /** The exit options the position was opened with (a later edit does not change an open position). */
  exitOptions?: import("./openSettings").ExitOptions;
  /** Set on the closed record a partial close leaves behind: the position it was split from. It is not a new position (it does not count toward the daily limit). */
  splitFrom?: string;
  /** True when a person placed it from the UI rather than a signal. */
  manual?: boolean;
  /** Labels and a free-form note a person added to this position. */
  tags?: string[];
  notes?: string;
  /** Which executor placed it. "mock" = a test trade: nothing reached a broker. Unset on rows from before this existed (all mock). */
  venue?: ExecutorVenue;
  /** The option series root it trades ("NDXP", "SPXW"), kept so a broker executor can build option symbols for the close. */
  optionRoot?: string;
  /** How an expired position's result was settled: estimated from the underlying, or typed in by a person. Unset = no result recorded. */
  settlement?: PositionSettlement;
  /** Placed by the admin page's Send test alert (the real webhook path, flagged internally). */
  test?: boolean;
}

/** The result of a position that expired rather than being closed by a fill. */
export interface PositionSettlement {
  kind: "estimated" | "manual";
  /** Total profit or loss in dollars for the whole position. */
  pl: number;
  /** Estimated: the underlying's price it was worked out from. */
  underlyingPrice?: number;
  /** Estimated: what the spread was worth per share at that price (the debit that would have closed it). */
  settleValue?: number;
  at: number;
}

export interface Order {
  id: string;
  /** The user this record belongs to (a reference to `users`). A record without one belongs to the owner: the login set in the environment. */
  userId?: string;
  positionId: string;
  kind: OrderKind;
  status: OrderStatus;
  limitPrice: number;
  filledQuantity: number;
  rejectReason?: string;
  /** The executor's own order reference, used to poll getOrder(). */
  ref: string;
  createdAt: number;
  updatedAt: number;
}

export interface Decision {
  id: string;
  /** The user this record belongs to (a reference to `users`). A record without one belongs to the owner: the login set in the environment. */
  userId?: string;
  signalId: string | null;
  botId: string;
  outcome: DecisionOutcome;
  reason: string;
  detail: Record<string, unknown>;
  createdAt: number;
}

export interface ErrorRecord {
  id: string;
  /** The user this record belongs to (a reference to `users`). A record without one belongs to the owner: the login set in the environment. */
  userId?: string;
  botId: string;
  kind: string;
  detail: Record<string, unknown>;
  /** YYYY-MM-DD America/New_York - the failsafe counts and resets by this, not by createdAt. */
  tradingDate: string;
  createdAt: number;
}

// --- Executor interface (spec's exact shape) ---

export interface OrderState {
  status: OrderStatus;
  filledQuantity: number;
  averagePrice?: number;
  rejectReason?: string;
}

export type ExecutorVenue = "mock" | "tradier";

export interface OpenSpreadRequest {
  botId: string;
  /** Percent of bid/ask the order should be priced at (see BotStaticConfig.openPricePercent). */
  pricePercent?: number;
  /** "NDX" / "SPX" - the underlying symbol. Optional: the mock ignores it. */
  underlying?: string;
  /** Option series root ("NDXP"). A broker executor refuses to guess it when unset. */
  optionRoot?: string;
  positionType: PositionType;
  shortStrike: number;
  longStrike: number;
  quantity: number;
  /** The opening limit credit per spread. */
  limitCredit: number;
  expiry: string;
}

/** One option position as the broker reports it. */
export interface BrokerPosition {
  /** The OCC-style option symbol. */
  symbol: string;
  /** Contracts: negative = short. */
  quantity: number;
}

/** The legs of a spread, to ask for a quote on. */
export interface SpreadQuoteRequest {
  underlying: string;
  optionRoot?: string;
  expiry: string;
  type: PositionType;
  shortStrike: number;
  longStrike: number;
}

export interface BrokerExecutor {
  /** What kind of executor this is; unset is treated as "mock". */
  readonly venue?: ExecutorVenue;
  placeOpenOrder(req: OpenSpreadRequest): Promise<{ ref: string }>;
  /** `limitDebit`: the most to pay to buy the spread back. Unset = the executor's own default (the mock fills; Tradier sends a market order). */
  placeCloseOrder(position: Position, options?: { pricePercent?: number; limitDebit?: number; quantity?: number }): Promise<{ ref: string }>;
  getOrder(ref: string): Promise<OrderState>;
  cancelOrder(ref: string): Promise<void>;
  listPositions(botId: string): Promise<Position[]>;
  /** The bid and ask of each leg, when the executor can see them. Executors without a market (the mock) omit it, and orders then go out at one price. */
  getSpreadQuote?(req: SpreadQuoteRequest): Promise<LegQuotes | null>;
  /** What the broker itself holds, for checking against our records. */
  listBrokerPositions?(): Promise<BrokerPosition[]>;
  /** The account's balances, for showing the paper (or real) balance next to the bots. */
  getBalances?(): Promise<BrokerBalances>;
}

export interface BrokerBalances {
  accountId: string;
  totalEquity: number | null;
  /** Cash that can fund new option positions. */
  optionBuyingPower: number | null;
  cash: number | null;
}

// --- Run trace: what the engine walked through for one signal or manual action ---

/** A check the engine made, its result, and the real value it compared. */
export interface TraceDecision {
  kind: "decision";
  /** The condition, in words ("Current market time is between 9:35am - 3:55pm"). */
  text: string;
  result: boolean;
  /** The measured value behind the result ("Current time is 9:40am", "0 positions"). */
  measured: string;
}

/** An order the run placed, with the parameters it was placed with. */
export interface TraceAction {
  kind: "action";
  action: "open" | "close";
  title: string;
  /** The position it acted on; null when none was created (e.g. a dry run). */
  positionId: string | null;
  /** "SPX Short Call Spread Oct 2 / -7,720 call, +7,725 call" */
  summary: string;
  /** A frozen snapshot of the settings the order used. */
  params: { label: string; value: string }[];
  /** One line per price the order tried (SmartPricing), in order: what was sent, for how long, what happened. */
  steps?: string[];
  outcome: DecisionOutcome;
  reason: string;
}

export type TraceNode = TraceDecision | TraceAction;

export interface Run {
  /** The signal's id for a signal run; a generated id for a manual action. */
  id: string;
  botId: string;
  signalId: string | null;
  source: "webhook" | "manual" | "ui" | "monitor";
  /** Which automation ran: "Bullish signal", "Bearish signal", "Manual open"... */
  automation: string;
  /** What set it off: "Webhook", "Manual run", "Manual action". */
  trigger: string;
  startedAt: number;
  nodes: TraceNode[];
}

// --- Activity alerts: what happened, in plain words, for the status page (and optionally email) ---

export type AlertKind = "open" | "close" | "warning" | "error";

export interface ActivityAlert {
  id: string;
  /** The user this record belongs to (a reference to `users`). A record without one belongs to the owner: the login set in the environment. */
  userId?: string;
  botId: string;
  kind: AlertKind;
  /** The decision outcome that raised it. */
  outcome: DecisionOutcome;
  message: string;
  signalId: string | null;
  createdAt: number;
  /** "off" unless email alerts are switched on; "queued" = written to the outbox (no sender is wired yet). */
  email: "off" | "queued";
}

// --- Named webhooks: one unique URL per bot and direction, like Option Alpha's ---

export interface Webhook {
  id: string;
  /** The user this record belongs to (a reference to `users`). A record without one belongs to the owner: the login set in the environment. */
  userId?: string;
  /** What the person calls it ("BullishNDX"). */
  name: string;
  /** The secret part of the URL: whoever has the URL can trigger it. */
  token: string;
  /** The trigger it is attached to (a bot and a direction): a call to the URL means that signal for that bot. Null =
   * not attached yet, and a call to it is refused. One webhook, one trigger; a trigger holds one webhook. */
  botId: string | null;
  direction: SignalDirection | null;
  active: boolean;
  createdAt: number;
  lastTriggeredAt: number | null;
  /** Calls accepted (not counting ones ignored by the once-a-minute limit). */
  triggerCount: number;
  /** The alert's text must say this webhook's own direction ("bullish" / "bearish"), and never the other one: a call whose text
   * disagrees with its URL is refused and flagged, so an alert pointed at the wrong URL can't trade. On unless set to false (a
   * webhook made before this setting existed is on too). A text that says the OTHER direction is refused even when it is off. The text
   * can only ever block a call, never start one. */
  requireDirectionText?: boolean;
}

export interface TriggerOption {
  id: string;
  name: string;
  active: boolean;
  /** Can this trigger take it? False when it is attached to another trigger. */
  available: boolean;
  attachedHere: boolean;
  /** Why it can't be picked, in words. */
  reason: string | null;
}

// --- App-wide settings (Settings page) ---

export interface AppSettings {
  /** The default signal window for every bot that doesn't have its own ("HH:MM", New York). null = the environment's (9:35 - 3:55 unless overridden). */
  tradingWindow: { start: string; end: string } | null;
  emailAlerts: {
    /** Off by default. TODO(owner): no mail sender is wired yet, so enabling it only queues each alert. */
    enabled: boolean;
    to: string;
    /** "When a position is opened or closed". */
    onTrade: boolean;
    /** Warnings and errors. */
    onWarningError: boolean;
    /** Alerts for test trades (the mock executor's). */
    includeTest: boolean;
  };
  /** Minutes before a sign-in expires: 30, 60, 120, 240 or 480. */
  sessionTimeoutMinutes: number;
}

export interface AppSettingsRow extends Partial<AppSettings> {
  /** "app" for the owner's settings; "app:<userId>" for any other user's. */
  id: string;
  userId?: string;
}

/** Someone who can sign in. Every other record points at one by `userId`. */
export interface User {
  id: string;
  email: string;
  createdAt: number;
  lastLoginAt: number;
}
