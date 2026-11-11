import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as hookRoute } from "@/app/api/webhook/hook/[token]/route";
import { ensureBotRecord } from "./bots";
import { recordError } from "./errors";
import type { MockExecutor } from "./executor";
import { getExecutor } from "./sharedExecutor";
import { botsStore, decisionsStore as allDecisions, errorsStore, positionsStore, signalsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import { attachWebhook, createWebhook, updateWebhook } from "./webhooks";

// The guards between a TradingView alert and a trade. Every test fires alerts at the real webhook route and checks the same
// four things: nothing was sent to the broker, no position exists, the Log says why, and (where it matters) the bot trades
// normally once the problem is gone. No network, and nothing touches a real webhook or broker.

const feed = vi.hoisted(() => ({ price: 21_003.7, ageMs: 0 }));
vi.mock("@/lib/marketData/tickStore", () => ({
  waitForTick: async () => ({ t: Date.now() - feed.ageMs, price: feed.price }),
  getLastTick: () => ({ t: Date.now() - feed.ageMs, price: feed.price }),
  isLiveSymbol: () => false,
}));

setNdxTestEnv();

const MIN = 60_000;
let bull: ReturnType<typeof createWebhook>;
let bear: ReturnType<typeof createWebhook>;
let broker: MockExecutor;
let clock = BASE_NOW;

const decisions = () => allDecisions.all().filter((d) => d.signalId !== null);
const outcomes = () => decisions().map((d) => d.outcome);
const mine = () => positionsStore.all().filter((p) => p.botId === NDX_BOT_ID);
const held = () => mine().filter((p) => p.status === "open" || p.status === "opening" || p.status === "closing");
const sent = () => broker.placedOrders.map((o) => `${o.kind} ${o.positionType === "short_put_spread" ? "PUT" : "CALL"}`);
const bot = () => botsStore.get(NDX_BOT_ID)!;

/** An alert as TradingView sends it, at an exact moment (a fresh minute after the last unless `at` says), and wait for the bot to finish. */
async function alert(hook: typeof bull, at?: number, text?: string) {
  clock = at ?? clock + 2 * MIN;
  vi.setSystemTime(clock);
  const res = await hookRoute(
    new NextRequest(`http://localhost/hook/${hook.token}`, { method: "POST", body: text ?? (hook === bull ? "bullish" : "bearish"), headers: { "Content-Type": "text/plain" } }),
    { params: Promise.resolve({ token: hook.token }) },
  );
  let last = "";
  let stable = 0;
  for (let i = 0; i < 300 && stable < 4; i++) {
    const now = `${allDecisions.all().length}|${broker.placedOrders.length}|${mine().map((p) => p.status).join(",")}|${signalsStore.all().length}`;
    stable = now === last ? stable + 1 : 0;
    last = now;
    await new Promise((r) => setTimeout(r, 15));
  }
  return res;
}

/** Nothing happened: no order, no position, and the Log has the reason. */
function expectBlocked(outcome: string) {
  expect(sent()).toEqual([]);
  expect(held()).toHaveLength(0);
  expect(outcomes().at(-1)).toBe(outcome);
  expect(decisions().at(-1)!.reason.length).toBeGreaterThan(5);
}

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  vi.stubEnv("EXECUTOR", "mock");
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
  vi.stubEnv("AUTOMATION_DRY_RUN", "");
  vi.stubEnv("FLIP_COOLDOWN_SECONDS", "");
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
  broker = getExecutor() as MockExecutor;
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = BASE_NOW - 2 * MIN;
  vi.setSystemTime(clock);
  feed.price = 21_003.7;
  feed.ageMs = 0;
  ensureBotRecord(NDX_BOT_ID);
  bull = createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
  bear = createWebhook({ name: "BearishNDX", botId: NDX_BOT_ID, direction: "bearish" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
});

describe("the switches", () => {
  it("kill switch: nothing runs at all, closes included, and a position already held is left exactly as it is", async () => {
    await alert(bull);
    botsStore.update(NDX_BOT_ID, { killSwitch: true });
    await alert(bear);
    expect(sent()).toEqual(["open PUT"]); // nothing new was sent
    expect(held().map((p) => [p.type, p.status])).toEqual([["short_put_spread", "open"]]);
    expect(outcomes().at(-1)).toBe("kill_switch");
    botsStore.update(NDX_BOT_ID, { killSwitch: false });
    await alert(bear);
    expect(sent()).toEqual(["open PUT", "close PUT", "open CALL"]); // and it works again once switched off
  });

  it("bot off with nothing held: nothing opens", async () => {
    botsStore.update(NDX_BOT_ID, { enabled: false });
    await alert(bull);
    expectBlocked("automations_off");
  });

  it("bot off with the opposite side held: it may close, never open", async () => {
    await alert(bull);
    botsStore.update(NDX_BOT_ID, { enabled: false });
    await alert(bear);
    expect(sent()).toEqual(["open PUT", "close PUT"]);
    expect(held()).toHaveLength(0);
  });

  it("a direction switched off on its own: that alert does nothing, the other direction still trades", async () => {
    botsStore.update(NDX_BOT_ID, { triggers: { bullish: false, bearish: true } });
    await alert(bull);
    expectBlocked("trigger_disabled");
    await alert(bear);
    expect(sent()).toEqual(["open CALL"]);
  });
});

describe("the clock", () => {
  // New York time. October 2026 is daylight time (UTC-4), November is standard time (UTC-5).
  const et = (month: number, day: number, h: number, m: number, offset = 4) => Date.UTC(2026, month - 1, day, h + offset, m);

  it.each([
    ["one minute before the window opens (9:34am)", et(10, 6, 9, 34), false],
    ["the minute the window opens (9:35am)", et(10, 6, 9, 35), true],
    ["the last minute of the window (3:55pm)", et(10, 6, 15, 55), true],
    ["one minute after the window closes (3:56pm)", et(10, 6, 15, 56), false],
    ["after the close, in the evening (6:00pm)", et(10, 6, 18, 0), false],
    ["before the open, overnight (3:00am)", et(10, 6, 3, 0), false],
    ["a Saturday at 10:40am", et(10, 10, 10, 40), false],
    ["a Sunday at 10:40am", et(10, 11, 10, 40), false],
    ["Thanksgiving, a market holiday, at 10:40am", et(11, 26, 10, 40, 5), false],
    ["Christmas Day at 10:40am", et(12, 25, 10, 40, 5), false],
    ["the day after Thanksgiving (1pm early close): 12:55pm is the last minute", et(11, 27, 12, 55, 5), true],
    ["the day after Thanksgiving: 12:56pm is too late", et(11, 27, 12, 56, 5), false],
    ["the day after Thanksgiving: 3:00pm, long after the early close", et(11, 27, 15, 0, 5), false],
  ])("%s", async (_name, at, allowed) => {
    const res = await alert(bull, at);
    expect(res.status).toBe(200); // TradingView is always answered, whatever the bot decides
    if (allowed) {
      expect(sent()).toEqual(["open PUT"]);
    } else {
      expectBlocked("outside_hours");
    }
  });
});

describe("the price", () => {
  it.each([
    ["an SPX-sized price on the NDX bot", 7_700],
    ["just under the allowed range", 14_999],
    ["just over the allowed range", 30_001],
    ["zero", 0],
  ])("%s is refused, and the next good price trades", async (_name, price) => {
    feed.price = price;
    await alert(bull);
    expect(sent()).toEqual([]);
    expect(held()).toHaveLength(0);
    feed.price = 21_003.7;
    await alert(bull);
    expect(sent()).toEqual(["open PUT"]);
  });

  it("a quote more than a minute old is not traded on: the alert is refused and logged, nothing is sent", async () => {
    feed.ageMs = 90_000;
    const res = await alert(bull);
    expect(res.status).toBe(200); // answered at once (the price is looked for behind the answer)
    // ...and when none arrives the call is logged as rejected (the wait for a quote is real time, so give it a moment)
    for (let i = 0; i < 300 && !signalsStore.all().some((s) => s.rejectReason === "no_price"); i++) await new Promise((r) => setTimeout(r, 50));
    expect(sent()).toEqual([]);
    expect(held()).toHaveLength(0);
    expect(signalsStore.all().at(-1)).toMatchObject({ status: "rejected", rejectReason: "no_price" });
    feed.ageMs = 45_000; // recent enough
    await alert(bull);
    expect(sent()).toEqual(["open PUT"]);
  });
});

describe("the limits", () => {
  it("allocation: a position that would risk more than the allocation is not opened, and the bot switches itself off and flags it", async () => {
    vi.stubEnv("BOT_NDX_EMA_BIAS_QUANTITY", "4"); // 4 contracts x $650 of risk each is more than the $2,000 allocation
    await alert(bull);
    expectBlocked("allocation_limit_reached");
    expect(bot()).toMatchObject({ enabled: false, needsAttention: true });
  });

  it("total positions: at the limit the bot opens nothing more, switches itself off and flags it", async () => {
    botsStore.update(NDX_BOT_ID, { safeguards: { maxPositionsPerType: 5, totalPositionLimit: 1 } });
    await alert(bull);
    expect(sent()).toEqual(["open PUT"]);
    await alert(bull);
    expect(sent()).toEqual(["open PUT"]); // no second order
    expect(outcomes().at(-1)).toBe("total_position_limit_reached");
    expect(bot()).toMatchObject({ enabled: false, needsAttention: true });
  });

  it("daily limit: after the allowed number of new positions in a day the bot stops and flags itself", async () => {
    botsStore.update(NDX_BOT_ID, { safeguards: { dailyNewPositionLimit: 2 } });
    await alert(bull);
    await alert(bear);
    await alert(bull); // would be the third
    expect(sent().filter((s) => s.startsWith("open"))).toHaveLength(2);
    expect(outcomes().at(-1)).toBe("daily_limit_reached");
    expect(bot()).toMatchObject({ enabled: false, needsAttention: true });
    expect(held()).toHaveLength(0); // the old side was closed; nothing new opened
  });

  it("the next trading day starts the count again, once a person has switched the bot back on", async () => {
    botsStore.update(NDX_BOT_ID, { safeguards: { dailyNewPositionLimit: 1 } });
    await alert(bull);
    await alert(bear); // the flip closes, then is stopped by the limit
    expect(bot().enabled).toBe(false);
    botsStore.update(NDX_BOT_ID, { enabled: true, needsAttention: false });
    await alert(bear, BASE_NOW + 24 * 60 * MIN); // the next day
    expect(sent().filter((s) => s.startsWith("open"))).toHaveLength(2);
  });

  it("error failsafe: ten errors in one day switch the bot off, and nothing then opens", async () => {
    for (let i = 0; i < 10; i++) recordError(NDX_BOT_ID, "close_failed", { n: i }, clock);
    expect(bot()).toMatchObject({ enabled: false, needsAttention: true });
    expect(allDecisions.all().some((d) => d.outcome === "error_failsafe")).toBe(true);
    await alert(bull);
    expectBlocked("automations_off");
  });

  it("nine errors do not stop it", async () => {
    for (let i = 0; i < 9; i++) recordError(NDX_BOT_ID, "close_failed", { n: i }, clock);
    expect(bot().enabled).toBe(true);
    expect(errorsStore.all()).toHaveLength(9);
    await alert(bull);
    expect(sent()).toEqual(["open PUT"]);
  });
});

describe("holding rules", () => {
  it("day trading off: a position opened today is held, not closed by a flip, and nothing opposite is opened", async () => {
    botsStore.update(NDX_BOT_ID, { safeguards: { dayTrading: false } });
    await alert(bull);
    await alert(bear);
    expect(sent()).toEqual(["open PUT"]);
    expect(held().map((p) => p.type)).toEqual(["short_put_spread"]);
    expect(outcomes().at(-1)).toBe("day_trading_blocked");
  });

  it("flip cooldown: an opposite alert inside the minimum hold time changes nothing; after it, the flip goes through", async () => {
    vi.stubEnv("FLIP_COOLDOWN_SECONDS", "600");
    await alert(bull);
    await alert(bear); // 2 minutes later
    expect(sent()).toEqual(["open PUT"]);
    expect(outcomes().at(-1)).toBe("cooldown_active");
    await alert(bear, clock + 12 * MIN);
    expect(sent()).toEqual(["open PUT", "close PUT", "open CALL"]);
  });

  it("dry run: the whole decision is made and logged, and nothing is sent or recorded as a position", async () => {
    vi.stubEnv("AUTOMATION_DRY_RUN", "true");
    await alert(bull);
    expectBlocked("dry_run");
  });

  it("the same side again opens nothing, however many times it is sent", async () => {
    await alert(bull);
    for (let i = 0; i < 4; i++) await alert(bull);
    expect(sent()).toEqual(["open PUT"]);
    expect(held()).toHaveLength(1);
  });
});

describe("the webhook address itself", () => {
  const status = async (token: string, text = "bullish") => (await hookRoute(new NextRequest(`http://localhost/hook/${token}`, { method: "POST", body: text }), { params: Promise.resolve({ token }) })).status;

  it("an address nobody gave out, a switched-off webhook and a made-up token all answer 404 and trade nothing", async () => {
    updateWebhook(bear.id, { active: false });
    expect(await status("not-a-real-token")).toBe(404);
    expect(await status(bear.token, "bearish")).toBe(404);
    expect(await status("")).toBe(404);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent()).toEqual([]);
    expect(held()).toHaveLength(0);
  });

  it("a webhook not attached to a trigger is refused (409) and trades nothing", async () => {
    const loose = createWebhook({ name: "Loose", botId: null, direction: null });
    expect(await status(loose.token)).toBe(409);
    attachWebhook(loose.id, NDX_BOT_ID, "bullish");
    await new Promise((r) => setTimeout(r, 50));
    expect(sent()).toEqual([]);
  });

  it("an alert whose words disagree with its address is refused (422) and trades nothing", async () => {
    expect(await status(bull.token, "NDX bearish")).toBe(422);
    expect(await status(bull.token, "no direction word here")).toBe(422);
    expect(await status(bull.token, "bullish and bearish")).toBe(422);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent()).toEqual([]);
    expect(held()).toHaveLength(0);
  });

  it("the same address twice within a minute trades once", async () => {
    await alert(bull);
    await alert(bull, clock + 20_000);
    expect(sent()).toEqual(["open PUT"]);
    expect(signalsStore.all().filter((s) => s.rejectReason === "webhook_rate_limited")).toHaveLength(1);
  });

  it("nothing the caller puts in the message changes what trades: a price, a bot name, a strike or a quantity are ignored", async () => {
    await alert(bull, undefined, 'bullish {"price":99999,"bot":"spx_ema_bias","quantity":50,"shortStrike":1,"symbol":"SPX"}');
    expect(sent()).toEqual(["open PUT"]);
    const [p] = held();
    expect(p).toMatchObject({ botId: NDX_BOT_ID, underlying: "NDX", requestedQuantity: 1 });
    expect(p.shortStrike).toBeGreaterThan(20_000);
  });
});
