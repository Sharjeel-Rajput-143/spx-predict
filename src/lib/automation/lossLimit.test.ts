import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyLossLimitDefault } from "./config";
import { checkDailyLoss, judgeLossLimit, openLossOf, realizedToday, sumRealizedToday } from "./lossLimit";
import { positionsStore } from "./store";
import { BASE_NOW, TEST_BOT_ID, buildPosition, resetAutomationStores } from "./testSupport";
import type { BrokerExecutor, Position } from "./types";
import { getBotLimits, updateBot, validateSafeguards } from "./bots";

// BASE_NOW is 10:40am New York on 2026-10-06.
const DAY = 24 * 3_600_000;
const NOW = BASE_NOW;
const closed = (credit: number, closePrice: number | null, over: Partial<Position> = {}): Position =>
  buildPosition({ type: "short_put_spread", status: "closed", credit, closePrice, requestedQuantity: 1, filledQuantity: 1, closedAt: NOW - 3_600_000, ...over });
const held = (credit: number | null, over: Partial<Position> = {}): Position => buildPosition({ type: "short_put_spread", status: "open", credit, requestedQuantity: 1, filledQuantity: 1, ...over });

beforeEach(() => resetAutomationStores());
afterEach(() => vi.unstubAllEnvs());

describe("today's realized result", () => {
  it("adds up the profit and loss of what closed today: (credit - close price) x 100 x quantity", () => {
    const r = sumRealizedToday([closed(3, 5), closed(2, 0.5), closed(1, 1, { requestedQuantity: 2, filledQuantity: 2 })], NOW);
    expect(r).toEqual({ realized: -50, closedToday: 3, unpriced: 0 }); // -200 + 150 + 0
  });

  it("counts only today in New York: yesterday and tomorrow are left out, and the day changes at midnight there", () => {
    const yesterday = closed(3, 9, { closedAt: NOW - DAY });
    const tomorrow = closed(3, 9, { closedAt: NOW + DAY });
    expect(sumRealizedToday([yesterday, tomorrow], NOW)).toEqual({ realized: 0, closedToday: 0, unpriced: 0 });
    const lastNight = Date.UTC(2026, 9, 6, 3, 59); // 11:59pm on Oct 5 in New York
    const justAfter = Date.UTC(2026, 9, 6, 4, 1); // 12:01am on Oct 6
    expect(sumRealizedToday([closed(3, 9, { closedAt: lastNight })], NOW).closedToday).toBe(0);
    expect(sumRealizedToday([closed(3, 9, { closedAt: justAfter })], NOW).closedToday).toBe(1);
  });

  it("uses an expired position's settlement (the estimate or what a person typed), and leaves out anything else", () => {
    const expired = buildPosition({ type: "short_put_spread", status: "expired", credit: 3, closedAt: NOW - 1000, settlement: { kind: "estimated", pl: -420, underlyingPrice: 1, settleValue: 5, at: NOW } as Position["settlement"] });
    const rejected = buildPosition({ type: "short_put_spread", status: "rejected", credit: null, closedAt: NOW - 1000 });
    const open = held(3);
    expect(sumRealizedToday([expired, rejected, open], NOW)).toEqual({ realized: -420, closedToday: 1, unpriced: 0 });
  });

  it("a position closed with no price has no result: it counts as 0 and is counted as unpriced, never guessed", () => {
    expect(sumRealizedToday([closed(3, null), closed(3, 5)], NOW)).toEqual({ realized: -200, closedToday: 2, unpriced: 1 });
  });

  it("nets a win against a loss, and rounds to the cent", () => {
    expect(sumRealizedToday([closed(3.333, 1.111), closed(3, 5.5)], NOW).realized).toBe(-27.8); // +222.2 - 250
  });

  it("reads the bot's own positions from the data, and only that bot's", () => {
    positionsStore.insert(closed(3, 5, { botId: TEST_BOT_ID }));
    positionsStore.insert(closed(3, 9, { botId: "other_bot" }));
    expect(realizedToday(TEST_BOT_ID, NOW)).toEqual({ realized: -200, closedToday: 1, unpriced: 0 });
  });
});

describe("the open loss", () => {
  const exec = (over: Partial<BrokerExecutor>): BrokerExecutor => ({ venue: "ibkr", ...over }) as BrokerExecutor;

  it("nothing held: 0, known", async () => {
    expect(await openLossOf([], exec({}))).toEqual({ known: true, loss: 0, source: "no position held" });
  });

  it("is worked out from the broker's mark when there is one", async () => {
    const r = await openLossOf([held(3)], exec({ getSpreadMark: async () => 4.5 }));
    expect(r).toEqual({ known: true, loss: -150, source: "broker mark" });
  });

  it("falls back to the middle of the spread quote when there is no mark", async () => {
    const legs = { short: { bid: 5, ask: 5.4 }, long: { bid: 1.6, ask: 2 } }; // debit best 3.0, worst 3.8, mid 3.4
    const r = await openLossOf([held(3)], exec({ getSpreadMark: async () => null, getSpreadQuote: async () => legs }));
    expect(r).toMatchObject({ known: true, source: "quote middle" });
    expect(r.known && r.loss).toBe(-40);
  });

  it("an open profit is not counted: it offsets nothing", async () => {
    expect(await openLossOf([held(3)], exec({ getSpreadMark: async () => 1 }))).toMatchObject({ known: true, loss: 0 });
  });

  it("sums the losses of several held positions (a closing one counts, an opening one does not)", async () => {
    const r = await openLossOf([held(3), held(3, { status: "closing" }), held(3, { status: "opening" })], exec({ getSpreadMark: async () => 4 }));
    expect(r).toMatchObject({ known: true, loss: -200 });
  });

  it("is UNKNOWN, with the reason, when there is no mark and no quote - and one unknown position makes the whole unknown", async () => {
    expect(await openLossOf([held(3)], exec({}))).toEqual({ known: false, why: "there is no broker mark and no spread quote for the position held" });
    expect(await openLossOf([held(3)], exec({ getSpreadMark: async () => { throw new Error("down"); }, getSpreadQuote: async () => null }))).toMatchObject({ known: false });
    const mixed = await openLossOf([held(3), held(null)], exec({ getSpreadMark: async () => 4 }));
    expect(mixed).toMatchObject({ known: false });
    expect(mixed.known === false && mixed.why).toMatch(/no credit recorded/);
  });
});

describe("the verdict and the Log line", () => {
  const today = (realized: number, closedToday = 1, unpriced = 0) => ({ realized, closedToday, unpriced });

  it("is hit when realized + open loss is at or below minus the limit - exactly at the limit counts", () => {
    expect(judgeLossLimit({ limit: 200, today: today(-100), open: { known: true, loss: -100, source: "broker mark" }, at: NOW }).hit).toBe(true);
    expect(judgeLossLimit({ limit: 200, today: today(-100), open: { known: true, loss: -99.99, source: "broker mark" }, at: NOW }).hit).toBe(false);
    expect(judgeLossLimit({ limit: 200, today: today(-250), open: { known: true, loss: 0, source: "no position held" }, at: NOW }).hit).toBe(true);
  });

  it("a win today offsets a realized loss, but an open profit offsets nothing", () => {
    expect(judgeLossLimit({ limit: 100, today: today(50), open: { known: true, loss: -140, source: "x" }, at: NOW }).total).toBe(-90);
    expect(judgeLossLimit({ limit: 100, today: today(50), open: { known: true, loss: -140, source: "x" }, at: NOW }).hit).toBe(false);
  });

  it("a limit of 0 is never hit", () => {
    expect(judgeLossLimit({ limit: 0, today: today(-9999), open: { known: true, loss: -9999, source: "x" }, at: NOW }).hit).toBe(false);
  });

  it("the line shows realized, the open loss, the total, the limit and the verdict", () => {
    const c = judgeLossLimit({ limit: 200, today: today(-120, 2), open: { known: true, loss: -45, source: "broker mark" }, at: NOW });
    expect(c.line).toBe("Day's result: realized -$120.00 (2 closed or expired today), open loss -$45.00 (broker mark), total -$165.00, daily loss limit $200.00 - within the limit");
    const hit = judgeLossLimit({ limit: 100, today: today(-120, 2, 1), open: { known: true, loss: 0, source: "no position held" }, at: NOW });
    expect(hit.line).toMatch(/realized -\$120\.00 \(2 closed or expired today, 1 with no price counted as 0\).*LIMIT REACHED$/);
    expect(hit.snapshot).toMatchObject({ limit: 100, realized: -120, openLoss: 0, total: -120, hit: true, closedToday: 2, unpriced: 1 });
  });

  it("an unknown open loss is said so in the line and in the snapshot, not counted, not guessed", () => {
    const c = judgeLossLimit({ limit: 200, today: today(-120), open: { known: false, why: "there is no broker mark and no spread quote for the position held" }, at: NOW });
    expect(c.line).toContain("open loss UNKNOWN (there is no broker mark and no spread quote for the position held) - not counted, not guessed");
    expect(c.total).toBe(-120);
    expect(c.snapshot).toMatchObject({ openLoss: null, openLossWhy: "there is no broker mark and no spread quote for the position held" });
    expect(judgeLossLimit({ limit: 100, today: today(-120), open: { known: false, why: "x" }, at: NOW }).hit).toBe(true); // realized alone is over
  });
});

describe("one evaluation, from the data and the broker", () => {
  it("reads today's closed results and the held position's loss together", async () => {
    positionsStore.insert(closed(3, 5, { botId: TEST_BOT_ID })); // -200
    positionsStore.insert(held(3, { botId: TEST_BOT_ID, id: "pos-held" }));
    const executor = { venue: "ibkr", getSpreadMark: async () => 4.5 } as unknown as BrokerExecutor; // -150
    const c = await checkDailyLoss({ botId: TEST_BOT_ID, limit: 300, now: NOW, executor });
    expect(c).toMatchObject({ total: -350, hit: true });
    const excluded = await checkDailyLoss({ botId: TEST_BOT_ID, limit: 300, now: NOW, executor, exclude: new Set(["pos-held"]) });
    expect(excluded).toMatchObject({ total: -200, hit: false });
  });
});

describe("the setting", () => {
  it("DAILY_LOSS_LIMIT is off unless it is a number above 0, and a bad value is off, never an error", () => {
    expect(dailyLossLimitDefault()).toBe(0);
    for (const v of ["", "0", "-5", "abc"]) {
      vi.stubEnv("DAILY_LOSS_LIMIT", v);
      expect(dailyLossLimitDefault()).toBe(0);
    }
    vi.stubEnv("DAILY_LOSS_LIMIT", "250");
    expect(dailyLossLimitDefault()).toBe(250);
  });

  it("a bot's own value overrides the default, 0 turns it off for that bot, and blank means the default", () => {
    vi.stubEnv("DAILY_LOSS_LIMIT", "250");
    expect(getBotLimits(TEST_BOT_ID).dailyLossLimit).toBe(250);
    updateBot(TEST_BOT_ID, { safeguards: { dailyLossLimit: 40 } });
    expect(getBotLimits(TEST_BOT_ID).dailyLossLimit).toBe(40);
    updateBot(TEST_BOT_ID, { safeguards: { dailyLossLimit: 0 } });
    expect(getBotLimits(TEST_BOT_ID).dailyLossLimit).toBe(0);
    updateBot(TEST_BOT_ID, { safeguards: {} });
    expect(getBotLimits(TEST_BOT_ID).dailyLossLimit).toBe(250);
  });

  it("validation: dollars, 0 or more", () => {
    expect(validateSafeguards({ dailyLossLimit: 50 })).toBeNull();
    expect(validateSafeguards({ dailyLossLimit: 0 })).toBeNull();
    expect(validateSafeguards({ dailyLossLimit: 12.5 })).toBeNull();
    for (const bad of [-1, NaN, "5" as unknown as number, null as unknown as number]) expect(validateSafeguards({ dailyLossLimit: bad })).toMatch(/Daily loss limit/);
    expect(() => updateBot(TEST_BOT_ID, { safeguards: { dailyLossLimit: -3 } })).toThrow(/Daily loss limit/);
  });
});
