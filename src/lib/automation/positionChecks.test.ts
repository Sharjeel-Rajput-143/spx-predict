import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtInFlow } from "@/components/automation/builder/builtin";
import { previewTrace } from "@/components/automation/builder/model";
import { botsStore, positionsStore, runsStore } from "./store";
import { ensureBotRecord, getBotStaticConfig, updateBot } from "./bots";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import { CHECK_OPS, checkHolds, defaultCheck, validateCheck } from "./positionChecks";
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import type { SignalDirection } from "./types";

setTestBotEnv();
setNdxTestEnv();
const executor = new MockExecutor();
const fast = { pollIntervalMs: 5, closeConfirmTimeoutMs: 500, ladderStepMs: 5 };
let seq = 0;
// A different price gives different strikes: an identical spread would be refused by the overlap guard, which still applies.
const emit = (direction: SignalDirection, now: number, price = 21_003.7) =>
  processSignal(receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price, barTime: `b${seq++}`, interval: "5", raw: { symbol: "NDX" }, now }), { executor, now, ...fast });

const held = (type: "short_put_spread" | "short_call_spread") => positionsStore.query((p) => p.botId === NDX_BOT_ID && p.type === type && ["opening", "open", "closing"].includes(p.status));

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
  ensureBotRecord(NDX_BOT_ID);
  botsStore.update(NDX_BOT_ID, { safeguards: { totalPositionLimit: 5, maxPositionsPerType: 1 } });
});

describe("the check's own logic", () => {
  it("compares a count the way each operator says", () => {
    const at = (op: (typeof CHECK_OPS)[number], count: number, held: number) => checkHolds({ op, count, status: "any" }, held);
    expect([at("more than", 1, 1), at("more than", 1, 2)]).toEqual([false, true]);
    expect([at("less than", 1, 0), at("less than", 1, 1)]).toEqual([true, false]);
    expect([at("exactly", 2, 2), at("exactly", 2, 3)]).toEqual([true, false]);
    expect([at("exactly or more than", 1, 0), at("exactly or more than", 1, 1)]).toEqual([false, true]);
    expect([at("exactly or less than", 1, 1), at("exactly or less than", 1, 2)]).toEqual([true, false]);
  });

  it("refuses anything that is not one of the offered choices", () => {
    expect(validateCheck(defaultCheck()).ok).toBe(true);
    expect(validateCheck({ op: "about", count: 1, status: "any" }).ok).toBe(false);
    expect(validateCheck({ op: "exactly", count: 11, status: "any" }).ok).toBe(false);
    expect(validateCheck({ op: "exactly", count: 1.5, status: "any" }).ok).toBe(false);
    expect(validateCheck({ op: "exactly", count: 1, status: "error" }).ok).toBe(false);
    expect(validateCheck(null).ok).toBe(false);
  });
});

describe("saving a check on the bot", () => {
  it("keeps the other slot and direction, and null returns a slot to the default", () => {
    updateBot(NDX_BOT_ID, { positionChecks: { bullish: { close: { op: "more than", count: 1, status: "open" } } } });
    updateBot(NDX_BOT_ID, { positionChecks: { bullish: { open: { op: "exactly or more than", count: 2, status: "any" } } } });
    let saved = botsStore.get(NDX_BOT_ID)!.positionChecks!;
    expect(saved.bullish?.close).toEqual({ op: "more than", count: 1, status: "open" });
    expect(saved.bullish?.open?.count).toBe(2);
    updateBot(NDX_BOT_ID, { positionChecks: { bullish: { close: null } } });
    saved = botsStore.get(NDX_BOT_ID)!.positionChecks!;
    expect(saved.bullish?.close).toBeUndefined();
    expect(saved.bullish?.open?.count).toBe(2);
  });

  it("rejects a bad check without saving anything", () => {
    expect(() => updateBot(NDX_BOT_ID, { positionChecks: { bearish: { open: { op: "exactly", count: 99, status: "any" } } } })).toThrow(/count/);
    expect(botsStore.get(NDX_BOT_ID)!.positionChecks).toBeUndefined();
  });
});

describe("the engine follows the checks edited on the canvas", () => {
  it("with nothing edited, a flip closes the other side and opens the wanted one, as before", async () => {
    await emit("bullish", BASE_NOW);
    await emit("bearish", BASE_NOW + 200_000);
    expect(held("short_put_spread")).toHaveLength(0);
    expect(held("short_call_spread")).toHaveLength(1);
  });

  it("a close check that is not met leaves the other side alone, and the run says what was asked", async () => {
    await emit("bullish", BASE_NOW); // holds a short put spread
    updateBot(NDX_BOT_ID, { positionChecks: { bearish: { close: { op: "more than", count: 1, status: "any" } } } });
    await emit("bearish", BASE_NOW + 200_000);
    expect(held("short_put_spread")).toHaveLength(1); // 1 position is not "more than 1": not closed
    const run = runsStore.all().at(-1)!;
    const asked = run.nodes.find((n) => n.kind === "decision" && /more than 1 position with Short put spread type and any status/i.test(n.text));
    expect(asked && asked.kind === "decision" && asked.result).toBe(false);
  });

  it("an open check can allow a second position of the same side", async () => {
    await emit("bullish", BASE_NOW);
    expect(held("short_put_spread")).toHaveLength(1);
    await emit("bullish", BASE_NOW + 200_000);
    expect(held("short_put_spread")).toHaveLength(1); // default: already held, nothing opened
    updateBot(NDX_BOT_ID, { positionChecks: { bullish: { open: { op: "exactly or more than", count: 2, status: "any" } } } });
    await emit("bullish", BASE_NOW + 400_000, 21_203.7);
    expect(held("short_put_spread")).toHaveLength(2);
  });

  it("a status other than any counts only positions in that status", async () => {
    await emit("bullish", BASE_NOW);
    updateBot(NDX_BOT_ID, { positionChecks: { bullish: { open: { op: "exactly or more than", count: 1, status: "closing" } } } });
    await emit("bullish", BASE_NOW + 200_000, 21_203.7);
    expect(held("short_put_spread")).toHaveLength(2); // the one held is open, not closing, so it doesn't count
  });

  it("a type other than the flow's own side counts positions of that type", async () => {
    await emit("bullish", BASE_NOW); // holds a short put spread
    // Bullish wants a put; ask about calls instead: none are held, so the open check says no and a second put is opened.
    updateBot(NDX_BOT_ID, { positionChecks: { bullish: { open: { op: "exactly or more than", count: 1, type: "Short call spread", status: "any" } } } });
    await emit("bullish", BASE_NOW + 200_000, 21_203.7);
    expect(held("short_put_spread")).toHaveLength(2);
    // "any" type counts every position the bot holds, so it is now blocked.
    updateBot(NDX_BOT_ID, { positionChecks: { bullish: { open: { op: "exactly or more than", count: 1, type: "any", status: "any" } } } });
    await emit("bullish", BASE_NOW + 400_000, 21_403.7);
    expect(held("short_put_spread")).toHaveLength(2);
    // A type this bot never holds counts zero.
    updateBot(NDX_BOT_ID, { positionChecks: { bullish: { open: { op: "exactly or more than", count: 1, type: "Iron condor", status: "any" } } } });
    await emit("bullish", BASE_NOW + 600_000, 21_603.7);
    expect(held("short_put_spread")).toHaveLength(3);
  });

  it("refuses a type that isn't in the list", () => {
    expect(validateCheck({ op: "exactly", count: 1, type: "Straddle", status: "any" }).ok).toBe(false);
    expect(validateCheck({ op: "exactly", count: 1, type: "Iron condor", status: "any" }).ok).toBe(true);
  });

  it("the canvas draws the same check the engine runs", () => {
    const checks = { close: { op: "more than" as const, count: 1, status: "open" as const }, open: { op: "exactly" as const, count: 0, status: "any" as const } };
    const drawn = previewTrace(builtInFlow("bullish", getBotStaticConfig(NDX_BOT_ID), undefined, 1, checks)).map((l) => l.text);
    expect(drawn).toContain("Decision: Bot has more than 1 position with Short call spread type and open status");
    expect(drawn).toContain("Decision: Bot has exactly 0 positions with Short put spread type and any status");
  });
});

describe("the Memo and Tags on a trigger's Close Position step", () => {
  it("are written on the position that step closes, and only for that trigger", async () => {
    await emit("bullish", BASE_NOW); // holds a short put spread
    updateBot(NDX_BOT_ID, { closeSettings: { bearish: { memo: "flip to bearish", tags: ["flip", " flip ", "ndx"] }, bullish: { memo: "not this one" } } });
    expect(botsStore.get(NDX_BOT_ID)!.closeSettings!.bearish).toEqual({ memo: "flip to bearish", tags: ["flip", "ndx"] });
    await emit("bearish", BASE_NOW + 200_000);
    const closed = positionsStore.query((p) => p.botId === NDX_BOT_ID && p.type === "short_put_spread")[0];
    expect(closed.status).toBe("closed");
    expect(closed.notes).toContain("flip to bearish");
    expect(closed.notes).not.toContain("not this one");
    expect(closed.tags).toEqual(["flip", "ndx"]);
  });

  it("an empty memo and no tags clear the saved note", () => {
    updateBot(NDX_BOT_ID, { closeSettings: { bearish: { memo: "x", tags: ["a"] } } });
    updateBot(NDX_BOT_ID, { closeSettings: { bearish: { memo: "  ", tags: [] } } });
    expect(botsStore.get(NDX_BOT_ID)!.closeSettings!.bearish).toEqual({});
  });
});
