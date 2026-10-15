import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WAITING_NOTE, testLine, watchTestRun } from "./testRun";

// The line under a test button: honest while the order is still being worked on, and rewritten by itself when the run ends.

describe("the line", () => {
  it("a finished run lists what was decided; an unfinished one says it is waiting, and that it will update by itself", () => {
    expect(testLine("bullish test alert at 21,000", [{ outcome: "opened" }], true)).toBe("bullish test alert at 21,000 → opened");
    expect(testLine("x", [{ outcome: "closed" }, { outcome: "opened" }], true)).toBe("x → closed → opened");
    const waiting = testLine("x", [], false);
    expect(waiting).toBe(`x → no decision yet (${WAITING_NOTE})`);
    expect(waiting).toContain("up to 4 prices over about 2½ minutes");
    expect(waiting).toContain("updates by itself");
    expect(waiting).not.toContain("still working");
  });
});

describe("keeping it true", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const answers = (list: ({ finished: boolean; decisions: { outcome: string }[] } | "error" | "http")[]) => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      const a = list[Math.min(calls.length - 1, list.length - 1)];
      if (a === "error") throw new Error("offline");
      if (a === "http") return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => a };
    };
    return { fetcher, calls };
  };

  it("asks every few seconds and rewrites the line when the run ends, then stops asking", async () => {
    const { fetcher, calls } = answers([{ finished: false, decisions: [] }, { finished: false, decisions: [] }, { finished: true, decisions: [{ outcome: "opened" }] }]);
    const lines: string[] = [];
    watchTestRun("sig 1", "head", (l) => lines.push(l), { fetcher, everyMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe("/api/automation/test/run?signalId=sig%201");
    expect(lines.at(-1)).toBe("head → opened");
    expect(lines[0]).toContain(WAITING_NOTE);
  });

  it("a failed look is simply tried again", async () => {
    const { fetcher, calls } = answers(["error", "http", { finished: true, decisions: [{ outcome: "open_timeout_no_fill" }] }]);
    const lines: string[] = [];
    watchTestRun("s", "head", (l) => lines.push(l), { fetcher, everyMs: 500 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(3);
    expect(lines).toEqual(["head → open_timeout_no_fill"]);
  });

  it("gives up after the limit with a line that says where to look", async () => {
    const { fetcher } = answers([{ finished: false, decisions: [] }]);
    const lines: string[] = [];
    watchTestRun("s", "head", (l) => lines.push(l), { fetcher, everyMs: 1000, maxMs: 3000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines.at(-1)).toMatch(/no answer yet after .* open the bot's Log/);
  });

  it("stops when told to (the screen went away): nothing more is asked or written", async () => {
    const { fetcher, calls } = answers([{ finished: false, decisions: [] }]);
    const lines: string[] = [];
    const stop = watchTestRun("s", "head", (l) => lines.push(l), { fetcher, everyMs: 1000 });
    await vi.advanceTimersByTimeAsync(1_500);
    stop();
    const asked = calls.length;
    const written = lines.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect([calls.length, lines.length]).toEqual([asked, written]);
  });
});
