import { describe, expect, it } from "vitest";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { OrderNotPlacedError } from "./orderErrors";
import { PerBotExecutor } from "./perBotExecutor";
import type { BrokerExecutor, OpenSpreadRequest, Position } from "./types";

// Two fake executors behind the router. Every call is written down with who got it, so "the demo account never sees a live bot" is a plain comparison.

function fake(name: string, log: string[]): BrokerExecutor & { primaryExecutor?: unknown } {
  return {
    venue: "bybit",
    placeOpenOrder: async (req: OpenSpreadRequest) => (log.push(`${name}:open:${req.botId}`), { ref: `${name}-open-1` }),
    placeCloseOrder: async (p: Position) => (log.push(`${name}:close:${p.botId}`), { ref: `${name}-close-1` }),
    getOrder: async (ref: string) => (log.push(`${name}:getOrder:${ref}`), { status: "filled", filledQuantity: 1 }),
    cancelOrder: async (ref: string) => void log.push(`${name}:cancel:${ref}`),
    listPositions: async (botId: string) => (log.push(`${name}:list:${botId}`), []),
    entryBlock: async (botId: string) => (log.push(`${name}:entryBlock:${botId}`), null),
    syncPositions: async (botId: string) => (log.push(`${name}:sync:${botId}`), 3),
    getContractResult: async (ref: string) => (log.push(`${name}:result:${ref}`), { settled: true, profit: 1, status: "ok" }),
    getSpreadMark: async (p: Position) => (log.push(`${name}:mark:${p.botId}`), 1.5),
    tradingWindowFor: () => ({ start: "00:00", end: "23:59", alwaysOn: true }),
    getBalances: async () => (log.push(`${name}:balances`), { cash: 1 } as never),
  };
}
const req = (botId: string) => ({ botId, underlying: "BTC", quantity: 1 }) as OpenSpreadRequest;
const pos = (botId: string) => ({ id: "p", botId, venue: "bybit" }) as Position;

describe("a call goes where its own bot or order reference says", () => {
  it("demo bot -> demo executor; live bot -> live executor; the other never hears of it", async () => {
    const log: string[] = [];
    const r = new PerBotExecutor(fake("demo", log), () => fake("live", log));
    await r.placeOpenOrder(req("btc_bybit"));
    await r.placeOpenOrder(req(LIVE_BOT_ID));
    await r.placeCloseOrder(pos("btc_bybit"));
    await r.placeCloseOrder(pos(LIVE_BOT_ID));
    await r.listPositions("btc_bybit");
    await r.listPositions(LIVE_BOT_ID);
    await r.entryBlock!("btc_bybit", 0);
    await r.entryBlock!(LIVE_BOT_ID, 0);
    expect(await r.syncPositions!(LIVE_BOT_ID, 0)).toBe(3);
    await r.getSpreadMark!(pos(LIVE_BOT_ID), 1);
    await r.getSpreadMark!(pos("btc_bybit"), 1);
    expect(log.filter((l) => l.startsWith("demo:"))).toEqual(["demo:open:btc_bybit", "demo:close:btc_bybit", "demo:list:btc_bybit", "demo:entryBlock:btc_bybit", "demo:mark:btc_bybit"]);
    expect(log.filter((l) => l.startsWith("live:"))).toEqual([`live:open:${LIVE_BOT_ID}`, `live:close:${LIVE_BOT_ID}`, `live:list:${LIVE_BOT_ID}`, `live:entryBlock:${LIVE_BOT_ID}`, `live:sync:${LIVE_BOT_ID}`, `live:mark:${LIVE_BOT_ID}`]);
  });

  it("an order question goes by the reference: a live reference to the live executor, anything else to the demo one", async () => {
    const log: string[] = [];
    const r = new PerBotExecutor(fake("demo", log), () => fake("live", log));
    await r.getOrder("bybitlive-open-77");
    await r.getOrder("bybit-open-77");
    await r.cancelOrder("bybitlive-close-5");
    await r.cancelOrder("bybit-close-5");
    await r.getContractResult!("bybitlive-close-9");
    await r.getContractResult!("bybit-close-9");
    expect(log).toEqual(["live:getOrder:bybitlive-open-77", "demo:getOrder:bybit-open-77", "live:cancel:bybitlive-close-5", "demo:cancel:bybit-close-5", "live:result:bybitlive-close-9", "demo:result:bybit-close-9"]);
  });

  it("the questions with no bot in them (quotes, hours, balances) stay with the demo executor", async () => {
    const log: string[] = [];
    const r = new PerBotExecutor(fake("demo", log), () => fake("live", log));
    await r.getBalances!();
    expect(log).toEqual(["demo:balances"]);
    expect(r.tradingWindowFor!("BTC")).toMatchObject({ alwaysOn: true });
  });

  it("passes through the demo executor behind it, for the screens that read the demo account directly", () => {
    const demo = fake("demo", []);
    const inner = fake("inner", []);
    (demo as { primaryExecutor?: unknown }).primaryExecutor = inner;
    expect(new PerBotExecutor(demo, () => null).primaryExecutor).toBe(inner);
  });
});

describe("with no live executor (no live key) the live bot is refused in words, and the demo account is never used instead", () => {
  it("open, close, and any question about a live reference are refused; entryBlock blocks; sync and marks say nothing", async () => {
    const log: string[] = [];
    const r = new PerBotExecutor(fake("demo", log), () => null);
    await expect(r.placeOpenOrder(req(LIVE_BOT_ID))).rejects.toThrow(OrderNotPlacedError);
    await expect(r.placeOpenOrder(req(LIVE_BOT_ID))).rejects.toThrow(/no live key.*Nothing is ever sent to the demo account/s);
    await expect(r.placeCloseOrder(pos(LIVE_BOT_ID))).rejects.toThrow(/live executor is not available/);
    await expect(r.getOrder("bybitlive-open-1")).rejects.toThrow(/live executor is not available/);
    await expect(r.cancelOrder("bybitlive-open-1")).rejects.toThrow(/live executor is not available/);
    await expect(r.listPositions(LIVE_BOT_ID)).rejects.toThrow(/live executor is not available/);
    expect(await r.entryBlock!(LIVE_BOT_ID, 0)).toMatchObject({ outcome: "kill_switch", reason: expect.stringMatching(/live executor is not available/) });
    expect(await r.syncPositions!(LIVE_BOT_ID, 0)).toBe(0);
    expect(await r.getSpreadMark!(pos(LIVE_BOT_ID), 1)).toBeNull();
    expect(await r.getContractResult!("bybitlive-close-1")).toBeNull();
    expect(log).toEqual([]); // not one call reached the demo executor
  });
  it("the demo bot is unaffected", async () => {
    const log: string[] = [];
    const r = new PerBotExecutor(fake("demo", log), () => null);
    await r.placeOpenOrder(req("btc_bybit"));
    expect(log).toEqual(["demo:open:btc_bybit"]);
  });
});
