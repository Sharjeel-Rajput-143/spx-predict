import { beforeEach, describe, expect, it } from "vitest";
import { ensureBotRecord } from "./bots";
import { BybitExecutor, BybitNoAnswerError, describeFailure, type BybitConfig, type BybitFetch } from "./bybitExecutor";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { processSignal, receiveAndSaveSignal, syncBrokerPositions } from "./engine";
import { botsStore, decisionsStore, positionsStore } from "./store";
import { BASE_NOW, BTC_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";

// Three safe fixes after the "fetch failed" errors: a read that got no answer is asked again, the real reason is written down,
// and a trade left "closing" while Bybit holds nothing is closed in our records. No network, no real key.

setNdxTestEnv();
const MIN = 60_000;
const SEC = 1000;
const fast = { closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 };
const config: BybitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0.12, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 5000 };

let bybit: FakeBybit;
let logs: string[];
let sleeps: number[];
let nowMs = BASE_NOW;
const build = (over: Partial<BybitConfig> = {}, fetchImpl: BybitFetch = bybit.fetch) => {
  const ex = new BybitExecutor({ ...config, ...over }, fetchImpl, (l) => logs.push(l), () => nowMs);
  ex.sleep = async (ms) => {
    sleeps.push(ms);
  };
  return ex;
};
const mine = () => positionsStore.all().filter((p) => p.botId === BTC_BOT_ID);
const run = (direction: "bullish" | "bearish", barTime: string, executor: BybitExecutor, now = BASE_NOW) => {
  nowMs = now;
  const signal = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: direction, price: 29_284.55, barTime, interval: "5", raw: { symbol: "BTC" }, now });
  return processSignal(signal, { executor, now, ...fast });
};

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  bybit = new FakeBybit();
  bybit.clock = () => nowMs;
  logs = [];
  sleeps = [];
  nowMs = BASE_NOW;
  ensureBotRecord(BTC_BOT_ID);
});

describe("a read that got no answer is asked again", () => {
  it("one lost answer is hidden: the second try works, after a one second pause", async () => {
    const ex = build();
    bybit.fail("/v5/position/list", { kind: "timeout", times: 1 });
    const held = await ex.getAccountPosition();
    expect(held.side).toBeNull();
    expect(bybit.of("/v5/position/list")).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    expect(logs.join("\n")).toMatch(/asking again \(try 2 of 3\)/);
  });

  it("two lost answers in a row are still hidden; three are reported, with the number of tries", async () => {
    const ex = build();
    bybit.fail("/v5/position/list", { kind: "timeout", times: 2 });
    await expect(ex.getAccountPosition()).resolves.toBeTruthy();
    expect(bybit.of("/v5/position/list")).toHaveLength(3);
    bybit.calls.length = 0;
    bybit.fail("/v5/position/list", { kind: "timeout", times: 3 });
    const err = await ex.getAccountPosition().catch((e) => e);
    expect(err).toBeInstanceOf(BybitNoAnswerError);
    expect(err.message).toMatch(/GET \/v5\/position\/list could not be completed/);
    expect(err.message).toMatch(/tried 3 times/);
    expect(bybit.of("/v5/position/list")).toHaveLength(3);
  });

  it("a busy Bybit (HTTP 500, 503, 429) is asked again; a refusal (403) or Bybit's own error code is not", async () => {
    const ex = build();
    for (const status of [500, 503, 429]) {
      bybit.calls.length = 0;
      bybit.fail("/v5/position/list", { kind: "http", status, msg: "busy", times: 1 });
      await expect(ex.getAccountPosition()).resolves.toBeTruthy();
      expect(bybit.of("/v5/position/list"), `HTTP ${status}`).toHaveLength(2);
    }
    bybit.calls.length = 0;
    bybit.fail("/v5/position/list", { kind: "http", status: 403, msg: "access denied", times: 1 });
    await expect(ex.getAccountPosition()).rejects.toThrow(/403/);
    expect(bybit.of("/v5/position/list")).toHaveLength(1);
    bybit.calls.length = 0;
    bybit.fail("/v5/position/list", { kind: "ret", code: 10003, msg: "API key is invalid", times: 1 });
    await expect(ex.getAccountPosition()).rejects.toThrow(/10003/);
    expect(bybit.of("/v5/position/list")).toHaveLength(1);
  });

  it("an ORDER is never sent twice: a lost answer to an order is looked up, not repeated", async () => {
    const ex = build();
    bybit.fail("/v5/order/create", { kind: "timeout", times: 1 });
    await run("bullish", "b1", ex);
    expect(bybit.of("/v5/order/create", "POST")).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("retrying never holds things up past the time budget", async () => {
    const ex = build({ readRetryDelayMs: 30_000 });
    bybit.fail("/v5/position/list", { kind: "timeout", times: 3 });
    await expect(ex.getAccountPosition()).rejects.toThrow(BybitNoAnswerError);
    expect(bybit.of("/v5/position/list")).toHaveLength(1);
  });

  it("the number of tries and the pause can be set", async () => {
    const ex = build({ readRetries: 0 });
    bybit.fail("/v5/position/list", { kind: "timeout", times: 1 });
    await expect(ex.getAccountPosition()).rejects.toThrow(BybitNoAnswerError);
    expect(bybit.of("/v5/position/list")).toHaveLength(1);
    const ex2 = build({ readRetries: 1, readRetryDelayMs: 250 });
    bybit.calls.length = 0;
    bybit.fail("/v5/position/list", { kind: "timeout", times: 1 });
    await ex2.getAccountPosition();
    expect(sleeps).toEqual([250]);
  });

  it("a signal that arrives while one read hiccups still trades (the retry rescues the entry)", async () => {
    const ex = build();
    bybit.fail("/v5/position/list", { kind: "timeout", times: 1 });
    await run("bullish", "b1", ex);
    expect(mine().map((p) => p.status)).toEqual(["open"]);
    expect(bybit.position.size).toBeGreaterThan(0);
    expect(botsStore.get(BTC_BOT_ID)?.needsAttention).toBe(false);
  });
});

describe("the real reason is written down", () => {
  const networkError = (code: string, message: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });

  it("fetch failed comes with the reason Node kept underneath", () => {
    expect(describeFailure(networkError("ECONNRESET", "read ECONNRESET"))).toBe("fetch failed (reason: ECONNRESET read ECONNRESET)");
    expect(describeFailure(networkError("ENOTFOUND", "getaddrinfo ENOTFOUND api-demo.bybit.com"))).toMatch(/ENOTFOUND getaddrinfo ENOTFOUND api-demo\.bybit\.com/);
    expect(describeFailure(new Error("plain"))).toBe("plain");
    expect(describeFailure("a string")).toBe("a string");
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(describeFailure(timeout)).toMatch(/TimeoutError/);
    const deep = new TypeError("fetch failed", { cause: new Error("outer", { cause: Object.assign(new Error("inner"), { code: "EAI_AGAIN" }) }) });
    expect(describeFailure(deep)).toMatch(/outer <- EAI_AGAIN inner/);
  });

  it("the error from a read that cannot be completed names the reason, and never the key or secret", async () => {
    const fetchImpl: BybitFetch = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error(`read ECONNRESET to host using ${API_KEY} and ${API_SECRET}`), { code: "ECONNRESET" }) });
    };
    const ex = build({}, fetchImpl);
    const err = await ex.getAccountPosition().catch((e) => e);
    expect(err.message).toMatch(/GET \/v5\/position\/list could not be completed: fetch failed \(reason: ECONNRESET/);
    expect(err.message).toMatch(/tried 3 times/);
    expect(err.message).not.toContain(API_KEY);
    expect(err.message).not.toContain(API_SECRET);
  });

  it("the Log line for a failed check of the broker carries the reason too", async () => {
    const fetchImpl: BybitFetch = async () => {
      throw networkError("ETIMEDOUT", "connect ETIMEDOUT 1.2.3.4:443");
    };
    const ex = build({ readRetries: 0 }, fetchImpl);
    positionsStore.insert({ id: "p1", botId: BTC_BOT_ID, venue: "bybit", type: "short_put_spread", status: "open" } as never);
    await syncBrokerPositions(BTC_BOT_ID, ex, BASE_NOW);
    const text = decisionsStore.all().map((d) => d.reason).join(" ");
    expect(text).toMatch(/Could not check the broker for trades it closed by itself/);
    expect(text).toMatch(/fetch failed \(reason: ETIMEDOUT connect ETIMEDOUT/);
  });
});

describe("a trade stuck in closing while Bybit holds nothing is closed in our records", () => {
  const openLong = async (ex: BybitExecutor) => {
    await run("bullish", "b1", ex);
    const p = mine()[0];
    expect(p.status).toBe("open");
    return p;
  };
  const stick = (id: string) => positionsStore.update(id, { status: "closing", closeSignalId: "sig-x", closeAttempts: 1 });

  it("waits to see it flat for 25 seconds first, then closes the record and says why", async () => {
    const ex = build();
    const p = await openLong(ex);
    bybit.hold(0); // Bybit closed it (a stop, or our own close that we lost track of)
    stick(p.id);
    expect(await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN)).toBe(0);
    expect(positionsStore.get(p.id)?.status).toBe("closing");
    expect(await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN + 10 * SEC)).toBe(0);
    expect(positionsStore.get(p.id)?.status).toBe("closing");
    expect(await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN + 26 * SEC)).toBe(1);
    const after = positionsStore.get(p.id)!;
    expect(after.status).toBe("closed");
    expect(after.closeReason).toBe("closed_at_broker");
    const said = decisionsStore.all().map((d) => d.reason).join(" ");
    expect(said).toMatch(/stuck in "closing" and the Bybit account holds nothing/);
  });

  it("when Bybit's own stop closed it, the real exit price and the reason are used", async () => {
    const ex = build();
    const p = await openLong(ex);
    expect(bybit.movePrice(bybit.price * 0.9)).toBe("StopLoss");
    stick(p.id);
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN);
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN + 30 * SEC);
    const after = positionsStore.get(p.id)!;
    expect(after.status).toBe("closed");
    expect(after.closeReason).toBe("stop_loss");
    expect(after.closePrice).not.toBeNull();
  });

  it("leaves it alone when the account still holds the position (a person decides, with Resolve)", async () => {
    const ex = build();
    const p = await openLong(ex);
    expect(bybit.position.size).toBeGreaterThan(0);
    stick(p.id);
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN);
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + 10 * MIN);
    expect(positionsStore.get(p.id)?.status).toBe("closing");
    expect(bybit.position.size).toBeGreaterThan(0);
  });

  it("the 25 seconds start again if the account held something in between", async () => {
    const ex = build();
    const p = await openLong(ex);
    const held = { ...bybit.position };
    stick(p.id);
    bybit.hold(0);
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN); // first seen flat
    bybit.position = held; // it holds again
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN + 20 * SEC);
    bybit.hold(0); // flat again, 40 seconds after the first time
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN + 40 * SEC);
    expect(positionsStore.get(p.id)?.status).toBe("closing");
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN + 70 * SEC);
    expect(positionsStore.get(p.id)?.status).toBe("closed");
  });

  it("clears the bot's 'needs attention' flag when that flag was this very problem, so the next signal trades", async () => {
    const ex = build();
    const p = await openLong(ex);
    stick(p.id);
    botsStore.update(BTC_BOT_ID, { needsAttention: true, needsAttentionReason: 'The BTC position is stuck in "closing": no close order is working and none was confirmed.' });
    bybit.hold(0);
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN);
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN + 30 * SEC);
    expect(botsStore.get(BTC_BOT_ID)?.needsAttention).toBe(false);
    // The bot is flat again: the next bearish signal opens a short.
    await run("bearish", "b2", ex, BASE_NOW + 5 * MIN);
    expect(mine().filter((x) => x.status === "open").map((x) => x.type)).toEqual(["short_call_spread"]);
  });

  it("does not clear a different warning", async () => {
    const ex = build();
    const p = await openLong(ex);
    stick(p.id);
    botsStore.update(BTC_BOT_ID, { needsAttention: true, needsAttentionReason: "Open order not placed: something else." });
    bybit.hold(0);
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN);
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN + 30 * SEC);
    expect(botsStore.get(BTC_BOT_ID)?.needsAttention).toBe(true);
  });

  it("a failed read of the account changes nothing and sends nothing", async () => {
    const ex = build({ readRetries: 0 });
    const p = await openLong(ex);
    stick(p.id);
    bybit.fail("/v5/position/list", { kind: "timeout", times: 5 });
    bybit.calls.length = 0;
    await expect(ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN)).rejects.toThrow(/could not be completed/);
    expect(positionsStore.get(p.id)?.status).toBe("closing");
    expect(bybit.created).toHaveLength(0);
  });

  it("sends no order of any kind while repairing", async () => {
    const ex = build();
    const p = await openLong(ex);
    stick(p.id);
    bybit.hold(0);
    bybit.calls.length = 0;
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN);
    await ex.syncPositions(BTC_BOT_ID, BASE_NOW + MIN + 30 * SEC);
    expect(bybit.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
