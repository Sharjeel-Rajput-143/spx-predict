import { describe, expect, it } from "vitest";
import { MockExecutor } from "./executor";
import { watchOrder } from "./orderWatch";
import type { BrokerExecutor, OrderState } from "./types";
import { NDX_BOT_ID } from "./testSupport";

// How soon the engine notices that an order has filled: every poll interval spent waiting is time the position isn't yet open
// (or closed). No network.

describe("noticing a fill", () => {
  it("an order the mock fills at once is already filled the first time it is looked at", async () => {
    const mock = new MockExecutor();
    const { ref } = await mock.placeOpenOrder({ botId: NDX_BOT_ID, positionType: "short_put_spread", shortStrike: 21_000, longStrike: 20_990, quantity: 1, limitCredit: 3.5 } as never);
    expect((await mock.getOrder(ref)).status).toBe("filled");
  });

  it("so the engine does not sleep a poll interval for it: with a 2-second interval a mock order is confirmed in well under a second", async () => {
    const mock = new MockExecutor();
    const { ref } = await mock.placeOpenOrder({ botId: NDX_BOT_ID, positionType: "short_put_spread", shortStrike: 21_000, longStrike: 20_990, quantity: 1, limitCredit: 3.5 } as never);
    const t0 = Date.now();
    const out = await watchOrder(mock, ref, { timeoutMs: 5000, pollIntervalMs: 2000 });
    expect(out.state.status).toBe("filled");
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("a broker order that fills a moment later is noticed within about half a second, not after a whole 2-second interval", async () => {
    const fillAt = Date.now() + 150;
    const slowFill = {
      getOrder: async (): Promise<OrderState> => (Date.now() >= fillAt ? { status: "filled", filledQuantity: 1, averagePrice: 3.3 } : { status: "working", filledQuantity: 0 }),
      cancelOrder: async () => {},
    } as unknown as BrokerExecutor;
    const t0 = Date.now();
    const out = await watchOrder(slowFill, "x", { timeoutMs: 5000, pollIntervalMs: 2000 });
    expect(out.state.status).toBe("filled");
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("an order that never fills is still given up on at the timeout, and cancelled", async () => {
    let cancelled = false;
    const never = {
      getOrder: async (): Promise<OrderState> => (cancelled ? { status: "canceled", filledQuantity: 0 } : { status: "working", filledQuantity: 0 }),
      cancelOrder: async () => {
        cancelled = true;
      },
    } as unknown as BrokerExecutor;
    const out = await watchOrder(never, "x", { timeoutMs: 300, pollIntervalMs: 2000 });
    expect(out.timedOut).toBe(true);
    expect(out.state.status).toBe("canceled");
  });

  it("the usual poll interval is still the ceiling: a short interval is never stretched by the early looks", async () => {
    let calls = 0;
    const counting = { getOrder: async (): Promise<OrderState> => (++calls >= 6 ? { status: "filled", filledQuantity: 1 } : { status: "working", filledQuantity: 0 }), cancelOrder: async () => {} } as unknown as BrokerExecutor;
    const t0 = Date.now();
    await watchOrder(counting, "x", { timeoutMs: 5000, pollIntervalMs: 10 });
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
