import "server-only";
import type { BrokerExecutor, OrderState, OrderStatus } from "./types";

const TERMINAL: readonly OrderStatus[] = ["filled", "canceled", "rejected"];

export interface WatchOrderOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  /** How long to keep waiting once part of the order has filled (each new partial fill restarts it).
   * Option Alpha waits the full default timeout (2 minutes) for the rest of a partial fill, even on a
   * rung whose own wait is only seconds. Unset = the same as `timeoutMs`. */
  partialTimeoutMs?: number;
}

export interface WatchOrderResult {
  state: OrderState;
  /** True when the timeout elapsed and the engine had to cancel the
   * remainder itself, rather than the order reaching a terminal state on
   * its own. */
  timedOut: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long to wait before each of the first looks at an order, capped by the usual poll interval. */
const EARLY_LOOKS_MS = [200, 400, 800];

/** Polls getOrder() until a terminal state or timeout. Per spec: "on a
 * partial fill the timeout resets" - so the deadline moves forward every
 * time filledQuantity changes, not just once at the start. */
export async function watchOrder(executor: BrokerExecutor, ref: string, options: WatchOrderOptions): Promise<WatchOrderResult> {
  const { timeoutMs, pollIntervalMs, partialTimeoutMs = timeoutMs } = options;
  let deadline = Date.now() + timeoutMs;
  let lastFilledQuantity = -1;
  let looks = 0;

  for (;;) {
    const state = await executor.getOrder(ref);
    if (TERMINAL.includes(state.status)) return { state, timedOut: false };

    if (state.filledQuantity !== lastFilledQuantity) {
      lastFilledQuantity = state.filledQuantity;
      deadline = Date.now() + (state.filledQuantity > 0 ? partialTimeoutMs : timeoutMs);
    }

    if (Date.now() >= deadline) {
      await executor.cancelOrder(ref);
      const finalState = await executor.getOrder(ref);
      return { state: finalState, timedOut: true };
    }

    // Orders that are going to fill usually do so within a second or two: look again sooner at first, then settle to the usual pace.
    await sleep(Math.min(pollIntervalMs, EARLY_LOOKS_MS[looks++] ?? pollIntervalMs));
  }
}
