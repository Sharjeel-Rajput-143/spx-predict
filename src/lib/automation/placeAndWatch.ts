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
}

export type PlaceAndWatchResult =
  | { ok: true; state: OrderState; timedOut: boolean; ref: string; rungsTried: number }
  | { ok: false; stage: "place" | "watch"; ref: string | null; error: unknown };

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

  for (let i = 0; i < rungs.length; i++) {
    const price = rungs[i];
    const last = i === rungs.length - 1;

    let ref: string;
    try {
      ({ ref } = await opts.place(price));
    } catch (error) {
      return { ok: false, stage: "place", ref: lastRef, error };
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
      return { ok: false, stage: "watch", ref, error };
    }
    const { state, timedOut } = watched;
    ordersStore.update(row.id, { status: state.status, filledQuantity: state.filledQuantity, rejectReason: state.rejectReason, updatedAt: Date.now() });

    // Nothing filled and we canceled it ourselves because the rung's time ran out: try the next price.
    if (!last && timedOut && state.filledQuantity === 0) continue;
    return { ok: true, state, timedOut, ref, rungsTried: i + 1 };
  }
  throw new Error("unreachable: a ladder always has a last rung");
}
