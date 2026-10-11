import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as scan } from "@/app/api/cron/scan/route";
import { ensureBotRecord } from "./bots";
import { MAX_FAILED_ORDERS, runDueEntryRetries, runEntryRetry } from "./entryRetry";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { MockExecutor } from "./executor";
import { originLabel } from "./origin";
import { botsStore, decisionsStore, positionsStore, signalsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import type { SignalDirection } from "./types";

// Retrying a missed open: finishing what the last alert asked for, once a minute, and nothing else. The tests are mostly about when it
// must NOT act. No network, and nothing touches a real webhook or broker.

vi.mock("@/lib/marketData/tickStore", () => ({ waitForTick: async () => ({ t: Date.now(), price: 21_003.7 }), getLastTick: () => ({ t: Date.now(), price: 21_003.7 }), isLiveSymbol: () => false }));
setNdxTestEnv();

const MIN = 60_000;
const fast = { closeConfirmTimeoutMs: 50, orderFillTimeoutMs: 50, pollIntervalMs: 5, ladderStepMs: 10 };
const et = (h: number, m: number) => Date.UTC(2026, 9, 6, h + 4, m); // Tuesday 6 October 2026, New York time
let executor: MockExecutor;
let livePrice: number | null;
const price = async () => livePrice;

/** An alert as the bot sees it, at `now`. */
async function alert(direction: SignalDirection, now: number, opts: { symbol?: string } = {}) {
  const signal = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: direction, price: 21_003.7, barTime: `real-${direction}-${now}`, interval: "5", raw: { symbol: opts.symbol ?? "NDX", webhook: direction === "bullish" ? "BullishNDX" : "BearishNDX" }, now });
  await processSignal(signal, { executor, now, ...fast });
  return signal;
}
const retry = (now: number) => runEntryRetry(NDX_BOT_ID, now, { executor, price, ...fast });
const outcomes = () => decisionsStore.all().filter((d) => d.signalId !== null).map((d) => d.outcome);
const held = () => positionsStore.all().filter((p) => ["open", "opening", "closing"].includes(p.status));
const sent = () => executor.placedOrders.map((o) => `${o.kind} ${o.positionType === "short_put_spread" ? "PUT" : "CALL"}`);

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  executor = new MockExecutor();
  livePrice = 21_003.7;
  ensureBotRecord(NDX_BOT_ID);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("an open that was dropped for a temporary reason is tried again", () => {
  it("an alert before the window opens (9:31am): nothing at 9:34, then the position opens once the window is open", async () => {
    await alert("bullish", et(9, 31));
    expect(outcomes()).toEqual(["outside_hours"]);
    expect((await retry(et(9, 34))).skipped).toBe("outside_hours");
    expect(sent()).toEqual([]);

    const r = await retry(et(9, 36));
    expect(r.retried).toBe(true);
    expect(sent()).toEqual(["open PUT"]);
    expect(held().map((p) => [p.type, p.status])).toEqual([["short_put_spread", "open"]]);
    expect(outcomes()).toEqual(["outside_hours", "entry_retry", "opened"]);
    // and it is said so in the Log
    const note = decisionsStore.all().find((d) => d.outcome === "entry_retry")!;
    expect(note.reason).toMatch(/retrying the bullish open.*outside_hours.*Attempt 1/);
    const retrySignal = signalsStore.all().find((s) => s.id === note.signalId)!;
    expect(originLabel(retrySignal)).toBe("Retry: BullishNDX");
  });

  it("the broker refused the order: tried again a minute later, not sooner, and it opens once", async () => {
    executor.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "no buying power" });
    await alert("bullish", et(10, 40));
    expect(outcomes()).toEqual(["open_rejected"]);
    expect((await retry(et(10, 40) + 30_000)).skipped).toBe("too_soon");
    expect(sent()).toEqual(["open PUT"]); // only the first, refused order

    expect((await retry(et(10, 41) + 5_000)).retried).toBe(true);
    expect(sent()).toEqual(["open PUT", "open PUT"]);
    expect(held()).toHaveLength(1);
    expect((await retry(et(10, 43))).skipped).toBe("nothing_to_retry"); // done: it is not opened a second time
    expect(sent()).toHaveLength(2);
  });

  it("an order that timed out unfilled is tried again", async () => {
    executor.queueScenario(NDX_BOT_ID, { kind: "never" });
    await alert("bearish", et(11, 0));
    expect(outcomes().at(-1)).toBe("open_timeout_no_fill");
    expect((await retry(et(11, 2))).retried).toBe(true);
    expect(held().map((p) => p.type)).toEqual(["short_call_spread"]);
  });

  it("an alert the webhook could not price at the time (rejected as no_price) is opened once a price exists", async () => {
    signalsStore.insert({ id: "sig-noprice", botId: NDX_BOT_ID, signal: "bullish", barTime: "", price: 0, interval: "", receivedAt: et(10, 40), status: "rejected", rejectReason: "no_price", raw: { webhook: "BullishNDX" } });
    livePrice = null;
    expect((await retry(et(10, 42))).skipped).toBe("no_price_yet"); // still no price: waits, writes nothing
    expect(decisionsStore.all()).toHaveLength(0);
    livePrice = 21_003.7;
    expect((await retry(et(10, 43))).retried).toBe(true);
    expect(held().map((p) => p.type)).toEqual(["short_put_spread"]);
  });

  it("after three refused orders it stops: three attempts in all, never a fourth", async () => {
    for (let i = 0; i < 6; i++) executor.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "no" });
    await alert("bullish", et(10, 0)); // refused (1)
    expect((await retry(et(10, 2))).retried).toBe(true); // refused (2)
    expect((await retry(et(10, 4))).retried).toBe(true); // refused (3)
    expect(MAX_FAILED_ORDERS).toBe(3);
    expect((await retry(et(10, 6))).skipped).toBe("too_many_failed_orders");
    expect((await retry(et(10, 30))).skipped).toBe("too_many_failed_orders");
    expect(sent()).toHaveLength(3);
    expect(held()).toHaveLength(0);
  });
});

describe("it never acts when it should not", () => {
  it("an order whose outcome is unknown (the connection dropped while sending it) is never retried: a person checks the broker", async () => {
    executor.queueScenario(NDX_BOT_ID, { kind: "throw", message: "socket hang up" });
    await alert("bullish", et(10, 40));
    expect(outcomes()).toEqual(["executor_error"]);
    expect((await retry(et(10, 45))).skipped).toBe("nothing_to_retry");
    expect(sent()).toEqual([]);
    expect(held().map((p) => p.status)).toEqual(["opening"]); // left as it was
  });

  it("an alert that was refused for a reason that isn't temporary is never retried: already held, price out of range, wrong symbol", async () => {
    await alert("bullish", et(10, 0)); // opens
    await alert("bullish", et(10, 5)); // already in position
    expect(outcomes().at(-1)).toBe("already_in_position");
    expect((await retry(et(10, 10))).skipped).toBe("nothing_to_retry");

    resetAutomationStores();
    setNdxTestEnv();
    ensureBotRecord(NDX_BOT_ID);
    executor = new MockExecutor();
    const bad = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: "bullish", price: 7_700, barTime: "x", interval: "5", raw: { symbol: "NDX" }, now: et(10, 0) });
    await processSignal(bad, { executor, now: et(10, 0), ...fast });
    expect(outcomes()).toEqual(["price_out_of_range"]);
    expect((await retry(et(10, 5))).skipped).toBe("nothing_to_retry");

    const wrong = receiveAndSaveSignal({ botId: NDX_BOT_ID, signal: "bullish", price: 21_003.7, barTime: "y", interval: "5", raw: { symbol: "SPX" }, now: et(11, 0) });
    await processSignal(wrong, { executor, now: et(11, 0), ...fast });
    expect(outcomes().at(-1)).toBe("symbol_mismatch");
    expect((await retry(et(11, 5))).skipped).toBe("nothing_to_retry");
    expect(sent()).toEqual([]);
  });

  it("not once the position was opened for that alert and later closed, by a person or an exit: it is not re-opened", async () => {
    await alert("bullish", et(10, 0));
    const p = held()[0];
    positionsStore.update(p.id, { status: "closed", closedAt: et(10, 30) });
    expect((await retry(et(10, 40))).skipped).toBe("nothing_to_retry");
    expect(sent()).toEqual(["open PUT"]);
  });

  it("not when anything is held on either side, even the other side (it never stands in for a failed close)", async () => {
    executor.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "no" });
    await alert("bullish", et(10, 0)); // dropped
    positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", type: "short_call_spread", status: "closing", shortStrike: 21_100, longStrike: 21_110, requestedQuantity: 1, filledQuantity: 1, credit: 3.5 }));
    expect((await retry(et(10, 5))).skipped).toBe("nothing_to_retry");
    expect(sent()).toEqual(["open PUT"]);
  });

  it("not when a newer alert has since come: only the latest alert is ever finished", async () => {
    executor.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "no" });
    await alert("bullish", et(10, 0)); // dropped
    await alert("bearish", et(10, 3)); // newer: opens the call spread
    expect(held().map((p) => p.type)).toEqual(["short_call_spread"]);
    expect((await retry(et(10, 6))).skipped).toBe("nothing_to_retry"); // the old bullish one is not revived
    expect(held().map((p) => p.type)).toEqual(["short_call_spread"]);
  });

  it("not on a later day: yesterday's alert is not today's", async () => {
    executor.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "no" });
    await alert("bullish", et(15, 0));
    expect((await retry(et(10, 0) + 24 * 60 * MIN)).skipped).toBe("nothing_to_retry");
    expect(sent()).toHaveLength(1);
  });

  it.each([
    ["the bot is switched off", () => botsStore.update(NDX_BOT_ID, { enabled: false }), "bot_not_ready"],
    ["the kill switch is on", () => botsStore.update(NDX_BOT_ID, { killSwitch: true }), "bot_not_ready"],
    ["the bot is flagged for a person", () => botsStore.update(NDX_BOT_ID, { needsAttention: true, needsAttentionReason: "check it" }), "bot_not_ready"],
    ["that direction's trigger is off", () => botsStore.update(NDX_BOT_ID, { triggers: { bullish: false, bearish: true } }), "trigger_off"],
  ])("not when %s", async (_name, change, why) => {
    executor.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "no" });
    await alert("bullish", et(10, 0));
    change();
    expect((await retry(et(10, 5))).skipped).toBe(why);
    expect(sent()).toEqual(["open PUT"]);
  });

  it("not in a dry run, and not outside the trading window", async () => {
    executor.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "no" });
    await alert("bullish", et(15, 50));
    expect((await retry(et(15, 57))).skipped).toBe("outside_hours"); // the window closed at 3:55pm
    vi.stubEnv("AUTOMATION_DRY_RUN", "true");
    expect((await retry(et(15, 53))).skipped).toBe("dry_run");
    expect(sent()).toHaveLength(1);
  });

  it("a weekend or holiday never retries", async () => {
    signalsStore.insert({ id: "sig-np", botId: NDX_BOT_ID, signal: "bullish", barTime: "", price: 0, interval: "", receivedAt: Date.UTC(2026, 9, 10, 15, 0), status: "rejected", rejectReason: "no_price", raw: {} });
    expect((await retry(Date.UTC(2026, 9, 10, 15, 5))).skipped).toBe("outside_hours"); // a Saturday
    expect(sent()).toEqual([]);
  });
});

describe("a retry is an ordinary run: every guard still applies", () => {
  it("a price outside the allowed range is refused by the engine, and that ends the retrying (it is not a temporary reason)", async () => {
    await alert("bullish", et(9, 31)); // outside hours
    livePrice = 7_700;
    expect((await retry(et(9, 36))).retried).toBe(true);
    expect(outcomes().at(-1)).toBe("price_out_of_range");
    expect(sent()).toEqual([]);
    livePrice = 21_003.7;
    expect((await retry(et(9, 38))).skipped).toBe("nothing_to_retry");
  });

  it("the allocation limit still stops it and switches the bot off, once", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_QUANTITY", "4");
    await alert("bullish", et(9, 31));
    expect((await retry(et(9, 36))).retried).toBe(true);
    expect(outcomes().at(-1)).toBe("allocation_limit_reached");
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ enabled: false, needsAttention: true });
    expect((await retry(et(9, 38))).skipped).toBe("nothing_to_retry");
    expect(sent()).toEqual([]);
  });

  it("the retry is not blocked by the duplicate check (it is within two minutes of the alert), and does not block a later real alert", async () => {
    executor.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "no" });
    executor.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "no" });
    await alert("bullish", et(10, 0)); // refused
    await retry(et(10, 1) + 5_000); // 65 seconds later: refused again, and not called a duplicate
    expect(outcomes()).not.toContain("duplicate_signal");
    expect(sent()).toHaveLength(2);
    // A real alert 125 seconds after the first is 60 seconds after the retry: it must go through.
    await alert("bullish", et(10, 2) + 5_000);
    expect(outcomes()).not.toContain("duplicate_signal");
    expect(held().map((p) => p.type)).toEqual(["short_put_spread"]);
  });
});

describe("the every-minute address for a host that doesn't stay running", () => {
  const call = (auth?: string) => scan(new NextRequest("http://localhost/api/cron/scan", { method: "GET", headers: auth ? { authorization: auth } : {} }));

  it("refuses everyone without the secret, and everything if no secret is set", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer anything")).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "s3cret-value");
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(decisionsStore.all()).toHaveLength(0);
  });

  it("with the secret it retries what is due and reports which bots it acted on; with nothing due it does nothing", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-value");
    vi.stubEnv("EXECUTOR", "mock");
    (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE_NOW); // 10:40am New York
    expect(await (await call("Bearer s3cret-value")).json()).toEqual({ ok: true, retried: [] });

    signalsStore.insert({ id: "sig-np2", botId: NDX_BOT_ID, signal: "bullish", barTime: "", price: 0, interval: "", receivedAt: BASE_NOW - 2 * MIN, status: "rejected", rejectReason: "no_price", raw: { webhook: "BullishNDX" } });
    const res = await call("Bearer s3cret-value");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, retried: [NDX_BOT_ID] });
    expect(held().map((p) => p.type)).toEqual(["short_put_spread"]);
    expect(await (await call("Bearer s3cret-value")).json()).toEqual({ ok: true, retried: [] }); // and not again
  });

  it("runDueEntryRetries covers every bot and survives one failing", async () => {
    signalsStore.insert({ id: "sig-np3", botId: NDX_BOT_ID, signal: "bearish", barTime: "", price: 0, interval: "", receivedAt: et(10, 38), status: "rejected", rejectReason: "no_price", raw: {} });
    const results = await runDueEntryRetries(et(10, 40), { executor, price, ...fast });
    expect(results.find((r) => r.botId === NDX_BOT_ID)).toMatchObject({ retried: true });
    expect(held().map((p) => p.type)).toEqual(["short_call_spread"]);
  });
});
