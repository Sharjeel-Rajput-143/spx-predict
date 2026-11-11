import { BYBIT_UNDERLYING } from "./executorKind";
import { LIVE_BOT_ID, LIVE_LIMITS } from "./bybitLiveLimits";
import "server-only";
import { validateOpenSettings, type OpenSettings } from "./openSettings";
import { validateCloseQuantity, validateClosePricing, type CloseQuantity, type ClosePricing } from "./closePricing";
import { validateCheck, type PositionCheck, type PositionChecks } from "./positionChecks";
import crypto from "node:crypto";
import { ownerUserId } from "@/lib/auth/users";
import { currentUserId } from "./userContext";
import { SMART_PRICING_MODES, type SmartPricingMode } from "./smartPricing";
import { DAILY_NEW_POSITION_LIMIT, MAX_POSITIONS_PER_TYPE, TOTAL_POSITION_LIMIT, dailyLossLimitDefault, envNumber, envString, parseClockMinutes } from "./config";
import {
  alertsStore,
  botsStore,
  decisionsStore,
  errorsStore,
  ordersStore,
  positionsStore,
  runsStore,
  signalsStore,
  templatesStore,
  webhooksStore,
} from "./store";
import {
  ACTIVE_POSITION_STATUSES,
  DEFAULT_ALERTS,
  EOD_SWEEP_MODES,
  STRIKE_PRICE_SOURCES,
  type StrikePriceSource,
  type Bot,
  type BotInputs,
  type CloseMonitorSettings,
  type MonitorKey,
  type EodSweepMode,
  type BotSafeguards,
  type BotStaticConfig,
  type BotTemplate,
} from "./types";

/** Settings both built-in bots share, read from `<PREFIX>_...` env vars:
 * strike rounding, the order price as a percent of bid/ask, and the bot's
 * total-position limit (the live SPX bot holds up to 3; NDX stays at 1). */
function pricingAndLimits(prefix: string, defaultTotalPositionLimit: number): Pick<BotStaticConfig, "strikeRounding" | "openPricePercent" | "closePricePercent" | "totalPositionLimit" | "smartPricing"> {
  const rounding = envString(`${prefix}_STRIKE_ROUNDING`, "outward");
  if (rounding !== "outward" && rounding !== "nearest") throw new Error(`${prefix}_STRIKE_ROUNDING must be "outward" or "nearest", got "${rounding}".`);
  const smart = envString(`${prefix}_SMART_PRICING`, "normal");
  if (!(SMART_PRICING_MODES as string[]).includes(smart)) throw new Error(`${prefix}_SMART_PRICING must be one of ${SMART_PRICING_MODES.join(", ")}, got "${smart}".`);
  return {
    // The live Option Alpha bot runs SmartPricing in Normal mode (up to 4 prices, 10 seconds each). It only
    // applies when the executor can quote the spread; the mock has no market, so it sends one price.
    smartPricing: smart as SmartPricingMode,
    // TODO(unconfirmed): verify "outward" against Option Alpha's real behavior.
    strikeRounding: rounding,
    // TODO(unconfirmed): what "100% of bid/ask" means exactly - confirm with the owner.
    openPricePercent: envNumber(`${prefix}_OPEN_PRICE_PERCENT`, 100),
    closePricePercent: envNumber(`${prefix}_CLOSE_PRICE_PERCENT`, 100),
    totalPositionLimit: envNumber(`${prefix}_TOTAL_POSITION_LIMIT`, defaultTotalPositionLimit),
  };
}

/** Env vars the NDX bot cannot start without. Each is a real trading or safety
 * parameter that must come from Blue or the broker's option chain - never a guess. */
/** A built-in bot is missing required settings: carries the list so the UI can
 * show it as a checklist rather than one long sentence. */
export class MissingSettingsError extends Error {
  constructor(readonly missing: { key: string; why: string }[], message: string) {
    super(message);
    this.name = "MissingSettingsError";
  }
}

export const missingSettingsOf = (err: unknown): { key: string; why: string }[] | null =>
  err instanceof MissingSettingsError ? err.missing : null;

/** Names of the built-in bots, known even while their settings are incomplete.
 * The id `ndx_ema_bias` (and the `BOT_NDX_EMA_BIAS_*` settings prefix) is a LEGACY name: it stays because webhooks,
 * stored records and settings are keyed on it. The platform has no EMA or indicator settings; the direction comes
 * only from the TradingView webhook call. */
const BUILT_IN_NAMES: Record<string, string> = {
  spx_ema_bias: "SPX EMA 9/20 Bias",
  ndx_ema_bias: "NDX Bias Bot",
  btc_bybit: "BTC Bybit Bot",
  [LIVE_BOT_ID]: "BTC Bybit LIVE Bot",
};

/** The dedicated bot for the Bybit demo account (BTCUSDT). It is the only bot whose orders go to Bybit (see BYBIT_UNDERLYING); the NDX Bias Bot has no link to it. */
export const BTC_BOT_ID = "btc_bybit";


export const botDisplayName = (botId: string): string => botsStore.get(botId)?.name ?? BUILT_IN_NAMES[botId] ?? botId;

/** NDX is a second bot row driven by config, not forked code. Names every
 * missing required value at once so one look at the error is enough. */
function ndxConfig(): BotStaticConfig {
  const hoursStart = process.env.BOT_NDX_EMA_BIAS_HOURS_START;
  const hoursEnd = process.env.BOT_NDX_EMA_BIAS_HOURS_END;
  return {
    id: "ndx_ema_bias",
    name: BUILT_IN_NAMES.ndx_ema_bias,
    accountId: envString("BOT_NDX_EMA_BIAS_ACCOUNT_ID", "paper-ndx"),
    underlying: "NDX",
    // TODO(verify): NDXP is the root for daily NDX expirations - confirm it, and that a 0DTE exists every weekday.
    optionRoot: envString("BOT_NDX_EMA_BIAS_OPTION_ROOT", "NDXP"),
    quantity: envNumber("BOT_NDX_EMA_BIAS_QUANTITY", 1),
    widthPoints: envNumber("BOT_NDX_EMA_BIAS_WIDTH_POINTS", 10),
    // NDX strikes near the money are 5 points apart (the sandbox probe, scripts/tradier-sandbox-probe.ts, prints the real spacing).
    strikeIncrement: envNumber("BOT_NDX_EMA_BIAS_STRIKE_INCREMENT", 5),
    // Mirrors the live SPX bot (short strike 0.01 beyond the price, i.e. the first strike at or beyond it).
    // TODO(owner to confirm for NDX): these defaults are the SPX bot's, not a value anyone chose for NDX.
    putShortOffset: envNumber("BOT_NDX_EMA_BIAS_PUT_SHORT_OFFSET", -0.01),
    callShortOffset: envNumber("BOT_NDX_EMA_BIAS_CALL_SHORT_OFFSET", 0.01),
    ...pricingAndLimits("BOT_NDX_EMA_BIAS", 1),
    // The price the strikes are built from: the alert's (default; right for the mock and the delayed sandbox)
    // or a live quote taken when the Open step runs (only once a real-time quote source is connected).
    strikePriceSource: strikePriceSource(envString("BOT_NDX_EMA_BIAS_STRIKE_PRICE_SOURCE", "alert")),
    allocationLimit: envNumber("BOT_NDX_EMA_BIAS_ALLOCATION_LIMIT", 2000),
    // Only the fallback price (when there is no live quote to price the spread from, e.g. the mock) and the pre-trade risk check.
    openingCreditEstimate: envNumber("BOT_NDX_EMA_BIAS_OPENING_CREDIT_ESTIMATE", 3.5),
    ...optionalMinCredit("BOT_NDX_EMA_BIAS"),
    // NDX index options (NDXP) stop trading at 4:15pm ET; the sweep runs ten minutes before that.
    // TODO(verify): the series' final trading time against the broker's own listing.
    eodSweepTime: envString("BOT_NDX_EMA_BIAS_EOD_SWEEP_TIME", "16:05"),
    eodSweepMode: sweepMode(envString("BOT_NDX_EMA_BIAS_EOD_SWEEP_MODE", "estimate")),
    // A sanity range for the signal's price is optional: set both ends to turn it on.
    ...optionalPriceRange("BOT_NDX_EMA_BIAS"),
    ...(hoursStart && hoursEnd ? { hours: { start: hoursStart, end: hoursEnd } } : {}),
  };
}

/**
 * The BTC Bybit Bot: the same signal engine as the other bots (a bullish signal goes long, a bearish one short, a flip closes the other side first), on the Bybit demo
 * account only. Its "underlying" is BTC; the price it works from is Bybit's own (see tickStore). The strike and credit fields are the engine's bookkeeping units, not options:
 * no option spread is ever created for it (the Bybit executor turns a position type into a long or a short).
 */
function btcConfig(): BotStaticConfig {
  return {
    id: BTC_BOT_ID,
    name: BUILT_IN_NAMES.btc_bybit,
    accountId: envString("BOT_BTC_BYBIT_ACCOUNT_ID", "bybit-demo"),
    underlying: BYBIT_UNDERLYING,
    optionRoot: "BTC",
    quantity: 1,
    widthPoints: 10,
    strikeIncrement: 5,
    putShortOffset: -0.01,
    callShortOffset: 0.01,
    ...pricingAndLimits("BOT_BTC_BYBIT", 1),
    strikePriceSource: "alert",
    allocationLimit: envNumber("BOT_BTC_BYBIT_ALLOCATION_LIMIT", 2000),
    openingCreditEstimate: 3.5,
    eodSweepTime: "16:05",
    eodSweepMode: "estimate",
  };
}

/**
 * The LIVE bot: the same signal engine and the same BTC perpetual, on the real Bybit account (see bybitLive.ts). It starts OFF, and it is switched on and off only together with
 * the live switch (liveSettings.ts). Its limits are written here and cannot be raised: one position at a time, five new positions a day.
 */
function liveConfig(): BotStaticConfig {
  return {
    ...btcConfig(),
    id: LIVE_BOT_ID,
    name: BUILT_IN_NAMES[LIVE_BOT_ID],
    accountId: "bybit-live",
    ...pricingAndLimits("BOT_BTC_BYBIT_LIVE", 1),
    totalPositionLimit: LIVE_LIMITS.maxOpenPositions,
  };
}

function strikePriceSource(value: string): StrikePriceSource {
  if (!(STRIKE_PRICE_SOURCES as readonly string[]).includes(value)) throw new Error(`BOT_NDX_EMA_BIAS_STRIKE_PRICE_SOURCE must be one of ${STRIKE_PRICE_SOURCES.join(", ")}, got "${value}".`);
  return value as StrikePriceSource;
}

function sweepMode(value: string): EodSweepMode {
  if (!(EOD_SWEEP_MODES as readonly string[]).includes(value)) throw new Error(`BOT_NDX_EMA_BIAS_EOD_SWEEP_MODE must be one of ${EOD_SWEEP_MODES.join(", ")}, got "${value}".`);
  return value as EodSweepMode;
}

/** `<PREFIX>_MIN_CREDIT`: the lowest credit an open may be priced at. Unset = a quarter of the expected credit (see minCredit.ts). */
function optionalMinCredit(prefix: string): Pick<BotStaticConfig, "minCredit"> {
  const raw = process.env[`${prefix}_MIN_CREDIT`];
  if (raw === undefined || raw === "") return {};
  return { minCredit: envNumber(`${prefix}_MIN_CREDIT`, 0) };
}

/** `<PREFIX>_PRICE_MIN` and `_PRICE_MAX`: both or neither. */
function optionalPriceRange(prefix: string): Pick<BotStaticConfig, "priceRange"> {
  const min = process.env[`${prefix}_PRICE_MIN`];
  const max = process.env[`${prefix}_PRICE_MAX`];
  if (!min && !max) return {};
  if (!min || !max) throw new Error(`${prefix}_PRICE_MIN and ${prefix}_PRICE_MAX must be set together (or neither).`);
  return { priceRange: { min: envNumber(`${prefix}_PRICE_MIN`, 0), max: envNumber(`${prefix}_PRICE_MAX`, 0) } };
}

/** Startup checks that apply to every bot, whatever its source. The first
 * problem is thrown with a stable token in front so the decision log can be
 * searched for it. */
export function checkBotConfig(c: BotStaticConfig): void {
  if (c.strikeIncrement <= 0) throw new Error(`invalid_config: strike increment must be greater than 0 (got ${c.strikeIncrement}).`);
  if (c.widthPoints % c.strikeIncrement !== 0) {
    throw new Error(`width_not_multiple_of_increment: spread width ${c.widthPoints} is not a multiple of the strike increment ${c.strikeIncrement}, so the long strike could never land on a real strike.`);
  }
  if (c.openingCreditEstimate >= c.widthPoints) {
    throw new Error(`invalid_config: the expected credit ${c.openingCreditEstimate} must be less than the spread width ${c.widthPoints}.`);
  }
  if (c.minCredit !== undefined && !(Number.isFinite(c.minCredit) && c.minCredit >= 0 && c.minCredit < c.openingCreditEstimate)) {
    throw new Error(`invalid_config: the minimum credit must be at least 0 and below the expected credit ${c.openingCreditEstimate} (got ${String(c.minCredit)}).`);
  }
  if (c.priceRange && !(c.priceRange.min > 0 && c.priceRange.min < c.priceRange.max)) {
    throw new Error(`invalid_config: the price range must have 0 < min < max (got ${c.priceRange.min} to ${c.priceRange.max}).`);
  }
  if (![c.putShortOffset, c.callShortOffset].every(Number.isFinite)) throw new Error("invalid_config: the short strike offsets must be numbers (decimals are fine, e.g. -0.01).");
  if (c.strikeRounding !== undefined && c.strikeRounding !== "outward" && c.strikeRounding !== "nearest") {
    throw new Error(`invalid_config: strike rounding must be "outward" or "nearest", got "${String(c.strikeRounding)}".`);
  }
  for (const [label, v] of [["Open price", c.openPricePercent], ["Close price", c.closePricePercent]] as const) {
    if (v !== undefined && !(Number.isFinite(v) && v > 0 && v <= 100)) throw new Error(`invalid_config: ${label.toLowerCase()} must be a percent of bid/ask above 0 and at most 100 (got ${String(v)}).`);
  }
  if (c.smartPricing !== undefined && !(SMART_PRICING_MODES as string[]).includes(c.smartPricing)) {
    throw new Error(`invalid_config: SmartPricing must be one of ${SMART_PRICING_MODES.join(", ")} (got "${String(c.smartPricing)}").`);
  }
  if (c.totalPositionLimit !== undefined && !(Number.isInteger(c.totalPositionLimit) && c.totalPositionLimit >= 1)) {
    throw new Error(`invalid_config: the total position limit must be a whole number of at least 1 (got ${String(c.totalPositionLimit)}).`);
  }
  if (c.strikePriceSource !== undefined && !(STRIKE_PRICE_SOURCES as readonly string[]).includes(c.strikePriceSource)) {
    throw new Error(`invalid_config: the strike price source must be one of ${STRIKE_PRICE_SOURCES.join(", ")} (got "${String(c.strikePriceSource)}").`);
  }
  if (c.eodSweepTime) parseClockMinutes(c.eodSweepTime, "End-of-day sweep time");
  if (c.eodSweepMode !== undefined && !(EOD_SWEEP_MODES as readonly string[]).includes(c.eodSweepMode)) {
    throw new Error(`invalid_config: the end-of-day sweep must be one of ${EOD_SWEEP_MODES.join(", ")} (got "${String(c.eodSweepMode)}").`);
  }
  if (c.hours) {
    if (parseClockMinutes(c.hours.start, "Trading hours start") >= parseClockMinutes(c.hours.end, "Trading hours end")) {
      throw new Error("invalid_config: the trading hours must start before they end.");
    }
  }
}

/** The built-in bots: their inputs come from env. Each factory re-reads env on
 * every call so a required-but-missing var only throws when the bot is
 * actually used, not at module import time. */
const STATIC_CONFIGS: Record<string, () => BotStaticConfig> = {
  spx_ema_bias: () => ({
    id: "spx_ema_bias",
    name: BUILT_IN_NAMES.spx_ema_bias,
    accountId: envString("BOT_SPX_EMA_BIAS_ACCOUNT_ID", "paper-1"),
    underlying: "SPX",
    // TODO(verify): SPXW is the root for SPX daily (0DTE) expirations - confirm against the real option chain.
    optionRoot: envString("BOT_SPX_EMA_BIAS_OPTION_ROOT", "SPXW"),
    quantity: envNumber("BOT_SPX_EMA_BIAS_QUANTITY", 3),
    widthPoints: envNumber("BOT_SPX_EMA_BIAS_WIDTH_POINTS", 5),
    strikeIncrement: envNumber("BOT_SPX_EMA_BIAS_STRIKE_INCREMENT", 5),
    // The live Option Alpha SPX bot: short strike 0.01 beyond the underlying price.
    putShortOffset: envNumber("BOT_SPX_EMA_BIAS_PUT_SHORT_OFFSET", -0.01),
    callShortOffset: envNumber("BOT_SPX_EMA_BIAS_CALL_SHORT_OFFSET", 0.01),
    ...pricingAndLimits("BOT_SPX_EMA_BIAS", 3),
    allocationLimit: envNumber("BOT_SPX_EMA_BIAS_ALLOCATION_LIMIT", 20000),
    // The spec's example credit; only the fallback price and the pre-trade risk check (a live quote sets the real price).
    openingCreditEstimate: envNumber("BOT_SPX_EMA_BIAS_OPENING_CREDIT_ESTIMATE", 2.2),
    ...optionalMinCredit("BOT_SPX_EMA_BIAS"),
  }),
  ndx_ema_bias: ndxConfig,
  btc_bybit: btcConfig,
  [LIVE_BOT_ID]: liveConfig,
};

export function isBuiltInBot(botId: string): boolean {
  return botId in STATIC_CONFIGS;
}

const isUserBot = (b: Bot | undefined): b is Bot => !!b && (!!b.config || !!b.draftInputs);

/** The built-in bots (from the environment) belong to the owner: another signed-in user doesn't see them. */
function seesBuiltIns(): boolean {
  const me = currentUserId();
  return me === null || me === ownerUserId();
}

export function listBotIds(): string[] {
  const ids = new Set(seesBuiltIns() ? Object.keys(STATIC_CONFIGS) : []);
  for (const b of botsStore.all()) if (isUserBot(b)) ids.add(b.id);
  return [...ids];
}

/** The account a bot trades on, or null if it can't be determined. Never throws:
 * a bot still waiting for its inputs has no complete config, and that must not
 * stop any *other* bot from checking which bots share its account. */
export function botAccountId(botId: string): string | null {
  try {
    return getBotStaticConfig(botId).accountId;
  } catch {
    return botsStore.get(botId)?.draftInputs?.accountId ?? null;
  }
}

export function isKnownBot(botId: string): boolean {
  return (isBuiltInBot(botId) && seesBuiltIns()) || isUserBot(botsStore.get(botId));
}

/** A bot's trading inputs: its stored config if it has one (every bot made in
 * the UI, and the built-in bot once its inputs are edited there), else env.
 * A per-bot allocation override from Safeguards always wins. */
export function getBotStaticConfig(botId: string): BotStaticConfig {
  const record = botsStore.get(botId);
  let config: BotStaticConfig;
  if (record?.config) {
    config = { id: botId, ...record.config };
  } else if (record?.draftInputs) {
    throw new Error(`"${record.name ?? botId}" has no trading inputs yet - set the quantity, width, strike offsets and expected credit in Settings > Bot inputs.`);
  } else {
    const factory = STATIC_CONFIGS[botId];
    if (!factory) throw new Error(`Unknown bot "${botId}".`);
    config = factory();
  }
  if (record?.name) config = { ...config, name: record.name };
  if (record?.safeguards?.allocationLimit != null) config = { ...config, allocationLimit: record.safeguards.allocationLimit };
  checkBotConfig(config);
  return config;
}

export interface BotLimits {
  dailyNewPositionLimit: number;
  /** Dollars; 0 = off. */
  dailyLossLimit: number;
  totalPositionLimit: number;
  maxPositionsPerType: number;
  dayTradingAllowed: boolean;
}

/** Position limits, per bot, falling back to the global env defaults. */
export function getBotLimits(botId: string): BotLimits {
  const sg = botsStore.get(botId)?.safeguards ?? {};
  // The bot's own default (SPX 3, NDX 1) sits between a safeguard set on it and the global default.
  let own: number | undefined;
  try {
    own = getBotStaticConfig(botId).totalPositionLimit;
  } catch {
    /* a bot still waiting for its inputs has no limit of its own */
  }
  const limits = {
    dailyNewPositionLimit: sg.dailyNewPositionLimit ?? DAILY_NEW_POSITION_LIMIT,
    dailyLossLimit: sg.dailyLossLimit ?? dailyLossLimitDefault(),
    totalPositionLimit: sg.totalPositionLimit ?? own ?? TOTAL_POSITION_LIMIT,
    maxPositionsPerType: sg.maxPositionsPerType ?? MAX_POSITIONS_PER_TYPE,
    dayTradingAllowed: sg.dayTrading ?? true,
  };
  // The live bot's ceilings are in the code: no safeguard setting or environment default can raise them.
  if (botId === LIVE_BOT_ID) {
    limits.dailyNewPositionLimit = Math.min(limits.dailyNewPositionLimit, LIVE_LIMITS.maxTradesPerDay);
    limits.totalPositionLimit = Math.min(limits.totalPositionLimit, LIVE_LIMITS.maxOpenPositions);
    limits.maxPositionsPerType = Math.min(limits.maxPositionsPerType, LIVE_LIMITS.maxOpenPositions);
  }
  return limits;
}

/** Test-only escape hatch: registers an extra bot (e.g. a second bot sharing
 * an account, to exercise the cross-bot overlap check) without touching the
 * real registry above. */
export function __registerBotForTests(id: string, factory: () => BotStaticConfig): void {
  STATIC_CONFIGS[id] = factory;
}

/** Seeds the mutable store row the first time a bot is referenced. */
/** Built-in bots kept out of sight for now: they start archived (switched off, hidden from the lists, listed under
 * Settings > Bot Archive, where Restore brings them back). Once someone restores one, `archived: false` is saved on its
 * record and it stays visible. Show it again for everyone with BOT_SPX_EMA_BIAS_HIDDEN=false. */
const HIDDEN_BOT_IDS: readonly string[] = ["spx_ema_bias"];

/** Whether a built-in bot starts hidden. Show it again for everyone with BOT_SPX_EMA_BIAS_HIDDEN=false. */
export const hiddenByDefault = (botId: string): boolean => HIDDEN_BOT_IDS.includes(botId) && envString(`BOT_${botId.replace(/_ema_bias$/, "").toUpperCase()}_EMA_BIAS_HIDDEN`, "true") !== "false";

export function ensureBotRecord(botId: string): Bot {
  const existing = botsStore.get(botId);
  if (existing) {
    // A record from before the bot was hidden: archive it once, unless someone has restored it on purpose.
    if (hiddenByDefault(botId) && existing.archived === undefined) {
      return botsStore.update(botId, { archived: true, enabled: false }) ?? existing;
    }
    return existing;
  }
  // A bot that can't trade yet starts switched off, so it never shows "ON" while unable to run.
  let ready = true;
  if (isBuiltInBot(botId)) {
    try {
      getBotStaticConfig(botId);
    } catch {
      ready = false;
    }
  }
  const hidden = hiddenByDefault(botId);
  // The live bot is born OFF, whatever its settings: only the live switch turns it on.
  const record: Bot = { id: botId, enabled: ready && !hidden && botId !== LIVE_BOT_ID, needsAttention: false, needsAttentionReason: null, createdAt: Date.now(), ...(hidden ? { archived: true } : {}) };
  return botsStore.insert(record);
}

// ---------------------------------------------------------------------------
// Validation and CRUD for bots made in the UI
// ---------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Every input is required - there are deliberately no defaults for the
 * trading parameters. Returns the first problem, or null when valid. */
export function validateInputs(i: Partial<BotInputs>): string | null {
  if (typeof i.name !== "string" || !i.name.trim()) return "Name is required.";
  if (typeof i.accountId !== "string" || !i.accountId.trim()) return "Account is required.";
  if (i.underlying !== "SPX" && i.underlying !== "NDX") return "Only SPX and NDX are supported.";
  if (!isNum(i.quantity) || !Number.isInteger(i.quantity) || i.quantity < 1) return "Quantity must be a whole number of at least 1.";
  if (!isNum(i.strikeIncrement) || i.strikeIncrement <= 0) return "Strike increment must be greater than 0.";
  if (!isNum(i.widthPoints) || i.widthPoints <= 0) return "Spread width must be greater than 0.";
  if (i.widthPoints % i.strikeIncrement !== 0) return "Spread width must be a multiple of the strike increment.";
  if (!isNum(i.putShortOffset)) return "Short put offset is required (signed points from the signal price).";
  if (!isNum(i.callShortOffset)) return "Short call offset is required (signed points from the signal price).";
  if (!isNum(i.allocationLimit) || i.allocationLimit <= 0) return "Allocation must be greater than 0.";
  if (!isNum(i.openingCreditEstimate) || i.openingCreditEstimate <= 0) return "Expected credit must be greater than 0.";
  if (i.openingCreditEstimate >= i.widthPoints) return "Expected credit must be less than the spread width.";
  try {
    checkBotConfig({ id: "check", ...(i as BotInputs) });
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid inputs.";
  }
  return null;
}

export function validateSafeguards(s: BotSafeguards): string | null {
  if (s.dayTrading !== undefined && typeof s.dayTrading !== "boolean") return "Day trading must be allowed or not allowed.";
  const checks: [keyof BotSafeguards, string][] = [
    ["allocationLimit", "Allocation"],
    ["dailyNewPositionLimit", "Daily positions"],
    ["totalPositionLimit", "Position limit"],
    ["maxPositionsPerType", "Positions per type"],
  ];
  for (const [key, label] of checks) {
    const v = s[key];
    if (v === undefined) continue;
    if (!isNum(v) || v <= 0 || (key !== "allocationLimit" && !Number.isInteger(v))) return `${label} must be a positive ${key === "allocationLimit" ? "number" : "whole number"}.`;
  }
  if (s.dailyLossLimit !== undefined && (!isNum(s.dailyLossLimit) || s.dailyLossLimit < 0)) return "Daily loss limit must be a number of dollars, 0 or more (0 turns it off).";
  return null;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "bot";
}

function newBotId(name: string): string {
  for (;;) {
    const id = `${slug(name)}_${crypto.randomBytes(2).toString("hex")}`;
    if (!isKnownBot(id) && !botsStore.get(id)) return id;
  }
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean))].slice(0, 20);
}

export interface CreateBotInput {
  inputs: BotInputs;
  group?: string | null;
  tags?: string[];
  safeguards?: BotSafeguards;
}

/** New bots start switched off: nothing should trade until someone turns it on. */
export function createBot(input: CreateBotInput): Bot {
  const problem = validateInputs(input.inputs) ?? (input.safeguards ? validateSafeguards(input.safeguards) : null);
  if (problem) throw new Error(problem);
  const name = input.inputs.name.trim();
  const record: Bot = {
    id: newBotId(name),
    enabled: false,
    needsAttention: false,
    needsAttentionReason: null,
    createdAt: Date.now(),
    name,
    group: input.group?.trim() || null,
    tags: cleanTags(input.tags),
    config: { ...input.inputs, name },
    safeguards: input.safeguards,
    triggers: { bullish: true, bearish: true },
    alerts: { ...DEFAULT_ALERTS },
  };
  return botsStore.insert(record);
}

export interface NewBotBasics {
  name: string;
  accountId: string;
  allocationLimit: number;
  group?: string | null;
  tags?: string[];
}

function validateBasics(b: NewBotBasics): string | null {
  if (typeof b.name !== "string" || !b.name.trim()) return "Name is required.";
  if (typeof b.accountId !== "string" || !b.accountId.trim()) return "Account is required.";
  if (!isNum(b.allocationLimit) || b.allocationLimit <= 0) return "Allocation must be greater than 0.";
  return null;
}

/** "Empty bot": name, account and allocation only. It starts switched off and
 * can't trade until its required inputs are entered - nothing is guessed. */
export function createEmptyBot(b: NewBotBasics): Bot {
  const problem = validateBasics(b);
  if (problem) throw new Error(problem);
  const name = b.name.trim();
  return botsStore.insert({
    id: newBotId(name),
    enabled: false,
    needsAttention: false,
    needsAttentionReason: null,
    createdAt: Date.now(),
    name,
    group: b.group?.trim() || null,
    tags: cleanTags(b.tags),
    draftInputs: { name, accountId: b.accountId.trim(), underlying: "SPX", allocationLimit: b.allocationLimit },
    triggers: { bullish: true, bearish: true },
    alerts: { ...DEFAULT_ALERTS },
  });
}

/** A bot from a saved template: the template's inputs and safeguards, with its
 * own name, account and allocation. Ready to trade once switched on. */
export function createFromTemplate(templateId: string, b: NewBotBasics): Bot {
  const template = templatesStore.get(templateId);
  if (!template) throw new Error("Template not found.");
  const problem = validateBasics(b);
  if (problem) throw new Error(problem);
  return createBot({
    inputs: { ...template.config, name: b.name.trim(), accountId: b.accountId.trim(), allocationLimit: b.allocationLimit },
    group: b.group,
    tags: b.tags,
    safeguards: template.safeguards ? { ...template.safeguards, allocationLimit: undefined } : undefined,
  });
}

export interface BotPatch {
  name?: string;
  group?: string | null;
  tags?: string[];
  notes?: string;
  archived?: boolean;
  inputs?: BotInputs;
  safeguards?: BotSafeguards;
  triggers?: { bullish: boolean; bearish: boolean };
  alwaysOn?: { bullish: boolean; bearish: boolean };
  /** Replaces the check(s) given for each direction; a direction or slot left out keeps what it had. `null` returns a slot to the default. */
  positionChecks?: Partial<Record<"bullish" | "bearish", Partial<Record<"close" | "open", PositionCheck | null>>>>;
  /** Replaces the Open Position settings of the direction(s) given; null returns that trigger to the bot's own inputs. */
  openSettings?: Partial<Record<"bullish" | "bearish", OpenSettings | null>>;
  /** Replaces the Memo and Tags of the direction(s) given. */
  closeSettings?: Partial<Record<"bullish" | "bearish", { memo?: string; tags?: string[]; pricing?: ClosePricing | null; quantity?: CloseQuantity | null }>>;
  monitors?: Partial<Record<MonitorKey, Partial<CloseMonitorSettings>>>;
  alerts?: Partial<Bot["alerts"]>;
  accountId?: string;
  /** Pullback exit and chain settings (the two Bybit bots, each its own; ignored for every other bot). */
  pullback?: NonNullable<Bot["pullback"]>;
}

export function updateBot(botId: string, patch: BotPatch): Bot {
  if (!isKnownBot(botId)) throw new Error(`Unknown bot "${botId}".`);
  const record = ensureBotRecord(botId);
  const next: Partial<Bot> = {};

  if (patch.inputs !== undefined) {
    const problem = validateInputs(patch.inputs);
    if (problem) throw new Error(problem);
    next.config = { ...patch.inputs, name: (patch.name ?? record.name ?? patch.inputs.name).trim() };
    next.draftInputs = undefined; // the full inputs replace the placeholder
  }
  if (patch.accountId !== undefined) {
    if (!patch.accountId.trim()) throw new Error("Account is required.");
    const account = patch.accountId.trim();
    if (!next.config && !record.config && record.draftInputs) {
      next.draftInputs = { ...record.draftInputs, accountId: account };
    } else {
      const base = next.config ?? record.config ?? getBotStaticConfig(botId);
      const { id: _id, ...rest } = base as BotInputs & { id?: string };
      next.config = { ...rest, accountId: account };
    }
  }
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error("Name is required.");
    next.name = patch.name.trim();
    if (next.config) next.config = { ...next.config, name: next.name };
    else if (record.config) next.config = { ...record.config, name: next.name };
    else if (record.draftInputs || next.draftInputs) next.draftInputs = { ...(next.draftInputs ?? record.draftInputs), name: next.name };
  }
  if (patch.group !== undefined) next.group = patch.group?.trim() || null;
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.notes !== undefined) next.notes = patch.notes.slice(0, 5000);
  if (patch.safeguards !== undefined) {
    const problem = validateSafeguards(patch.safeguards);
    if (problem) throw new Error(problem);
    next.safeguards = patch.safeguards;
    // A bot still waiting for its inputs keeps its allocation in the placeholder.
    const draft = next.draftInputs ?? (record.config ? undefined : record.draftInputs);
    if (draft && patch.safeguards.allocationLimit != null) next.draftInputs = { ...draft, allocationLimit: patch.safeguards.allocationLimit };
  }
  if (patch.triggers !== undefined) next.triggers = patch.triggers;
  if (patch.monitors !== undefined) {
    const merged: NonNullable<Bot["monitors"]> = { ...record.monitors };
    for (const key of ["bullishClose", "bearishClose"] as const) {
      const change = patch.monitors[key];
      if (!change) continue;
      const before = merged[key] ?? { enabled: false };
      merged[key] = {
        enabled: change.enabled ?? before.enabled,
        ...(change.memo !== undefined ? (change.memo.trim() ? { memo: change.memo.trim().slice(0, 500) } : {}) : before.memo ? { memo: before.memo } : {}),
        ...(change.tags !== undefined ? { tags: cleanTags(change.tags) } : before.tags ? { tags: before.tags } : {}),
      };
    }
    next.monitors = merged;
  }
  if (patch.positionChecks !== undefined) {
    const merged: PositionChecks = { bullish: { ...record.positionChecks?.bullish }, bearish: { ...record.positionChecks?.bearish } };
    for (const dir of ["bullish", "bearish"] as const) {
      for (const slot of ["close", "open"] as const) {
        const change = patch.positionChecks[dir]?.[slot];
        if (change === undefined) continue;
        if (change === null) {
          delete merged[dir]![slot];
          continue;
        }
        const checked = validateCheck(change);
        if (!checked.ok) throw new Error(checked.reason);
        merged[dir]![slot] = checked.check;
      }
    }
    next.positionChecks = merged;
  }
  if (patch.openSettings !== undefined) {
    const merged: NonNullable<Bot["openSettings"]> = { ...record.openSettings };
    for (const dir of ["bullish", "bearish"] as const) {
      const change = patch.openSettings[dir];
      if (change === undefined) continue;
      if (change === null) {
        delete merged[dir];
        continue;
      }
      const checked = validateOpenSettings(change);
      if (!checked.ok) throw new Error(checked.reason);
      merged[dir] = checked.value;
    }
    next.openSettings = merged;
  }
  if (patch.closeSettings !== undefined) {
    const merged: NonNullable<Bot["closeSettings"]> = { ...record.closeSettings };
    for (const dir of ["bullish", "bearish"] as const) {
      const change = patch.closeSettings[dir];
      if (!change) continue;
      const memo = typeof change.memo === "string" ? change.memo.trim().slice(0, 500) : "";
      const tags = cleanTags(change.tags);
      // `pricing` left out keeps what was saved; null returns the step to the bot's own pricing.
      let pricing = merged[dir]?.pricing;
      if (change.pricing === null) pricing = undefined;
      else if (change.pricing !== undefined) {
        const checked = validateClosePricing(change.pricing);
        if (!checked.ok) throw new Error(checked.reason);
        pricing = checked.pricing;
      }
      let quantity = merged[dir]?.quantity;
      if (change.quantity === null) quantity = undefined;
      else if (change.quantity !== undefined) {
        const checked = validateCloseQuantity(change.quantity);
        if (!checked.ok) throw new Error(checked.reason);
        quantity = checked.quantity;
      }
      merged[dir] = { ...(memo ? { memo } : {}), ...(tags.length ? { tags } : {}), ...(pricing ? { pricing } : {}), ...(quantity ? { quantity } : {}) };
    }
    next.closeSettings = merged;
  }
  if (patch.alwaysOn !== undefined) next.alwaysOn = { bullish: patch.alwaysOn.bullish !== false, bearish: patch.alwaysOn.bearish !== false };
  if (patch.alerts !== undefined) next.alerts = { ...DEFAULT_ALERTS, ...record.alerts, ...patch.alerts };
  if (patch.pullback !== undefined) {
    // The pullback exit and the chain mode exist for the two Bybit bots (the demo bot and the live bot), each with its own saved values. Any other bot refuses them.
    if (botId !== BTC_BOT_ID && botId !== LIVE_BOT_ID) throw new Error("The pullback exit and the chain mode are for the two Bybit bots only.");
    const p = patch.pullback;
    const num = (name: string, v: unknown, min: number, max: number, whole = false): number => {
      if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (whole && !Number.isInteger(v))) throw new Error(`${name} must be ${whole ? "a whole number" : "a number"} from ${min} to ${max}.`);
      return v;
    };
    const clean: NonNullable<Bot["pullback"]> = {};
    if (p.enabled !== undefined) clean.enabled = p.enabled === true;
    if (p.chainEnabled !== undefined) clean.chainEnabled = p.chainEnabled === true;
    if (p.fallUsd !== undefined) clean.fallUsd = num("The fall", p.fallUsd, 0.001, 5);
    if (p.minPeakUsd !== undefined) clean.minPeakUsd = num("The minimum peak", p.minPeakUsd, 0, 10);
    if (p.chainStopUsd !== undefined) clean.chainStopUsd = num("The chain stop", p.chainStopUsd, 0.001, 5);
    if (p.chainMax !== undefined) clean.chainMax = num("The chain cap", p.chainMax, 1, 50, true);
    next.pullback = { ...record.pullback, ...clean };
    if (next.pullback.chainEnabled !== true) next.chainState = undefined; // switching the chain off ends the running one
  }
  if (patch.archived !== undefined) {
    next.archived = patch.archived;
    // Archiving also switches the bot off, so it can never act while hidden.
    if (patch.archived) next.enabled = false;
  }

  return botsStore.update(botId, next) ?? record;
}

/** A disabled copy with the same inputs, safeguards and labels - no history.
 * A bot that is still waiting for its inputs is cloned as such. */
export function cloneBot(botId: string, overrides: Partial<NewBotBasics> = {}): Bot {
  const record = ensureBotRecord(botId);
  const baseName = record.name ?? (isBuiltInBot(botId) ? getBotStaticConfig(botId).name : botId);
  const name = overrides.name?.trim() || `${baseName} copy`;

  if (!record.config && record.draftInputs) {
    return createEmptyBot({
      name,
      accountId: overrides.accountId ?? record.draftInputs.accountId ?? "",
      allocationLimit: overrides.allocationLimit ?? record.draftInputs.allocationLimit ?? 0,
      group: record.group,
      tags: record.tags,
    });
  }

  const source = getBotStaticConfig(botId);
  const { id: _id, ...inputs } = source;
  return createBot({
    inputs: {
      ...inputs,
      name,
      ...(overrides.accountId ? { accountId: overrides.accountId.trim() } : {}),
      ...(overrides.allocationLimit != null ? { allocationLimit: overrides.allocationLimit } : {}),
    },
    group: record.group,
    tags: record.tags,
    safeguards: record.safeguards ? { ...record.safeguards, ...(overrides.allocationLimit != null ? { allocationLimit: undefined } : {}) } : undefined,
  });
}

export function saveTemplate(botId: string, name: string): BotTemplate {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Template name is required.");
  const { id: _id, ...config } = getBotStaticConfig(botId);
  const template: BotTemplate = {
    id: `tpl_${crypto.randomBytes(4).toString("hex")}`,
    name: trimmed,
    config,
    safeguards: botsStore.get(botId)?.safeguards,
    createdAt: Date.now(),
  };
  return templatesStore.insert(template);
}

/** Removes a bot and everything recorded for it. The built-in bot is defined
 * in code and can only be archived; a bot with a live position can't go. */
export function deleteBot(botId: string): void {
  if (isBuiltInBot(botId)) throw new Error("The built-in bot can't be deleted - archive it instead.");
  if (!isUserBot(botsStore.get(botId))) throw new Error(`Unknown bot "${botId}".`);
  if (positionsStore.query((p) => p.botId === botId && ACTIVE_POSITION_STATUSES.includes(p.status)).length > 0) {
    throw new Error("This bot still has an open position. Close it first.");
  }
  const positionIds = new Set(positionsStore.query((p) => p.botId === botId).map((p) => p.id));
  ordersStore.removeWhere((o) => positionIds.has(o.positionId));
  positionsStore.removeWhere((p) => p.botId === botId);
  decisionsStore.removeWhere((d) => d.botId === botId);
  signalsStore.removeWhere((s) => s.botId === botId);
  errorsStore.removeWhere((e) => e.botId === botId);
  runsStore.removeWhere((r) => r.botId === botId);
  alertsStore.removeWhere((a) => a.botId === botId);
  webhooksStore.removeWhere((w) => w.botId === botId);
  botsStore.remove(botId);
}
