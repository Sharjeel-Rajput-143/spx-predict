import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as hookRoute } from "@/app/api/webhook/hook/[token]/route";
import { ensureBotRecord } from "./bots";
import type { MockExecutor } from "./executor";
import { getExecutor } from "./sharedExecutor";
import { botsStore, decisionsStore as allDecisions, positionsStore, signalsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import { createWebhook } from "./webhooks";

// TradingView calls the platform; the platform opens a position, or closes the one it holds and opens the other side
// (a flip). Every test here is that story: a TradingView-shaped request to a webhook URL, then what the platform sent to
// the broker (the mock) and what it now holds. The price is the NDX at 21,003.7, so the strikes are fixed:
//   bullish -> short PUT spread  20,970 / 20,960        bearish -> short CALL spread  21,035 / 21,045
// No network, and nothing touches a real webhook or broker.

const feed = vi.hoisted(() => ({ price: 21_003.7 }));
vi.mock("@/lib/marketData/tickStore", () => ({
  waitForTick: async () => ({ t: Date.now(), price: feed.price }),
  getLastTick: () => ({ t: Date.now(), price: feed.price }),
  isLiveSymbol: () => false,
}));

setNdxTestEnv();

const MIN = 60_000;
const PUT = "short_put_spread";
const CALL = "short_call_spread";
const PUT_LEGS = "20970/20960";
const CALL_LEGS = "21035/21045";

let bull: ReturnType<typeof createWebhook>;
let bear: ReturnType<typeof createWebhook>;
let broker: MockExecutor;
let clock = BASE_NOW;

/** The log lines of TradingView calls only (attaching a webhook is logged too). */
const outcomes = () => allDecisions.all().filter((d) => d.signalId !== null).map((d) => d.outcome);
const mine = () => positionsStore.all().filter((p) => p.botId === NDX_BOT_ID);
const held = () => mine().filter((p) => p.status === "open" || p.status === "opening" || p.status === "closing");
/** What the platform sent to the broker, in order: "open PUT 20970/20960 x1". */
const sent = () => broker.placedOrders.map((o) => `${o.kind} ${o.positionType === PUT ? "PUT" : "CALL"} ${o.shortStrike}/${o.longStrike} x${o.quantity}`);

/**
 * One TradingView alert: a text/plain POST to the webhook URL, as TradingView sends it, a minute and a bit after the last
 * one. `message` is the alert's message box; the URL, not the message, decides the direction.
 */
async function tradingView(hook: typeof bull, message?: string) {
  clock += 2 * MIN;
  vi.setSystemTime(clock);
  const text = message ?? `${hook === bull ? "bullish" : "bearish"}`;
  const res = await hookRoute(
    new NextRequest(`http://localhost/hook/${hook.token}`, { method: "POST", body: text, headers: { "Content-Type": "text/plain; charset=utf-8" } }),
    { params: Promise.resolve({ token: hook.token }) },
  );
  await idle();
  return res;
}

/** Finished when the log, the orders and the position rows have stopped changing for a moment. */
async function idle() {
  let last = "";
  let stable = 0;
  for (let i = 0; i < 300; i++) {
    const now = `${allDecisions.all().length}|${broker.placedOrders.length}|${mine().map((p) => p.status).join(",")}`;
    stable = now === last ? stable + 1 : 0;
    if (stable >= 4) return;
    last = now;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("the platform never finished with the alert");
}

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  vi.stubEnv("EXECUTOR", "mock");
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined; // a fresh broker for every test
  broker = getExecutor() as MockExecutor;
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = BASE_NOW - 2 * MIN;
  vi.setSystemTime(clock);
  feed.price = 21_003.7;
  ensureBotRecord(NDX_BOT_ID);
  bull = createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
  bear = createWebhook({ name: "BearishNDX", botId: NDX_BOT_ID, direction: "bearish" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
});

describe("TradingView alert with nothing held: open", () => {
  it("Bullish alert -> opens a short put spread, once, and answers TradingView at once", async () => {
    const res = await tradingView(bull);
    expect(res.status).toBe(200);
    expect(sent()).toEqual([`open PUT ${PUT_LEGS} x1`]);
    expect(held().map((p) => [p.type, p.status])).toEqual([[PUT, "open"]]);
    expect(signalsStore.all().map((s) => [s.signal, s.status])).toEqual([["bullish", "accepted"]]);
    expect(outcomes()).toEqual(["opened"]);
  });

  it("Bearish alert -> opens a short call spread", async () => {
    await tradingView(bear);
    expect(sent()).toEqual([`open CALL ${CALL_LEGS} x1`]);
    expect(held().map((p) => [p.type, p.status])).toEqual([[CALL, "open"]]);
  });

  it("works with whatever the alert message looks like: plain word, JSON, TradingView placeholders", async () => {
    // Each is a separate day-minute; after each one the platform must end up holding the put spread exactly once.
    for (const [i, message] of ['{"ticker":"NDX","interval":"5","action":"bullish"}', "NDX, 5: Bullish signal", "BULLISH"].entries()) {
      resetAutomationStores();
      setNdxTestEnv();
      (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined;
      broker = getExecutor() as MockExecutor;
      bull = createWebhook({ name: `BullishNDX${i}`, botId: NDX_BOT_ID, direction: "bullish" });
      await tradingView(bull, message);
      expect(sent(), message).toEqual([`open PUT ${PUT_LEGS} x1`]);
      expect(held(), message).toHaveLength(1);
    }
  });
});

describe("TradingView alert while holding the other side: flip", () => {
  it("holding the put spread, a Bearish alert closes it, waits for the fill, then opens the call spread", async () => {
    await tradingView(bull);
    await tradingView(bear);

    // The close is the exact position we hold (same strikes, same size) and it comes before the new open.
    expect(sent()).toEqual([`open PUT ${PUT_LEGS} x1`, `close PUT ${PUT_LEGS} x1`, `open CALL ${CALL_LEGS} x1`]);
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
    expect(mine().map((p) => [p.type, p.status])).toEqual([[PUT, "closed"], [CALL, "open"]]);
    expect(held()).toHaveLength(1);
    expect(mine()[0].closedAt ?? 0).toBeLessThanOrEqual((mine()[1].openedAt ?? Infinity));
  });

  it("holding the call spread, a Bullish alert flips back to the put spread", async () => {
    await tradingView(bear);
    await tradingView(bull);
    expect(sent()).toEqual([`open CALL ${CALL_LEGS} x1`, `close CALL ${CALL_LEGS} x1`, `open PUT ${PUT_LEGS} x1`]);
    expect(mine().map((p) => [p.type, p.status])).toEqual([[CALL, "closed"], [PUT, "open"]]);
  });

  it("alerts that keep flipping: every change of direction is one close and one open, never two positions at once", async () => {
    const calls = [bull, bear, bull, bear, bull];
    for (const hook of calls) {
      await tradingView(hook);
      expect(held()).toHaveLength(1);
      expect(held()[0].type).toBe(hook === bull ? PUT : CALL);
    }
    expect(sent()).toEqual([
      `open PUT ${PUT_LEGS} x1`,
      `close PUT ${PUT_LEGS} x1`,
      `open CALL ${CALL_LEGS} x1`,
      `close CALL ${CALL_LEGS} x1`,
      `open PUT ${PUT_LEGS} x1`,
      `close PUT ${PUT_LEGS} x1`,
      `open CALL ${CALL_LEGS} x1`,
    ].slice(0, 0).concat([
      `open PUT ${PUT_LEGS} x1`,
      `close PUT ${PUT_LEGS} x1`,
      `open CALL ${CALL_LEGS} x1`,
      `close CALL ${CALL_LEGS} x1`,
      `open PUT ${PUT_LEGS} x1`,
      `close PUT ${PUT_LEGS} x1`,
      `open CALL ${CALL_LEGS} x1`,
      `close CALL ${CALL_LEGS} x1`,
      `open PUT ${PUT_LEGS} x1`,
    ]).slice(0, 0).concat([
      `open PUT ${PUT_LEGS} x1`,
      `close PUT ${PUT_LEGS} x1`,
      `open CALL ${CALL_LEGS} x1`,
      `close CALL ${CALL_LEGS} x1`,
      `open PUT ${PUT_LEGS} x1`,
      `close PUT ${PUT_LEGS} x1`,
      `open CALL ${CALL_LEGS} x1`,
      `close CALL ${CALL_LEGS} x1`,
      `open PUT ${PUT_LEGS} x1`,
    ]).slice(0, 9));
    expect(mine().filter((p) => p.status === "closed")).toHaveLength(4);
  });

  it("the flip uses the market of the moment: new strikes follow the new price, the close keeps the old position's strikes", async () => {
    await tradingView(bull);
    feed.price = 21_100;
    await tradingView(bear);
    expect(sent()).toEqual([`open PUT ${PUT_LEGS} x1`, `close PUT ${PUT_LEGS} x1`, "open CALL 21130/21140 x1"]);
  });
});

describe("TradingView alert for the side already held: nothing", () => {
  it("a second Bullish alert (a later bar, or a repeat) sends no order and says why in the Log", async () => {
    await tradingView(bull);
    await tradingView(bull);
    await tradingView(bull);
    expect(sent()).toEqual([`open PUT ${PUT_LEGS} x1`]);
    expect(outcomes()).toEqual(["opened", "already_in_position", "already_in_position"]);
    expect(held()).toHaveLength(1);
  });
});

describe("a flip that goes wrong stays safe", () => {
  it("the broker refuses the close: nothing new is opened, the old position stays counted as held, the bot is flagged, and a repeat alert does not send a second close", async () => {
    await tradingView(bull);
    broker.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "no buying power" });
    await tradingView(bear);

    expect(sent()).toEqual([`open PUT ${PUT_LEGS} x1`, `close PUT ${PUT_LEGS} x1`]); // no call spread was sent
    expect(outcomes().at(-1)).toBe("close_rejected");
    expect(held().map((p) => p.type)).toEqual([PUT]); // still holding exactly what it held, and nothing on the other side
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ needsAttention: true });

    // The platform never guesses: with a close unconfirmed it sends no second close and opens nothing, until a person checks.
    await tradingView(bear);
    expect(sent()).toHaveLength(2);
    expect(outcomes().at(-1)).toBe("stuck_position");
    expect(held().map((p) => p.type)).toEqual([PUT]);
  });

  it("the close goes through but the new open is refused: the old side is flat, no position is half-open, and the next alert trades", async () => {
    await tradingView(bull);
    broker.queueScenario(NDX_BOT_ID, { kind: "instant" }); // the close fills
    broker.queueScenario(NDX_BOT_ID, { kind: "reject", reason: "market closed" }); // the open does not
    await tradingView(bear);

    expect(outcomes().slice(-2)).toEqual(["closed", "open_rejected"]);
    expect(held()).toHaveLength(0);
    expect(mine().map((p) => [p.type, p.status])).toEqual([[PUT, "closed"], [CALL, "rejected"]]);

    await tradingView(bear); // the same side again: the broker says yes this time
    expect(held().map((p) => [p.type, p.status])).toEqual([[CALL, "open"]]);
  });

  it("the broker connection drops while closing: TradingView still gets its answer, no call spread is opened, the old position stays held", async () => {
    await tradingView(bull);
    broker.queueScenario(NDX_BOT_ID, { kind: "throw", message: "socket hang up" });
    const res = await tradingView(bear);
    expect(res.status).toBe(200); // TradingView is never left waiting or told to retry
    expect(sent().filter((s) => s.startsWith("open CALL"))).toHaveLength(0);
    expect(outcomes().at(-1)).toBe("executor_error");
    expect(held().map((p) => p.type)).toEqual([PUT]);
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ needsAttention: true });
  });

  it("an alert whose text says the other direction is refused and the held position is untouched", async () => {
    await tradingView(bull);
    const ordersBefore = sent().length;
    const res = await tradingView(bull, "NDX bearish signal");
    expect(res.status).toBe(422);
    expect(sent()).toHaveLength(ordersBefore);
    expect(held().map((p) => p.type)).toEqual([PUT]);
  });
});

describe("the bot switched off", () => {
  it("an alert for the other side still closes what is held, but opens nothing new", async () => {
    await tradingView(bull);
    botsStore.update(NDX_BOT_ID, { enabled: false });
    await tradingView(bear);
    expect(sent()).toEqual([`open PUT ${PUT_LEGS} x1`, `close PUT ${PUT_LEGS} x1`]);
    expect(outcomes().slice(-3)).toEqual(["bot_off_close_only", "closed", "automations_off"]);
    expect(held()).toHaveLength(0);
  });

  it("an alert for the same side, or with nothing held, does nothing at all", async () => {
    botsStore.update(NDX_BOT_ID, { enabled: false });
    await tradingView(bull);
    expect(sent()).toEqual([]);
    expect(held()).toHaveLength(0);
  });
});
