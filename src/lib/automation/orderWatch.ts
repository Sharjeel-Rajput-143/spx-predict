import "server-only";
import type { BrokerExecutor, OrderState, OrderStatus } from "./types";

const TERMINAL: readonly OrderStatus[] = ["filled", "canceled", "rejected"];

export interface WatchOrderOptions {
  timeoutMs: number;
  pollIntervalMs: number;
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

/** Polls getOrder() until a terminal state or timeout. Per spec: "on a
 * partial fill the timeout resets" - so the deadline moves forward every
 * time filledQuantity changes, not just once at the start. */
export async function watchOrder(executor: BrokerExecutor, ref: string, options: WatchOrderOptions): Promise<WatchOrderResult> {
  const { timeoutMs, pollIntervalMs } = options;
  let deadline = Date.now() + timeoutMs;
  let lastFilledQuantity = -1;

  for (;;) {
    const state = await executor.getOrder(ref);
    if (TERMINAL.includes(state.status)) return { state, timedOut: false };

    if (state.filledQuantity !== lastFilledQuantity) {
      lastFilledQuantity = state.filledQuantity;
      deadline = Date.now() + timeoutMs;
    }

    if (Date.now() >= deadline) {
      await executor.cancelOrder(ref);
      const finalState = await executor.getOrder(ref);
      return { state: finalState, timedOut: true };
    }

    await sleep(pollIntervalMs);
  }
}
