import "server-only";
import crypto from "node:crypto";
import { watchOrder } from "./orderWatch";
import { ordersStore, positionsStore } from "./store";
import type { BrokerExecutor, Order, OrderKind, OrderState } from "./types";

export interface PlaceAndWatchOptions {
  executor: BrokerExecutor;
  kind: OrderKind;
  positionId: string;
  now: number;
  /** Sends one order at `price` (null = the executor's own default price). */
  place: (price: number | null) => Promise<{ ref: string }>;
  /** The SmartPricing rungs to try in order, or null for a single order at the default price. */
  prices: number[] | null;
  /** How long each rung but the last waits. */
  stepMs: number;
  /** How long the last rung (the final price) waits - and a partial fill keeps waiting for the rest. */
  finalMs: number;
  pollMs: number;
  /** The limit recorded on the order row when no price was chosen (open: the expected credit; close: 0). */
  defaultLimit: number;
  /** How many contracts the order is for, only to word the steps ("filled 1 of 2"). */
  quantity?: number;
}

/** "10s", "2m", or milliseconds for the very short waits tests use. */
export function formatWait(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  return seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

export type PlaceAndWatchResult =
  | { ok: true; state: OrderState; timedOut: boolean; ref: string; rungsTried: number; steps: string[] }
  | { ok: false; stage: "place" | "watch"; ref: string | null; error: unknown; steps: string[] };

/**
 * Places an order, waits for its fill, and - when there are several prices - walks
 * down the ladder: a rung that doesn't fill in its time is canceled and the next
 * price is sent. The last price waits out the full timeout, then cancels.
 * A rung that fills even partly stops the walk (Option Alpha: wait for the rest,
 * restarting the full timeout on each further partial fill; if no more comes, the
 * remainder is canceled and the position keeps what filled).
 * Every rung is its own order row, so the log shows each price that was tried.
 */
export async function placeAndWatch(opts: PlaceAndWatchOptions): Promise<PlaceAndWatchResult> {
  const rungs = opts.prices ?? [null];
  let lastRef: string | null = null;
  /** One line per price tried, for the run trace. */
  const steps: string[] = [];
  const of = opts.quantity ? ` of ${opts.quantity}` : "";

  for (let i = 0; i < rungs.length; i++) {
    const price = rungs[i];
    const last = i === rungs.length - 1;
    const label = opts.prices ? `Price ${i + 1} of ${rungs.length}` : "Single price";
    const amount = price !== null ? `$${price.toFixed(2)}` : "the executor's own price";
    const waitMs = last ? opts.finalMs : opts.stepMs;

    let ref: string;
    try {
      ({ ref } = await opts.place(price));
    } catch (error) {
      steps.push(`${label}: ${amount} - the order could not be sent (${error instanceof Error ? error.message : String(error)})`);
      return { ok: false, stage: "place", ref: lastRef, error, steps };
    }
    lastRef = ref;
    positionsStore.update(opts.positionId, { brokerOrderRef: ref });

    const row: Order = {
      id: `ord-${opts.now}-${crypto.randomUUID()}`,
      positionId: opts.positionId,
      kind: opts.kind,
      status: "working",
      limitPrice: price ?? opts.defaultLimit,
      filledQuantity: 0,
      ref,
      createdAt: opts.now,
      updatedAt: opts.now,
    };
    ordersStore.insert(row);

    let watched: Awaited<ReturnType<typeof watchOrder>>;
    try {
      watched = await watchOrder(opts.executor, ref, { timeoutMs: last ? opts.finalMs : opts.stepMs, pollIntervalMs: opts.pollMs, partialTimeoutMs: opts.finalMs });
    } catch (error) {
      steps.push(`${label}: ${amount}, waited up to ${formatWait(waitMs)} - lost track of the order (${error instanceof Error ? error.message : String(error)})`);
      return { ok: false, stage: "watch", ref, error, steps };
    }
    const { state, timedOut } = watched;
    steps.push(`${label}: ${amount}, waited up to ${formatWait(waitMs)} - ${describeResult(state, timedOut, of, formatWait(opts.finalMs))}`);
    ordersStore.update(row.id, { status: state.status, filledQuantity: state.filledQuantity, rejectReason: state.rejectReason, updatedAt: Date.now() });

    // Nothing filled and we canceled it ourselves because the rung's time ran out: try the next price.
    if (!last && timedOut && state.filledQuantity === 0) continue;
    return { ok: true, state, timedOut, ref, rungsTried: i + 1, steps };
  }
  throw new Error("unreachable: a ladder always has a last rung");
}

function describeResult(state: OrderState, timedOut: boolean, of: string, partialWait: string): string {
  if (state.status === "rejected") return `rejected${state.rejectReason ? `: ${state.rejectReason}` : ""}`;
  if (state.status === "filled") return `filled ${state.filledQuantity}${of}`;
  if (state.filledQuantity > 0) {
    return timedOut
      ? `partly filled (${state.filledQuantity}${of}); no more fills in ${partialWait}, so the rest was canceled`
      : `partly filled (${state.filledQuantity}${of}), then canceled`;
  }
  return timedOut ? "not filled in time, canceled" : "ended without a fill";
}
