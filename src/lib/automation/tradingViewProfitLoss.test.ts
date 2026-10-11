import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as hookRoute } from "@/app/api/webhook/hook/[token]/route";
import { ensureBotRecord, updateBot } from "./bots";
import { runEndOfDaySweep } from "./eodSweep";
import { runExitChecks } from "./exitChecks";
import type { MockExecutor } from "./executor";
import { computeStats, positionPL, positionPLKind } from "./pnl";
import { getExecutor } from "./sharedExecutor";
import { decisionsStore as allDecisions, positionsStore } from "./store";
import { summarizeBot } from "./summary";
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import type { Position } from "./types";
import { createWebhook } from "./webhooks";

// Profit and loss, from the TradingView alert to the dollars. The mock broker fills at the prices we give it, so every
// number below can be checked by hand:   P/L = (credit received - debit paid to close) x 100 x contracts.
// Spreads are 10 points wide, so one contract can win at most credit x 100 and lose at most (10 - credit) x 100.
// No network, and nothing touches a real webhook or broker.

const feed = vi.hoisted(() => ({ price: 21_003.7 }));
vi.mock("@/lib/marketData/tickStore", () => ({
  waitForTick: async () => ({ t: Date.now(), price: feed.price }),
  getLastTick: () => ({ t: Date.now(), price: feed.price }),
  isLiveSymbol: () => false,
}));

setNdxTestEnv();

const MIN = 60_000;
const SWEEP_AT = Date.UTC(2026, 9, 6, 20, 15); // 16:15 New York, the NDX bot's end-of-day time
const timing = { closeConfirmTimeoutMs: 300, pollIntervalMs: 5, ladderStepMs: 20 };

let bull: ReturnType<typeof createWebhook>;
let bear: ReturnType<typeof createWebhook>;
let broker: MockExecutor;
let clock = BASE_NOW;

const decisions = () => allDecisions.all().filter((d) => d.signalId !== null);
const mine = () => positionsStore.all().filter((p) => p.botId === NDX_BOT_ID);
const held = () => mine().filter((p) => p.status === "open" || p.status === "opening" || p.status === "closing");
const byType = (type: Position["type"]) => mine().filter((p) => p.type === type);
const pl = (p: Position) => positionPL(positionsStore.get(p.id)!);

/** Queue the price the broker will fill the next order at (credit for an open, debit for a close). */
const fillAt = (price: number) => broker.queueScenario(NDX_BOT_ID, { kind: "instant", averagePrice: price });

/** One TradingView alert, two minutes after the last, and wait until the platform has finished with it. */
async function tradingView(hook: typeof bull) {
  clock += 2 * MIN;
  vi.setSystemTime(clock);
  const res = await hookRoute(
    new NextRequest(`http://localhost/hook/${hook.token}`, { method: "POST", body: hook === bull ? "bullish" : "bearish", headers: { "Content-Type": "text/plain" } }),
    { params: Promise.resolve({ token: hook.token }) },
  );
  let last = "";
  let stable = 0;
  for (let i = 0; i < 300 && stable < 4; i++) {
    const now = `${allDecisions.all().length}|${broker.placedOrders.length}|${mine().map((p) => p.status).join(",")}`;
    stable = now === last ? stable + 1 : 0;
    last = now;
    await new Promise((r) => setTimeout(r, 15));
  }
  return res;
}

/** Put spread opened by a Bullish alert at `credit`, then closed by a Bearish alert at `debit` (the flip). Returns the put. */
async function putThenFlip(credit: number, debit: number) {
  fillAt(credit); // the put spread opens
  await tradingView(bull);
  fillAt(debit); // the flip's close
  fillAt(3.5); // the call spread it opens
  await tradingView(bear);
  return byType("short_put_spread")[0];
}

function freshBot() {
  resetAutomationStores();
  setNdxTestEnv();
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  broker = getExecutor() as MockExecutor;
  ensureBotRecord(NDX_BOT_ID);
  clock = BASE_NOW - 2 * MIN;
  vi.setSystemTime(clock);
  bull = createWebhook({ name: `BullishNDX`, botId: NDX_BOT_ID, direction: "bullish" });
  bear = createWebhook({ name: `BearishNDX`, botId: NDX_BOT_ID, direction: "bearish" });
}

beforeEach(() => {
  vi.stubEnv("EXECUTOR", "mock");
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  feed.price = 21_003.7;
  freshBot();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
});

describe("profit and loss when a flip closes a position", () => {
  // opened at a $4.00 credit, one contract
  it.each([
    ["bought back cheaper: a win", 1.0, 300],
    ["bought back at the credit: break-even", 4.0, 0],
    ["bought back dearer: a loss", 7.5, -350],
    ["bought back at the full width: the most it can lose", 10.0, -600],
  ])("%s - credit 4.00, close at %s -> %s dollars", async (_name, debit, expected) => {
    const put = await putThenFlip(4.0, debit);
    const closed = positionsStore.get(put.id)!;
    expect(closed).toMatchObject({ status: "closed", credit: 4.0, closePrice: debit });
    expect(pl(put)).toBeCloseTo(expected, 2);
    expect(positionPLKind(closed)).toBe("fill"); // from a real fill, not an estimate
  });

  it("a winning call spread flipped to puts is worked out the same way", async () => {
    fillAt(3.5);
    await tradingView(bear); // call spread at 3.50
    fillAt(1.25); // close
    fillAt(4.0); // new put spread
    await tradingView(bull);
    const call = byType("short_call_spread")[0];
    expect(pl(call)).toBeCloseTo((3.5 - 1.25) * 100, 2); // +225
  });

  it("with two contracts every dollar doubles", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_QUANTITY", "2");
    const put = await putThenFlip(4.0, 1.0);
    expect(positionsStore.get(put.id)).toMatchObject({ requestedQuantity: 2, filledQuantity: 2 });
    expect(pl(put)).toBeCloseTo(600, 2); // (4.00 - 1.00) x 100 x 2
  });

  it("a position still open, or whose close was refused, has no P/L: it is never guessed", async () => {
    fillAt(4.0);
    await tradingView(bull);
    expect(pl(held()[0])).toBeNull();
    broker.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "no buying power" });
    await tradingView(bear);
    expect(pl(held()[0])).toBeNull();
    expect(computeStats(mine()).closedPL).toBeNull();
  });

  it("the premium, the risk and the numbers shown for the bot agree with the fills", async () => {
    const put = await putThenFlip(4.0, 1.0);
    const stats = computeStats(mine());
    expect(stats).toMatchObject({ priced: 1, wins: 1, losses: 0, closedPL: 300 });
    expect(summarizeBot(NDX_BOT_ID).closedPL).toBeCloseTo(300, 2);
    expect(put.credit! * 100 - 300).toBeCloseTo(100, 2); // $400 of premium, $300 kept, $100 left on the table
  });
});

describe("a whole day of flips: wins, losses and the totals", () => {
  it("three closed trades: +300, -250, +100 -> total 150, 2 wins / 1 loss, profit factor 1.6, drawdown 250", async () => {
    fillAt(4.0);
    await tradingView(bull); //            put 4.00 open
    fillAt(1.0);
    fillAt(3.5);
    await tradingView(bear); //            put closed +300; call 3.50 open
    fillAt(6.0);
    fillAt(3.0);
    await tradingView(bull); //            call closed -250; put 3.00 open
    fillAt(2.0);
    fillAt(4.0);
    await tradingView(bear); //            put closed +100; call 4.00 open

    const closed = mine().filter((p) => p.status === "closed");
    expect(closed.map(pl).map((x) => Math.round(x!))).toEqual([300, -250, 100]);
    expect(held()).toHaveLength(1); // the last call spread is open and not in the totals

    const s = computeStats(mine());
    expect(s.priced).toBe(3);
    expect(s.closedPL).toBeCloseTo(150, 2);
    expect(s).toMatchObject({ wins: 2, losses: 1 });
    expect(s.winRate).toBeCloseTo(2 / 3, 4);
    expect(s.avgWin).toBeCloseTo(200, 2);
    expect(s.avgLoss).toBeCloseTo(-250, 2);
    expect(s.profitFactor).toBeCloseTo(400 / 250, 4);
    expect(s.maxDrawdown).toBeCloseTo(250, 2); // peak +300, then -250 -> down 250 from the peak
    expect(s.streak).toEqual({ kind: "win", count: 1 });
    expect(s.curve.map((c) => Math.round(c.value))).toEqual([300, 50, 150]);
    expect(summarizeBot(NDX_BOT_ID).closedPL).toBeCloseTo(150, 2);
  });
});

describe("profit and loss when the day ends with a position held (settled at the close)", () => {
  /** Open one position by alert, run the 16:15 sweep with the NDX finishing at `finish`, return the settled position. */
  async function settle(direction: "bullish" | "bearish", credit: number, finish: number | null) {
    freshBot();
    fillAt(credit);
    await tradingView(direction === "bullish" ? bull : bear);
    const p = held()[0];
    await runEndOfDaySweep(SWEEP_AT, NDX_BOT_ID, { underlyingPrice: () => finish });
    return positionsStore.get(p.id)!;
  }

  // Short put spread 20,970 / 20,960 at a 4.00 credit.
  it.each([
    ["finishes well above: keeps the whole credit", 21_100, 400],
    ["finishes exactly at the short strike: still the whole credit", 20_970, 400],
    ["finishes 5 points through the short strike", 20_965, -100],
    ["finishes at the long strike: the most it can lose", 20_960, -600],
    ["finishes far below: the loss stops at the width", 20_500, -600],
  ])("put spread %s -> %s dollars", async (_name, finish, expected) => {
    const p = await settle("bullish", 4.0, finish);
    expect(p).toMatchObject({ status: "expired", underlyingAtClose: finish });
    expect(positionPL(p)).toBeCloseTo(expected, 2);
    expect(positionPLKind(p)).toBe("estimated"); // honest about it: worked out from the closing price, not a fill
  });

  // Short call spread 21,035 / 21,045 at a 3.50 credit.
  it.each([
    ["finishes below: keeps the whole credit", 21_000, 350],
    ["finishes 5 points through the short strike", 21_040, -150],
    ["finishes far above: the loss stops at the width", 21_300, -650],
  ])("call spread %s -> %s dollars", async (_name, finish, expected) => {
    const p = await settle("bearish", 3.5, finish);
    expect(positionPL(p)).toBeCloseTo(expected, 2);
  });

  it("with no closing price the position still expires but its P/L stays empty until it can be settled", async () => {
    const p = await settle("bullish", 4.0, null);
    expect(p.status).toBe("expired");
    expect(positionPL(p)).toBeNull();
    expect(computeStats(mine()).closedPL).toBeNull();
  });

  it("settled and flipped trades add up in the same totals", async () => {
    const put = await putThenFlip(4.0, 1.0); // +300 from a fill
    const call = byType("short_call_spread")[0]; // opened by the flip at 3.50, held to the close
    await runEndOfDaySweep(SWEEP_AT, NDX_BOT_ID, { underlyingPrice: () => 21_040 }); // 5 through -> -150
    expect(pl(put)).toBeCloseTo(300, 2);
    expect(pl(call)).toBeCloseTo(-150, 2);
    const s = computeStats(mine());
    expect(s.closedPL).toBeCloseTo(150, 2);
    expect(s.settledWithoutFill).toBe(1); // the summary can say one result is an estimate
  });
});

describe("profit-taking and stop-loss exit options on a position a TradingView alert opened", () => {
  /** Bullish alert with exit options set for the Bullish trigger; returns the put spread, opened at a $4.00 credit. */
  async function openWithExits(exit: object) {
    updateBot(NDX_BOT_ID, { openSettings: { bullish: { exit } } });
    fillAt(4.0);
    await tradingView(bull);
    const p = held()[0];
    expect(p.exitOptions).toEqual(exit);
    return p;
  }
  /** The market for the position: what it would cost to buy back is the mid of the short leg less the mid of the long leg. */
  const market = (debitMid: number) => broker.setQuotes({ short: { bid: debitMid - 0.1, ask: debitMid + 0.1 }, long: { bid: 0, ask: 0 } });
  const check = () => runExitChecks(NDX_BOT_ID, clock + MIN, { executor: broker, ...timing });

  it("nothing happens while the position sits between its profit target and its stop", async () => {
    await openWithExits({ profitPercent: 50, stopPercent: 100 });
    market(3.0); // 25% profit: not yet 50%
    expect((await check()).closed).toBe(0);
    market(6.0); // 50% loss: not yet 100%
    expect((await check()).closed).toBe(0);
    expect(held()).toHaveLength(1);
  });

  it("profit target: once the position is worth 50% of its credit it is closed for a profit, and is not closed twice", async () => {
    const p = await openWithExits({ profitPercent: 50, stopPercent: 100 });
    market(1.8); // 4.00 credit, buying back at 1.80 = 55% profit
    const r = await check();
    expect(r.closed).toBe(1);
    expect(allDecisions.all().at(-1)).toMatchObject({ outcome: "exit_closed", signalId: null }); // the bot acted on its own, not on an alert

    const done = positionsStore.get(p.id)!;
    expect(done.status).toBe("closed");
    expect(pl(p)).toBeGreaterThan(0);
    expect(pl(p)).toBeCloseTo((4.0 - done.closePrice!) * 100, 2);
    // bought back no cheaper than the middle of the market and no dearer than the worst price
    expect(done.closePrice!).toBeGreaterThanOrEqual(1.8 - 1e-9);
    expect(done.closePrice!).toBeLessThanOrEqual(1.9 + 1e-9);
    expect((await check()).closed).toBe(0); // nothing left to close
  });

  it("stop loss: once the loss reaches 100% of the credit the position is closed for a loss", async () => {
    const p = await openWithExits({ profitPercent: 50, stopPercent: 100 });
    market(8.2); // 4.00 credit, buying back at 8.20 = a 105% loss
    expect((await check()).closed).toBe(1);
    const done = positionsStore.get(p.id)!;
    expect(done.status).toBe("closed");
    expect(pl(p)).toBeLessThan(0);
    expect(pl(p)).toBeCloseTo((4.0 - done.closePrice!) * 100, 2);
    expect(pl(p)!).toBeGreaterThanOrEqual(-600 - 1e-9); // never worse than the width allows
  });

  it("a dollar target works on the whole position: profit of $250 or more, or a loss of $300 or more", async () => {
    await openWithExits({ profitDollars: 250, stopDollars: 300 });
    market(2.0); // +200: short of $250
    expect((await check()).closed).toBe(0);
    market(1.4); // +260
    expect((await check()).closed).toBe(1);

    broker.setQuotes(null);
    fillAt(1.0);
    await tradingView(bear); // a new call spread opens (nothing is held on the put side any more)
    expect(held().map((p) => p.type)).toEqual(["short_call_spread"]);
  });

  it("after an exit closes the position, the next opposite alert just opens the other side: no second close", async () => {
    const p = await openWithExits({ stopPercent: 50 });
    market(6.5); // a 62% loss
    expect((await check()).closed).toBe(1);
    broker.setQuotes(null);
    const closesBefore = broker.placedOrders.filter((o) => o.kind === "close").length;
    fillAt(3.5);
    await tradingView(bear);
    expect(broker.placedOrders.filter((o) => o.kind === "close")).toHaveLength(closesBefore); // nothing left to close
    expect(held().map((x) => x.type)).toEqual(["short_call_spread"]);
    expect(pl(p)).toBeLessThan(0);
  });

  it("without a market quote the money options do nothing: no guess, no close", async () => {
    await openWithExits({ profitPercent: 1, stopPercent: 1 });
    broker.setQuotes(null);
    expect((await check()).closed).toBe(0);
    expect(held()).toHaveLength(1);
  });
});
