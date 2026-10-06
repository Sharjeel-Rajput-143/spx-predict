export type SignalDirection = "bullish" | "bearish";

import type { LegQuotes, SmartPricingMode } from "./smartPricing";

export type PositionType = "short_put_spread" | "short_call_spread";

/** How the short strike is snapped onto the strike grid. "outward" (the default):
 * the short put rounds DOWN and the short call rounds UP - the out-of-the-money
 * side of the target price. "nearest" rounds to the closest strike.
 * TODO(unconfirmed): verify against Option Alpha's real behavior. */
export type StrikeRounding = "outward" | "nearest";

export type PositionStatus = "opening" | "open" | "closing" | "closed" | "expired" | "rejected";

/** Every check that asks "does an active position exist" must count all three -
 * a position mid-transition is not yet (or no longer) seen as open, but it is
 * still live and must block duplicate entries exactly like `open` does. */
export const ACTIVE_POSITION_STATUSES: readonly PositionStatus[] = ["opening", "open", "closing"];

export type OrderKind = "open" | "close";

export type OrderStatus = "working" | "partially_filled" | "filled" | "canceled" | "rejected";

/** Every reason a signal can be stopped or acted on, one per decision log row. */
export type DecisionOutcome =
  | "automations_off"
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
  | "close_rejected"
  | "close_timeout"
  | "close_partial_fill"
  | "close_in_flight"
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
  | "dry_run";

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
  /** Sanity bounds for the signal's price. A price outside is refused, so a
   * signal from the wrong chart can't produce strikes for this underlying. */
  priceRange?: { min: number; max: number };
  /** This bot's own signal window ("HH:MM" ET, inclusive). Unset = the global one. */
  hours?: { start: string; end: string };
}

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
  enabled: boolean;
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
  alerts?: BotAlerts;
  /** The Log view hides entries before this; the data itself is kept. */
  logClearedAt?: number;
  /** "Reset" on the daily-positions counter: only openings after this count. */
  dailyResetAt?: number;
}

/** A saved set of bot inputs, offered in the Library to start new bots from. */
export interface BotTemplate {
  id: string;
  name: string;
  config: BotInputs;
  safeguards?: BotSafeguards;
  createdAt: number;
}

export interface Signal {
  id: string;
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
  /** True when a person placed it from the UI rather than a signal. */
  manual?: boolean;
  /** Labels and a free-form note a person added to this position. */
  tags?: string[];
  notes?: string;
  /** Which executor placed it. "mock" = a test trade: nothing reached a broker. Unset on rows from before this existed (all mock). */
  venue?: ExecutorVenue;
  /** The option series root it trades ("NDXP", "SPXW"), kept so a broker executor can build option symbols for the close. */
  optionRoot?: string;
  /** Placed by the admin page's Send test alert (the real webhook path, flagged internally). */
  test?: boolean;
}

export interface Order {
  id: string;
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
  signalId: string | null;
  botId: string;
  outcome: DecisionOutcome;
  reason: string;
  detail: Record<string, unknown>;
  createdAt: number;
}

export interface ErrorRecord {
  id: string;
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
  placeCloseOrder(position: Position, options?: { pricePercent?: number; limitDebit?: number }): Promise<{ ref: string }>;
  getOrder(ref: string): Promise<OrderState>;
  cancelOrder(ref: string): Promise<void>;
  listPositions(botId: string): Promise<Position[]>;
  /** The bid and ask of each leg, when the executor can see them. Executors without a market (the mock) omit it, and orders then go out at one price. */
  getSpreadQuote?(req: SpreadQuoteRequest): Promise<LegQuotes | null>;
  /** What the broker itself holds, for checking against our records. */
  listBrokerPositions?(): Promise<BrokerPosition[]>;
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
  outcome: DecisionOutcome;
  reason: string;
}

export type TraceNode = TraceDecision | TraceAction;

export interface Run {
  /** The signal's id for a signal run; a generated id for a manual action. */
  id: string;
  botId: string;
  signalId: string | null;
  source: "webhook" | "manual" | "ui";
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
  /** What the person calls it ("BullishNDX"). */
  name: string;
  /** The secret part of the URL: whoever has the URL can trigger it. */
  token: string;
  botId: string;
  /** Which signal a call to this URL means. */
  direction: SignalDirection;
  active: boolean;
  createdAt: number;
  lastTriggeredAt: number | null;
  /** Calls accepted (not counting ones ignored by the once-a-minute limit). */
  triggerCount: number;
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
  id: "app";
}
