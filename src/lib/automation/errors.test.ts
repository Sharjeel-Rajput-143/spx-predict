import { beforeEach, describe, expect, it } from "vitest";
import { ensureBotRecord } from "./bots";
import { countTodayErrors, recordError } from "./errors";
import { botsStore, __resetAllStores } from "./store";

const BOT_ID = "test_bot";
const DAY_1 = Date.UTC(2026, 9, 6, 14, 0); // Tuesday
const DAY_2 = Date.UTC(2026, 9, 7, 14, 0); // Wednesday

describe("error failsafe", () => {
  beforeEach(() => {
    __resetAllStores();
    ensureBotRecord(BOT_ID);
  });

  it("stays enabled below the threshold", () => {
    for (let i = 0; i < 9; i++) recordError(BOT_ID, "invalid_strikes", { i }, DAY_1);
    expect(countTodayErrors(BOT_ID, DAY_1)).toBe(9);
    expect(botsStore.get(BOT_ID)?.enabled).toBe(true);
  });

  it("switches off and sets needs_attention on the 10th error of the day", () => {
    for (let i = 0; i < 10; i++) recordError(BOT_ID, "invalid_strikes", { i }, DAY_1);
    const bot = botsStore.get(BOT_ID);
    expect(bot?.enabled).toBe(false);
    expect(bot?.needsAttention).toBe(true);
    expect(bot?.needsAttentionReason).toMatch(/error_failsafe/);
  });

  it("resets the counter on the next trading day, but does not auto re-enable", () => {
    for (let i = 0; i < 10; i++) recordError(BOT_ID, "invalid_strikes", { i }, DAY_1);
    expect(botsStore.get(BOT_ID)?.enabled).toBe(false);

    recordError(BOT_ID, "invalid_strikes", { day: 2 }, DAY_2);
    expect(countTodayErrors(BOT_ID, DAY_2)).toBe(1);
    // Turning it back on is a manual, operator action (the status page toggle) -
    // the failsafe itself never flips enabled back to true.
    expect(botsStore.get(BOT_ID)?.enabled).toBe(false);
  });

  it("a further error on the same day trips it off again after a manual re-enable", () => {
    for (let i = 0; i < 10; i++) recordError(BOT_ID, "invalid_strikes", { i }, DAY_1);
    botsStore.update(BOT_ID, { enabled: true, needsAttention: false, needsAttentionReason: null });

    recordError(BOT_ID, "invalid_strikes", { extra: true }, DAY_1);
    expect(countTodayErrors(BOT_ID, DAY_1)).toBe(11);
    expect(botsStore.get(BOT_ID)?.enabled).toBe(false);
  });
});
