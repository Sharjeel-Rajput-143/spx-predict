import { beforeEach, describe, expect, it } from "vitest";
import { cloneBot, createBot, createEmptyBot, createFromTemplate, deleteBot, getBotLimits, getBotStaticConfig, isKnownBot, listBotIds, saveTemplate, updateBot, validateInputs } from "./bots";
import { botsStore, decisionsStore, positionsStore, signalsStore, templatesStore } from "./store";
import { TEST_BOT_ID, buildPosition, resetAutomationStores, setTestBotEnv } from "./testSupport";
import type { BotInputs } from "./types";

setTestBotEnv();

const inputs = (over: Partial<BotInputs> = {}): BotInputs => ({
  name: "Iron Test",
  accountId: "paper-2",
  underlying: "SPX",
  quantity: 2,
  widthPoints: 10,
  strikeIncrement: 5,
  putShortOffset: -25,
  callShortOffset: 30,
  allocationLimit: 10000,
  openingCreditEstimate: 3,
  ...over,
});

beforeEach(() => resetAutomationStores());

describe("validateInputs", () => {
  it("accepts a complete, consistent set", () => {
    expect(validateInputs(inputs())).toBeNull();
  });

  it.each([
    ["a blank name", { name: " " }],
    ["a missing short put offset", { putShortOffset: undefined }],
    ["a missing short call offset", { callShortOffset: undefined }],
    ["a missing expected credit", { openingCreditEstimate: undefined }],
    ["a width that isn't a multiple of the increment", { widthPoints: 7 }],
    ["a credit at or above the width", { openingCreditEstimate: 10 }],
    ["a fractional quantity", { quantity: 1.5 }],
    ["a non-SPX underlying", { underlying: "NDX" as "SPX" }],
  ])("rejects %s - no hidden defaults", (_label, over) => {
    expect(validateInputs({ ...inputs(), ...over } as Partial<BotInputs>)).not.toBeNull();
  });
});

describe("createBot", () => {
  it("creates a switched-off bot the engine and webhook can see", () => {
    const bot = createBot({ inputs: inputs(), tags: [" spx ", "spx", "0dte"], group: "Income" });
    expect(bot.enabled).toBe(false);
    expect(bot.tags).toEqual(["spx", "0dte"]);
    expect(isKnownBot(bot.id)).toBe(true);
    expect(listBotIds()).toContain(bot.id);
    expect(getBotStaticConfig(bot.id)).toMatchObject({ name: "Iron Test", widthPoints: 10, putShortOffset: -25 });
  });

  it("refuses an invalid bot", () => {
    expect(() => createBot({ inputs: inputs({ widthPoints: 7 }) })).toThrow(/multiple/);
  });
});

describe("updateBot", () => {
  it("lets edited inputs of the built-in bot override env", () => {
    updateBot(TEST_BOT_ID, { inputs: inputs({ name: "Edited", quantity: 5 }) });
    expect(getBotStaticConfig(TEST_BOT_ID)).toMatchObject({ name: "Edited", quantity: 5, widthPoints: 10 });
  });

  it("applies a per-bot allocation override and position limits, falling back to defaults", () => {
    expect(getBotLimits(TEST_BOT_ID).dailyNewPositionLimit).toBe(10);
    updateBot(TEST_BOT_ID, { safeguards: { allocationLimit: 5000, dailyNewPositionLimit: 2 } });
    expect(getBotStaticConfig(TEST_BOT_ID).allocationLimit).toBe(5000);
    expect(getBotLimits(TEST_BOT_ID)).toMatchObject({ dailyNewPositionLimit: 2, totalPositionLimit: 1 });
  });

  it("archiving switches the bot off", () => {
    botsStore.insert({ id: TEST_BOT_ID, enabled: true, needsAttention: false, needsAttentionReason: null, createdAt: 0 });
    updateBot(TEST_BOT_ID, { archived: true });
    expect(botsStore.get(TEST_BOT_ID)).toMatchObject({ archived: true, enabled: false });
  });

  it("rejects invalid safeguards", () => {
    expect(() => updateBot(TEST_BOT_ID, { safeguards: { dailyNewPositionLimit: 0 } })).toThrow();
  });
});

describe("cloneBot and templates", () => {
  it("clones inputs into a new, switched-off bot", () => {
    const clone = cloneBot(TEST_BOT_ID);
    expect(clone.id).not.toBe(TEST_BOT_ID);
    expect(clone.enabled).toBe(false);
    expect(getBotStaticConfig(clone.id)).toMatchObject({ name: "SPX EMA 9/20 Bias copy", quantity: 3 });
  });

  it("saves a template that can seed a new bot", () => {
    const tpl = saveTemplate(TEST_BOT_ID, "Weekly 5-wide");
    expect(templatesStore.all()).toHaveLength(1);
    const bot = createBot({ inputs: { ...tpl.config, name: "From template" } });
    expect(getBotStaticConfig(bot.id).widthPoints).toBe(5);
  });
});

describe("deleteBot", () => {
  it("removes the bot and everything recorded for it", () => {
    const bot = createBot({ inputs: inputs() });
    positionsStore.insert(buildPosition({ type: "short_put_spread", status: "closed", botId: bot.id }));
    decisionsStore.insert({ id: "d1", signalId: null, botId: bot.id, outcome: "opened", reason: "x", detail: {}, createdAt: 1 });
    signalsStore.insert({ id: "s1", botId: bot.id, signal: "bullish", barTime: "b", price: 1, interval: "5", receivedAt: 1, status: "accepted", raw: {} });
    deleteBot(bot.id);
    expect(isKnownBot(bot.id)).toBe(false);
    expect(positionsStore.all()).toHaveLength(0);
    expect(decisionsStore.all()).toHaveLength(0);
    expect(signalsStore.all()).toHaveLength(0);
  });

  it("refuses while a position is still live", () => {
    const bot = createBot({ inputs: inputs() });
    positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open", botId: bot.id }));
    expect(() => deleteBot(bot.id)).toThrow(/open position/);
  });

  it("never deletes the built-in bot", () => {
    expect(() => deleteBot(TEST_BOT_ID)).toThrow(/archive/);
  });
});

describe("empty bots (name, account, allocation only)", () => {
  it("creates a known, switched-off bot that can't trade until its inputs are entered", () => {
    const bot = createEmptyBot({ name: "  Blank  ", accountId: "paper-1", allocationLimit: 1000 });
    expect(bot).toMatchObject({ name: "Blank", enabled: false, draftInputs: { accountId: "paper-1", allocationLimit: 1000 } });
    expect(isKnownBot(bot.id)).toBe(true);
    expect(listBotIds()).toContain(bot.id);
    // Required inputs are never defaulted: asking for its config says what's missing.
    expect(() => getBotStaticConfig(bot.id)).toThrow(/no trading inputs yet/);
  });

  it("validates the three fields", () => {
    expect(() => createEmptyBot({ name: " ", accountId: "p", allocationLimit: 1000 })).toThrow(/Name/);
    expect(() => createEmptyBot({ name: "x", accountId: " ", allocationLimit: 1000 })).toThrow(/Account/);
    expect(() => createEmptyBot({ name: "x", accountId: "p", allocationLimit: 0 })).toThrow(/Allocation/);
    expect(() => createEmptyBot({ name: "x", accountId: "p", allocationLimit: Number.NaN })).toThrow(/Allocation/);
  });

  it("becomes a normal bot once the full inputs are saved, and the placeholder is gone", () => {
    const bot = createEmptyBot({ name: "Blank", accountId: "paper-1", allocationLimit: 1000 });
    updateBot(bot.id, { inputs: inputs({ name: "Blank" }) });
    expect(getBotStaticConfig(bot.id)).toMatchObject({ widthPoints: 10, putShortOffset: -25 });
    expect(botsStore.get(bot.id)?.draftInputs).toBeUndefined();
  });

  it("an account change and a rename land in the placeholder; incomplete inputs are still rejected", () => {
    const bot = createEmptyBot({ name: "Blank", accountId: "paper-1", allocationLimit: 1000 });
    updateBot(bot.id, { accountId: "paper-2", name: "Renamed" });
    expect(botsStore.get(bot.id)?.draftInputs).toMatchObject({ accountId: "paper-2", name: "Renamed" });
    expect(() => updateBot(bot.id, { inputs: inputs({ putShortOffset: undefined as unknown as number }) })).toThrow(/offset/i);
  });

  it("can be cloned (as another empty bot, with new basics) and deleted", () => {
    const bot = createEmptyBot({ name: "Blank", accountId: "paper-1", allocationLimit: 1000 });
    const copy = cloneBot(bot.id, { name: "Blank 2", allocationLimit: 2500 });
    expect(botsStore.get(copy.id)?.draftInputs).toMatchObject({ name: "Blank 2", allocationLimit: 2500, accountId: "paper-1" });
    deleteBot(copy.id);
    expect(isKnownBot(copy.id)).toBe(false);
  });
});

describe("clone and template with their own basics", () => {
  it("a clone takes the new name, account and allocation but keeps the trading inputs", () => {
    const clone = cloneBot(TEST_BOT_ID, { name: "Live copy", accountId: "live-9", allocationLimit: 5000 });
    expect(getBotStaticConfig(clone.id)).toMatchObject({ name: "Live copy", accountId: "live-9", allocationLimit: 5000, quantity: 3, widthPoints: 5 });
    expect(clone.enabled).toBe(false);
  });

  it("a bot from a template is complete and ready, with its own basics", () => {
    const tpl = saveTemplate(TEST_BOT_ID, "Weekly");
    const bot = createFromTemplate(tpl.id, { name: "From tpl", accountId: "paper-5", allocationLimit: 7000 });
    expect(getBotStaticConfig(bot.id)).toMatchObject({ name: "From tpl", accountId: "paper-5", allocationLimit: 7000, widthPoints: 5 });
    expect(() => createFromTemplate("missing", { name: "x", accountId: "p", allocationLimit: 1 })).toThrow(/not found/);
  });
});
