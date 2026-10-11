import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as hookRoute } from "@/app/api/webhook/hook/[token]/route";
import { runEndOfDaySweep } from "./eodSweep";
import { createWebhook, findWebhookByToken } from "./webhooks";
import { botsStore, decisionsStore as allDecisions, ordersStore, positionsStore, signalsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";

// A whole trading day for the NDX Bias Bot on the MOCK executor, driven only the way production drives it: TradingView
// calls to the two webhook URLs, in time order. After every call the bot's books must still make sense. No network.

const feed = vi.hoisted(() => ({ price: 21_003.7 }));
vi.mock("@/lib/marketData/tickStore", () => ({
  waitForTick: async () => ({ t: Date.now(), price: feed.price }),
  getLastTick: () => ({ t: Date.now(), price: feed.price }),
  isLiveSymbol: () => false,
}));

setNdxTestEnv();

const MIN = 60_000;
/** Attaching a webhook is logged too; these tests are about what a TradingView call does. */
const decisions = () => allDecisions.all().filter((d) => d.signalId !== null);
const outcomes = () => decisions().map((d) => d.outcome);
const mine = () => positionsStore.all().filter((p) => p.botId === NDX_BOT_ID);
const active = () => mine().filter((p) => p.status === "open" || p.status === "opening" || p.status === "closing");

let bull: ReturnType<typeof createWebhook>;
let bear: ReturnType<typeof createWebhook>;

/** One TradingView call at `at`, with the alert text TradingView would send, then wait for the bot to finish with it. */
async function alert(hook: typeof bull, at: number) {
  vi.setSystemTime(at);
  const before = signalsStore.all().length;
  const res = await hookRoute(
    new NextRequest(`http://localhost/hook/${hook.token}`, { method: "POST", body: `NDX ${findWebhookByToken(hook.token)?.direction} signal`, headers: { "Content-Type": "text/plain" } }),
    { params: Promise.resolve({ token: hook.token }) },
  );
  expect(res.status).toBe(200);
  expect(signalsStore.all().length).toBe(before + 1);
  await idle();
  return res;
}

/** The bot is done with a call when no position is half-way and no run is still writing. */
async function idle() {
  let last = -1;
  for (let i = 0; i < 200; i++) {
    const n = decisions().length + ordersStore.all().length;
    const halfway = mine().some((p) => p.status === "opening" || p.status === "closing");
    if (n === last && !halfway) return;
    last = n;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("the bot never settled");
}

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  vi.stubEnv("EXECUTOR", "mock");
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_NOW); // Tuesday 10:40 New York
  feed.price = 21_003.7;
  bull = createWebhook({ name: "BullishNDX", botId: NDX_BOT_ID, direction: "bullish" });
  bear = createWebhook({ name: "BearishNDX", botId: NDX_BOT_ID, direction: "bearish" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("NDX Bias Bot, one day on the mock executor", () => {
  it("bullish opens a put spread and bearish opens a call spread, each fully filled with its own strikes", async () => {
    await alert(bull, BASE_NOW);
    expect(outcomes()).toEqual(["opened"]);
    const put = active()[0];
    expect(put).toMatchObject({ underlying: "NDX", type: "short_put_spread", status: "open", requestedQuantity: 1, filledQuantity: 1 });
    expect(put.shortStrike).toBeLessThan(feed.price); // a put spread sits below the market
    expect(put.longStrike).toBe(put.shortStrike - 10); // 10 points wide, long below short
    expect(put.credit).toBeGreaterThan(0);
    expect(put.credit).toBeLessThan(10); // never as much as the width

    await alert(bear, BASE_NOW + 5 * MIN);
    const call = active()[0];
    expect(call).toMatchObject({ type: "short_call_spread", status: "open" });
    expect(call.shortStrike).toBeGreaterThan(feed.price);
    expect(call.longStrike).toBe(call.shortStrike + 10);
  });

  it("a flip closes the old side first and only then opens the new one; the old position is kept as closed history", async () => {
    await alert(bull, BASE_NOW);
    await alert(bear, BASE_NOW + 5 * MIN);

    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
    expect(mine().map((p) => [p.type, p.status])).toEqual([["short_put_spread", "closed"], ["short_call_spread", "open"]]);
    // the close order was filled before the new open order was sent
    const orders = ordersStore.all().map((o) => [o.kind, o.status]);
    expect(orders).toEqual([["open", "filled"], ["close", "filled"], ["open", "filled"]]);
    const closedAt = mine()[0].closedAt!;
    expect(mine()[1].openedAt).toBeGreaterThanOrEqual(closedAt);
  });

  it("the same signal again is not a second trade: one position stays, the Log says why", async () => {
    await alert(bull, BASE_NOW);
    await alert(bull, BASE_NOW + 3 * MIN);
    await alert(bull, BASE_NOW + 9 * MIN);

    expect(mine()).toHaveLength(1);
    expect(outcomes()).toEqual(["opened", "already_in_position", "already_in_position"]);
    expect(ordersStore.all()).toHaveLength(1); // nothing was sent to the broker for the repeats
  });

  it("the same webhook twice inside a minute is answered but trades once", async () => {
    await alert(bull, BASE_NOW);
    vi.setSystemTime(BASE_NOW + 20_000);
    const res = await hookRoute(
      new NextRequest(`http://localhost/hook/${bull.token}`, { method: "POST", body: "NDX bullish signal" }),
      { params: Promise.resolve({ token: bull.token }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ignored).toMatch(/once a minute/);
    await idle();
    expect(mine()).toHaveLength(1);
  });

  it("outside trading hours nothing is traded, before the open or after the close", async () => {
    await alert(bull, Date.UTC(2026, 9, 6, 12, 0)); // 08:00 New York
    await alert(bear, Date.UTC(2026, 9, 6, 21, 30)); // 17:30 New York
    expect(mine()).toHaveLength(0);
    expect(outcomes()).toEqual(["outside_hours", "outside_hours"]);
    expect(ordersStore.all()).toHaveLength(0);
  });

  it("a price that makes no sense for the NDX is refused, and the next good alert still trades", async () => {
    feed.price = 7_700; // an SPX-sized price on the NDX bot
    await alert(bull, BASE_NOW);
    expect(mine()).toHaveLength(0);
    expect(outcomes()).toEqual(["price_out_of_range"]);

    feed.price = 21_003.7;
    await alert(bull, BASE_NOW + 2 * MIN);
    expect(outcomes()).toEqual(["price_out_of_range", "opened"]);
  });

  it("an alert that disagrees with its URL is refused, trades nothing, and does not block the right alert", async () => {
    vi.setSystemTime(BASE_NOW);
    const res = await hookRoute(
      new NextRequest(`http://localhost/hook/${bull.token}`, { method: "POST", body: "NDX Bearish signal" }),
      { params: Promise.resolve({ token: bull.token }) },
    );
    expect(res.status).toBe(422);
    await idle();
    expect(mine()).toHaveLength(0);
    await alert(bull, BASE_NOW + MIN);
    expect(outcomes().filter((o) => o === "opened")).toHaveLength(1);
    expect(active()[0].type).toBe("short_put_spread"); // the URL decided, never the text
  });

  it("at the end of the day the open position expires with a worked-out result, and tomorrow starts clean", async () => {
    await alert(bull, BASE_NOW);
    const held = active()[0];

    // 16:15 New York, the market a little higher than where it opened: a short put spread keeps its whole credit.
    const sweepAt = Date.UTC(2026, 9, 6, 20, 15);
    const count = await runEndOfDaySweep(sweepAt, NDX_BOT_ID, { underlyingPrice: () => 21_100 });
    expect(count).toBe(1);
    const done = positionsStore.get(held.id)!;
    expect(done.status).toBe("expired");
    expect(done.settlement).toMatchObject({ kind: "estimated" });
    expect(done.settlement!.pl).toBeCloseTo(held.credit! * 100, 2); // one contract: credit x 100
    expect(active()).toHaveLength(0);
    // sweeping again changes nothing
    expect(await runEndOfDaySweep(sweepAt + MIN, NDX_BOT_ID, { underlyingPrice: () => 21_100 })).toBe(0);

    // the next trading morning the same webhook opens a fresh position
    await alert(bull, Date.UTC(2026, 9, 7, 14, 40));
    expect(active()).toHaveLength(1);
    expect(active()[0].id).not.toBe(held.id);
  });

  it("a short spread that finishes through its short strike books a loss no larger than the width", async () => {
    await alert(bull, BASE_NOW);
    const held = active()[0];
    await runEndOfDaySweep(Date.UTC(2026, 9, 6, 20, 15), NDX_BOT_ID, { underlyingPrice: () => held.longStrike - 50 });
    const pl = positionsStore.get(held.id)!.settlement!.pl;
    expect(pl).toBeLessThan(0);
    expect(pl).toBeCloseTo(-(10 - held.credit!) * 100, 2); // the most it can lose: (width - credit) x 100
  });

  it("through a long run of alternating and repeated alerts the books always agree with the last signal, until the daily limit stops the bot", async () => {
    // A fixed pseudo-random order (no flakiness). After every call: at most one position, on the side of the last signal,
    // never a put and a call together. The bot may open 10 new positions a day; the flip that would be the 11th closes
    // the old side, opens nothing and switches the bot off, and every later alert then trades nothing.
    const LIMIT = 10;
    let seed = 20261010;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let at = BASE_NOW;
    let heldSide: "bullish" | "bearish" | null = null;
    let opened = 0;
    let stoppedAt = -1;

    for (let i = 0; i < 60 && stoppedAt < 0; i++) {
      at += 2 * MIN + Math.floor(next() * 3) * MIN; // always more than a minute apart
      const direction = next() < 0.5 ? "bullish" : "bearish";
      await alert(direction === "bullish" ? bull : bear, at);

      if (direction === heldSide) continue; // a repeat: nothing changes
      if (opened >= LIMIT) {
        stoppedAt = i;
        expect(outcomes().slice(-2)).toEqual(["closed", "daily_limit_reached"]);
        expect(active()).toHaveLength(0);
        expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ enabled: false, needsAttention: true });
        break;
      }
      opened++;
      heldSide = direction;
      const held = active();
      expect(held).toHaveLength(1);
      expect(held[0].type).toBe(direction === "bullish" ? "short_put_spread" : "short_call_spread");
      expect(held[0].status).toBe("open");
    }
    expect(stoppedAt).toBeGreaterThan(0); // the run did reach the limit

    // switched off: further alerts open nothing
    const ordersBefore = ordersStore.all().length;
    await alert(heldSide === "bullish" ? bear : bull, at + 5 * MIN);
    expect(active()).toHaveLength(0);
    expect(ordersStore.all()).toHaveLength(ordersBefore);

    // every order was filled and matches a position row; nothing is stuck half-way
    expect(mine().every((p) => p.status === "closed")).toBe(true);
    expect(mine()).toHaveLength(LIMIT);
    expect(ordersStore.all().every((o) => o.status === "filled")).toBe(true);
    expect(ordersStore.all().filter((o) => o.kind === "open")).toHaveLength(LIMIT);
    expect(ordersStore.all().filter((o) => o.kind === "close")).toHaveLength(LIMIT);
    expect(decisions().filter((d) => d.outcome === "open_rejected" || d.outcome === "close_rejected")).toHaveLength(0);
  });
});
