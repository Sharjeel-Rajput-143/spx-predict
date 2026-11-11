import { describe, expect, it, vi } from "vitest";
import { BTC_BOT_ID } from "./bots";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { runMirror, type MirrorDeps } from "./liveMirror";
import type { IngestResult } from "./webhookIngest";

// THE LIVE JOB'S PROMISES, with its collaborators replaced: it starts at once and independently of the demo bot, only when the one setting is on, and nothing it does can fail, hang or throw out of it.

const input = (over: Record<string, unknown> = {}) => ({ hook: { name: "BullishBTC", botId: BTC_BOT_ID }, direction: "bullish" as const, price: 76_000, barTime: "hook-1-2026-10-06T14:40", ...over });
function deps(over: Partial<MirrorDeps> = {}): MirrorDeps & { order: string[]; ingested: { parsed: Record<string, unknown>; options: Record<string, unknown> }[]; logs: string[] } {
  const order: string[] = [];
  const ingested: { parsed: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  return {
    order,
    ingested,
    logs,
    ingest: ((parsed: Record<string, unknown>, options: Record<string, unknown>) => {
      order.push("live ingest");
      ingested.push({ parsed, options });
      return { status: 200, body: { received: true }, processing: Promise.resolve() } as IngestResult;
    }) as unknown as MirrorDeps["ingest"],
    executor: {} as MirrorDeps["executor"],
    settings: () => ({ mirrorEnabled: true }),
    totalCapMs: 50,
    log: (l) => logs.push(l),
    ...over,
  };
}
const never = () => new Promise<never>(() => undefined);

describe("what the mirror sends", () => {
  it("a signal for the LIVE bot only, with the demo bot's own price and bar time, marked as a mirror and trusted by the server alone", async () => {
    const d = deps();
    await runMirror(input(), d);
    expect(d.ingested).toHaveLength(1);
    expect(d.ingested[0].parsed).toMatchObject({ bot: LIVE_BOT_ID, signal: "bullish", symbol: "BTC", price: 76_000, bar_time: "hook-1-2026-10-06T14:40-live", webhook: "BullishBTC", mirror: true });
    expect(d.ingested[0].options).toMatchObject({ trusted: true, mirrorOf: BTC_BOT_ID });
  });
  it("a bearish hook gives a bearish live signal", async () => {
    const d = deps();
    await runMirror(input({ direction: "bearish" }), d);
    expect(d.ingested[0].parsed.signal).toBe("bearish");
  });
});

describe("when it does nothing", () => {
  it("the mirror setting is OFF: nothing is sent to the live bot", async () => {
    const d = deps({ settings: () => ({ mirrorEnabled: false }) });
    await runMirror(input(), d);
    expect(d.ingested).toHaveLength(0);
  });
  it("a hook that is not the BTC demo bot's has no live twin", async () => {
    for (const botId of ["ndx_ema_bias", "spx_ema_bias", LIVE_BOT_ID, null, undefined]) {
      const d = deps();
      await runMirror(input({ hook: { name: "x", botId } }), d);
      expect(d.ingested, String(botId)).toHaveLength(0);
    }
  });
});

describe("it starts AT ONCE, independently of the demo bot", () => {
  it("the live signal is saved on the very first turn: it waits for nothing the demo bot does", async () => {
    const d = deps();
    const p = runMirror(input(), d);
    await Promise.resolve();
    await Promise.resolve();
    expect(d.ingested).toHaveLength(1); // saved before any timer could fire
    await p;
    expect(d.order).toEqual(["live ingest"]);
  });
  it("a demo bot that is slow, hung or has failed is simply not looked at: the live bot starts at once (there is no demo input to wait for)", async () => {
    const d = deps();
    const t0 = Date.now();
    await runMirror(input({ demoDone: never() }), d); // an extra field from an older caller is ignored: nothing waits for it
    await runMirror(input({ demoDone: new Promise(() => undefined) }), d);
    expect(d.ingested).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it("it needs no demo result at all: the same price and bar time are enough", async () => {
    const d = deps();
    await runMirror({ hook: { name: "BullishBTC", botId: BTC_BOT_ID }, direction: "bearish", price: 75_000, barTime: "t" }, d);
    expect(d.ingested[0].parsed).toMatchObject({ bot: LIVE_BOT_ID, signal: "bearish", price: 75_000, bar_time: "t-live" });
  });
});

describe("nothing the live side does can come back out of it", () => {
  it("the live ingest throws: it resolves, says so, and does not reject", async () => {
    const d = deps({ ingest: (() => { throw new Error("live exploded"); }) as unknown as MirrorDeps["ingest"] });
    await expect(runMirror(input(), d)).resolves.toBeUndefined();
    expect(d.logs.join(" ")).toMatch(/mirror failed.*demo bot is not affected/);
  });
  it("the settings cannot be read: it resolves and sends nothing", async () => {
    const d = deps({ settings: () => { throw new Error("no disk"); } });
    await expect(runMirror(input(), d)).resolves.toBeUndefined();
    expect(d.ingested).toHaveLength(0);
  });
  it("the live processing hangs for ever: it gives up after the cap and resolves", async () => {
    const d = deps({ ingest: (() => ({ status: 200, body: {}, processing: never() })) as unknown as MirrorDeps["ingest"], totalCapMs: 40 });
    const t0 = Date.now();
    await expect(runMirror(input(), d)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it("the live processing fails: it resolves", async () => {
    const d = deps({ ingest: (() => ({ status: 200, body: {}, processing: Promise.reject(new Error("order failed")) })) as unknown as MirrorDeps["ingest"] });
    await expect(runMirror(input(), d)).resolves.toBeUndefined();
  });
  it("the live bot refuses the signal (400): it resolves and says so", async () => {
    const d = deps({ ingest: (() => ({ status: 400, body: { error: "Unknown bot." } })) as unknown as MirrorDeps["ingest"] });
    await expect(runMirror(input(), d)).resolves.toBeUndefined();
    expect(d.logs.join(" ")).toMatch(/not accepted \(400\)/);
  });
  it("even a logger that throws cannot make it throw", async () => {
    const d = deps({ ingest: (() => { throw new Error("x"); }) as unknown as MirrorDeps["ingest"], log: () => { throw new Error("log broke"); } });
    await expect(runMirror(input(), d)).resolves.toBeUndefined();
  });
  it("it never touches the console with a thrown error object that could be mistaken for the demo's", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runMirror(input(), { ...deps({ ingest: (() => { throw new Error("x"); }) as unknown as MirrorDeps["ingest"] }), log: undefined as never });
    spy.mockRestore();
  });
});
