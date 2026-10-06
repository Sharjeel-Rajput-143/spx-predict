import "server-only";
import crypto from "node:crypto";
import { SMART_PRICING_MODES, type SmartPricingMode } from "./smartPricing";
import { DAILY_NEW_POSITION_LIMIT, MAX_POSITIONS_PER_TYPE, TOTAL_POSITION_LIMIT, envNumber, envString, parseClockMinutes, requiredEnvNumber } from "./config";
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
  type Bot,
  type BotInputs,
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

const CREDIT_TODO =
  "Phase 1 has no real option chain, so the engine needs a configured expected opening " +
  "credit per spread (used for the allocation-limit check and the order's limit price). " +
  "See .env.example's TODO - the spec's $2.20 is an example, not a confirmed live value.";

/** Env vars the NDX bot cannot start without. Each is a real trading or safety
 * parameter that must come from Blue or the broker's option chain - never a guess. */
const NDX_REQUIRED: { key: string; why: string }[] = [
  { key: "BOT_NDX_EMA_BIAS_STRIKE_INCREMENT", why: "confirm the real strike increment near the money from the NDX option chain" },
  { key: "BOT_NDX_EMA_BIAS_OPENING_CREDIT_ESTIMATE", why: "expected credit per spread, must be below the 10 point width" },
  { key: "BOT_NDX_EMA_BIAS_PRICE_MIN", why: "lowest NDX level a real signal can carry (sanity range)" },
  { key: "BOT_NDX_EMA_BIAS_PRICE_MAX", why: "highest NDX level a real signal can carry (sanity range)" },
  { key: "BOT_NDX_EMA_BIAS_EOD_SWEEP_TIME", why: "HH:MM ET after the confirmed final trading time of the NDX series" },
];

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

/** Names of the built-in bots, known even while their settings are incomplete. */
const BUILT_IN_NAMES: Record<string, string> = {
  spx_ema_bias: "SPX EMA 9/20 Bias",
  ndx_ema_bias: "NDX EMA 9/20 Bias",
};

export const botDisplayName = (botId: string): string => botsStore.get(botId)?.name ?? BUILT_IN_NAMES[botId] ?? botId;

/** NDX is a second bot row driven by config, not forked code. Names every
 * missing required value at once so one look at the error is enough. */
function ndxConfig(): BotStaticConfig {
  const missing = NDX_REQUIRED.filter(({ key }) => !process.env[key]);
  if (missing.length > 0) {
    throw new MissingSettingsError(
      missing,
      `NDX bot cannot start - required setting${missing.length === 1 ? "" : "s"} not set: ` +
        missing.map((m) => `${m.key} (${m.why})`).join("; ") +
        ". These have no defaults on purpose - see .env.example.",
    );
  }
  const need = (key: string) => requiredEnvNumber(key, "");
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
    strikeIncrement: need("BOT_NDX_EMA_BIAS_STRIKE_INCREMENT"),
    // Mirrors the live SPX bot (short strike 0.01 beyond the price, i.e. the first strike at or beyond it).
    // TODO(owner to confirm for NDX): these defaults are the SPX bot's, not a value anyone chose for NDX.
    putShortOffset: envNumber("BOT_NDX_EMA_BIAS_PUT_SHORT_OFFSET", -0.01),
    callShortOffset: envNumber("BOT_NDX_EMA_BIAS_CALL_SHORT_OFFSET", 0.01),
    ...pricingAndLimits("BOT_NDX_EMA_BIAS", 1),
    allocationLimit: envNumber("BOT_NDX_EMA_BIAS_ALLOCATION_LIMIT", 2000),
    openingCreditEstimate: need("BOT_NDX_EMA_BIAS_OPENING_CREDIT_ESTIMATE"),
    eodSweepTime: process.env.BOT_NDX_EMA_BIAS_EOD_SWEEP_TIME,
    priceRange: { min: need("BOT_NDX_EMA_BIAS_PRICE_MIN"), max: need("BOT_NDX_EMA_BIAS_PRICE_MAX") },
    ...(hoursStart && hoursEnd ? { hours: { start: hoursStart, end: hoursEnd } } : {}),
  };
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
  if (c.eodSweepTime) parseClockMinutes(c.eodSweepTime, "End-of-day sweep time");
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
    openingCreditEstimate: requiredEnvNumber("BOT_SPX_EMA_BIAS_OPENING_CREDIT_ESTIMATE", CREDIT_TODO),
  }),
  ndx_ema_bias: ndxConfig,
};

export function isBuiltInBot(botId: string): boolean {
  return botId in STATIC_CONFIGS;
}

const isUserBot = (b: Bot | undefined): b is Bot => !!b && (!!b.config || !!b.draftInputs);

export function listBotIds(): string[] {
  const ids = new Set(Object.keys(STATIC_CONFIGS));
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
  return isBuiltInBot(botId) || isUserBot(botsStore.get(botId));
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
  return {
    dailyNewPositionLimit: sg.dailyNewPositionLimit ?? DAILY_NEW_POSITION_LIMIT,
    totalPositionLimit: sg.totalPositionLimit ?? own ?? TOTAL_POSITION_LIMIT,
    maxPositionsPerType: sg.maxPositionsPerType ?? MAX_POSITIONS_PER_TYPE,
    dayTradingAllowed: sg.dayTrading ?? true,
  };
}

/** Test-only escape hatch: registers an extra bot (e.g. a second bot sharing
 * an account, to exercise the cross-bot overlap check) without touching the
 * real registry above. */
export function __registerBotForTests(id: string, factory: () => BotStaticConfig): void {
  STATIC_CONFIGS[id] = factory;
}

/** Seeds the mutable store row the first time a bot is referenced. */
export function ensureBotRecord(botId: string): Bot {
  const existing = botsStore.get(botId);
  if (existing) return existing;
  // A bot that can't trade yet starts switched off, so it never shows "ON" while unable to run.
  let ready = true;
  if (isBuiltInBot(botId)) {
    try {
      getBotStaticConfig(botId);
    } catch {
      ready = false;
    }
  }
  const record: Bot = { id: botId, enabled: ready, needsAttention: false, needsAttentionReason: null, createdAt: Date.now() };
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
  alerts?: Partial<Bot["alerts"]>;
  accountId?: string;
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
  if (patch.alerts !== undefined) next.alerts = { ...DEFAULT_ALERTS, ...record.alerts, ...patch.alerts };
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
