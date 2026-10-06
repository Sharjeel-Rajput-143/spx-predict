import "server-only";
import crypto from "node:crypto";
import { DAILY_NEW_POSITION_LIMIT, MAX_POSITIONS_PER_TYPE, TOTAL_POSITION_LIMIT, envNumber, envString, requiredEnvNumber } from "./config";
import {
  botsStore,
  decisionsStore,
  errorsStore,
  ordersStore,
  positionsStore,
  runsStore,
  signalsStore,
  templatesStore,
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

const OFFSET_TODO =
  "This is a required trading parameter with no safe default - see .env.example's TODO " +
  "asking Sharjeel for the real value used by the live Option Alpha bot. Do not guess it.";

const CREDIT_TODO =
  "Phase 1 has no real option chain, so the engine needs a configured expected opening " +
  "credit per spread (used for the allocation-limit check and the order's limit price). " +
  "See .env.example's TODO - the spec's $2.20 is an example, not a confirmed live value.";

/** The built-in bot: its inputs come from env. Each factory re-reads env on
 * every call so a required-but-missing var only throws when the bot is
 * actually used, not at module import time. */
const STATIC_CONFIGS: Record<string, () => BotStaticConfig> = {
  spx_ema_bias: () => ({
    id: "spx_ema_bias",
    name: "SPX EMA 9/20 Bias",
    accountId: envString("BOT_SPX_EMA_BIAS_ACCOUNT_ID", "paper-1"),
    underlying: "SPX",
    quantity: envNumber("BOT_SPX_EMA_BIAS_QUANTITY", 3),
    widthPoints: envNumber("BOT_SPX_EMA_BIAS_WIDTH_POINTS", 5),
    strikeIncrement: envNumber("BOT_SPX_EMA_BIAS_STRIKE_INCREMENT", 5),
    putShortOffset: requiredEnvNumber("BOT_SPX_EMA_BIAS_PUT_SHORT_OFFSET", OFFSET_TODO),
    callShortOffset: requiredEnvNumber("BOT_SPX_EMA_BIAS_CALL_SHORT_OFFSET", OFFSET_TODO),
    allocationLimit: envNumber("BOT_SPX_EMA_BIAS_ALLOCATION_LIMIT", 20000),
    openingCreditEstimate: requiredEnvNumber("BOT_SPX_EMA_BIAS_OPENING_CREDIT_ESTIMATE", CREDIT_TODO),
  }),
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
  return {
    dailyNewPositionLimit: sg.dailyNewPositionLimit ?? DAILY_NEW_POSITION_LIMIT,
    totalPositionLimit: sg.totalPositionLimit ?? TOTAL_POSITION_LIMIT,
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
  const record: Bot = { id: botId, enabled: true, needsAttention: false, needsAttentionReason: null, createdAt: Date.now() };
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
  if (i.underlying !== "SPX") return "Only SPX is supported.";
  if (!isNum(i.quantity) || !Number.isInteger(i.quantity) || i.quantity < 1) return "Quantity must be a whole number of at least 1.";
  if (!isNum(i.strikeIncrement) || i.strikeIncrement <= 0) return "Strike increment must be greater than 0.";
  if (!isNum(i.widthPoints) || i.widthPoints <= 0) return "Spread width must be greater than 0.";
  if (i.widthPoints % i.strikeIncrement !== 0) return "Spread width must be a multiple of the strike increment.";
  if (!isNum(i.putShortOffset)) return "Short put offset is required (signed points from the signal price).";
  if (!isNum(i.callShortOffset)) return "Short call offset is required (signed points from the signal price).";
  if (!isNum(i.allocationLimit) || i.allocationLimit <= 0) return "Allocation must be greater than 0.";
  if (!isNum(i.openingCreditEstimate) || i.openingCreditEstimate <= 0) return "Expected credit must be greater than 0.";
  if (i.openingCreditEstimate >= i.widthPoints) return "Expected credit must be less than the spread width.";
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
  botsStore.remove(botId);
  runsStore.removeWhere((r) => r.botId === botId);
}
