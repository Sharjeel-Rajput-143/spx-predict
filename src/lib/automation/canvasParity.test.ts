import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtInFlow } from "@/components/automation/builder/builtin";
import { previewTrace } from "@/components/automation/builder/model";
import { botsStore, runsStore } from "./store";
import { ensureBotRecord, getBotLimits, getBotStaticConfig } from "./bots";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import type { SignalDirection } from "./types";

// The canvas draws what the bot does for a signal. These tests run the real engine and check that the canvas, read as a path,
// asks the same questions in the same order, with the same numbers, as the run the engine recorded.

setTestBotEnv();
setNdxTestEnv();
const executor = new MockExecutor();
const fast = { pollIntervalMs: 5, closeConfirmTimeoutMs: 500, ladderStepMs: 5 };
let seq = 0;

const emit = (direction: SignalDirection, now: number) =>
  processSignal(receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 21_003.7, barTime: `b${seq++}`, interval: "5", raw: { symbol: "NDX" }, now }), { executor, now, ...fast });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
});

/** The five things the canvas draws, as the engine words them in its run. */
type Mark = "hours" | "opposite held?" | "close" | "wanted held?" | "open";
const MARKS: [Mark, RegExp][] = [
  ["hours", /market time is between/],
  ["opposite held?", /^Bot has exactly or more than \d+ positions? with (Short (Put|Call) Spread) type and any status/i],
  ["close", /^Close Position/],
  ["wanted held?", /^Bot holds fewer than \d+ (Short (Put|Call) Spread) positions?|^Bot has exactly or more than \d+ positions? with .* type and any status/i],
  ["open", /^Open (NDX )?Short/],
];

/** What the engine did, boiled down to the marks above. */
function engineSteps(direction: SignalDirection): { mark: Mark; count?: number; type?: string }[] {
  const run = runsStore.all().filter((r) => r.automation.toLowerCase().startsWith(direction)).at(-1)!;
  const out: { mark: Mark; count?: number; type?: string }[] = [];
  let seenOpposite = false;
  for (const node of run.nodes) {
    const text = node.kind === "decision" ? node.text : node.title;
    const hit = MARKS.find(([, re]) => re.test(text));
    if (!hit) continue;
    let mark = hit[0];
    if (mark === "opposite held?" || mark === "wanted held?") {
      // The first "has N positions" is the opposite side; the later "holds fewer than N" is the wanted side.
      mark = seenOpposite || /holds fewer/.test(text) ? "wanted held?" : "opposite held?";
      seenOpposite = true;
    }
    out.push({ mark, ...(mark === "wanted held?" ? { count: Number(/\d+/.exec(text)?.[0]), type: /(Short (Put|Call) Spread)/i.exec(text)?.[1]?.toLowerCase() } : {}) });
  }
  return out;
}

describe("the canvas and the engine ask the same questions", () => {
  it("the wanted-side check reads the bot's own per-type limit, so the canvas and the engine's run agree on the number", async () => {
    ensureBotRecord(NDX_BOT_ID);
    botsStore.update(NDX_BOT_ID, { safeguards: { maxPositionsPerType: 2, totalPositionLimit: 5 } });
    expect(getBotLimits(NDX_BOT_ID).maxPositionsPerType).toBe(2);
    await emit("bullish", BASE_NOW);

    const run = runsStore.all().at(-1)!;
    const engineCheck = run.nodes.find((n) => n.kind === "decision" && /^Bot holds fewer than/.test(n.text));
    expect(engineCheck && engineCheck.kind === "decision" && engineCheck.text).toBe("Bot holds fewer than 2 Short Put Spread positions");

    const drawn = previewTrace(builtInFlow("bullish", getBotStaticConfig(NDX_BOT_ID), undefined, 2)).map((l) => l.text);
    expect(drawn.some((t) => t === "Decision: Bot has exactly or more than 2 positions with Short put spread type and any status")).toBe(true);
    // And with the default limit it says one, as before.
    const dflt = previewTrace(builtInFlow("bullish", getBotStaticConfig(NDX_BOT_ID))).map((l) => l.text);
    expect(dflt).toContain("Decision: Bot has exactly or more than 1 position with Short put spread type and any status");
  });

  it("a flip runs hours, opposite held, close, wanted held, open, in that order, for both directions, and the canvas draws that order", async () => {
    await emit("bullish", BASE_NOW); // opens a short put spread
    await emit("bearish", BASE_NOW + 200_000); // flips
    await emit("bullish", BASE_NOW + 400_000); // flips back

    for (const direction of ["bearish", "bullish"] as const) {
      const engine = engineSteps(direction).map((s) => s.mark);
      expect(engine, direction).toEqual(["hours", "opposite held?", "close", "wanted held?", "open"]);
      const wantedType = direction === "bullish" ? "short put spread" : "short call spread";
      const drawn = previewTrace(builtInFlow(direction, getBotStaticConfig(NDX_BOT_ID))).map((l) => l.text);
      const order = drawn
        .map((t) => {
          const bare = t.replace(/^(Decision|Close Position|Open Position): /, "");
          if (/market time is between/.test(bare)) return "hours";
          if (/^Bot has exactly or more than/.test(bare)) return bare.toLowerCase().includes(wantedType) ? "wanted held?" : "opposite held?";
          if (/^Close Position/.test(bare)) return "close";
          if (/^Open NDX Short/.test(bare)) return "open";
          return undefined;
        })
        .filter(Boolean);
      // The canvas shows the close path first (hours, opposite held?, close, then the wanted-side check and the open).
      expect(order.slice(0, 5), direction).toEqual(["hours", "opposite held?", "close", "wanted held?", "open"]);
    }
  });

  it("with nothing to close the engine skips the close, as the canvas's No path does", async () => {
    await emit("bullish", BASE_NOW);
    expect(engineSteps("bullish").map((s) => s.mark)).toEqual(["hours", "opposite held?", "wanted held?", "open"]);
  });
});
