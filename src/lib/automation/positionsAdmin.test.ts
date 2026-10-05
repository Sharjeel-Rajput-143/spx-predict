import { beforeEach, describe, expect, it } from "vitest";
import { createBot, createEmptyBot, updateBot } from "./bots";
import { movePosition, updatePositionMeta } from "./positionsAdmin";
import { botsStore, decisionsStore, positionsStore } from "./store";
import { BASE_NOW, TEST_BOT_ID, buildPosition, resetAutomationStores, setTestBotEnv } from "./testSupport";
import type { BotInputs } from "./types";

setTestBotEnv(); // the built-in bot trades on account "test-account"

const inputs = (over: Partial<BotInputs> = {}): BotInputs => ({
  name: "Second",
  accountId: "test-account",
  underlying: "SPX",
  quantity: 1,
  widthPoints: 5,
  strikeIncrement: 5,
  putShortOffset: -20,
  callShortOffset: 20,
  allocationLimit: 10000,
  openingCreditEstimate: 2,
  ...over,
});

beforeEach(() => resetAutomationStores());

describe("updatePositionMeta", () => {
  it("cleans tags, saves notes, and leaves everything else alone", () => {
    const p = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open" }));
    const next = updatePositionMeta(p.id, { tags: [" a ", "a", "", "b"], notes: "watch the open" });
    expect(next).toMatchObject({ tags: ["a", "b"], notes: "watch the open", status: "open", shortStrike: p.shortStrike });
  });

  it("rejects an unknown position", () => {
    expect(() => updatePositionMeta("nope", { notes: "x" })).toThrow(/not found/);
  });
});

describe("movePosition", () => {
  it("reassigns an open position to another bot on the same account and logs it on both", () => {
    const target = createBot({ inputs: inputs() });
    const p = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open" }));
    const moved = movePosition(p.id, target.id, BASE_NOW);

    expect(moved.botId).toBe(target.id);
    expect(positionsStore.get(p.id)?.botId).toBe(target.id);
    const logs = decisionsStore.all().filter((d) => d.outcome === "position_moved");
    expect(logs.map((d) => d.botId).sort()).toEqual([TEST_BOT_ID, target.id].sort());
    expect(logs.find((d) => d.botId === target.id)?.reason).toMatch(/Moved in from/);
    expect(logs.find((d) => d.botId === TEST_BOT_ID)?.reason).toMatch(/Moved to Second/);
  });

  it.each(["closed", "expired", "opening", "closing", "rejected"] as const)("refuses a position that is %s", (status) => {
    const target = createBot({ inputs: inputs() });
    const p = positionsStore.insert(buildPosition({ type: "short_put_spread", status }));
    expect(() => movePosition(p.id, target.id)).toThrow(/open position can be moved/);
  });

  it("refuses a different account, an unknown, archived or not-yet-set-up bot, and the same bot", () => {
    const p = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open" }));
    const otherAccount = createBot({ inputs: inputs({ accountId: "paper-9" }) });
    expect(() => movePosition(p.id, otherAccount.id)).toThrow(/same account/);
    expect(() => movePosition(p.id, "ghost")).toThrow(/doesn't exist/);
    expect(() => movePosition(p.id, TEST_BOT_ID)).toThrow(/already on that bot/);

    const archived = createBot({ inputs: inputs() });
    updateBot(archived.id, { archived: true });
    expect(() => movePosition(p.id, archived.id)).toThrow(/archived/);

    const empty = createEmptyBot({ name: "Blank", accountId: "test-account", allocationLimit: 1000 });
    expect(() => movePosition(p.id, empty.id)).toThrow(/no trading inputs yet/);
    expect(positionsStore.get(p.id)?.botId).toBe(TEST_BOT_ID); // nothing moved
  });

  it("respects the target's position limits", () => {
    const target = createBot({ inputs: inputs() });
    positionsStore.insert(buildPosition({ type: "short_call_spread", status: "open", botId: target.id, id: "already-there" }));
    const p = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open" }));
    expect(() => movePosition(p.id, target.id)).toThrow(/position limit/);

    updateBot(target.id, { safeguards: { totalPositionLimit: 3, maxPositionsPerType: 1 } });
    positionsStore.update("already-there", { type: "short_put_spread", shortStrike: 7600, longStrike: 7595 });
    expect(() => movePosition(p.id, target.id)).toThrow(/most/);

    positionsStore.update("already-there", { type: "short_call_spread" });
    expect(movePosition(p.id, target.id).botId).toBe(target.id);
  });

  it("an unrelated bot record isn't created or changed by a refused move", () => {
    const p = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open" }));
    expect(() => movePosition(p.id, "ghost")).toThrow();
    expect(botsStore.get("ghost")).toBeUndefined();
  });
});
