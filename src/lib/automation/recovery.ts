import "server-only";
import { logDecision } from "./decisions";
import { ensureBotRecord } from "./bots";
import { botsStore, ordersStore, positionsStore } from "./store";
import type { BrokerExecutor, Position } from "./types";

/**
 * If the process dies mid-order (a crash, a deploy, a restart) a position is left
 * "opening" or "closing" with an order that may have filled at the broker in the
 * meantime. This reads each such order back from the broker and settles what is
 * certain, and flags what isn't. It never sends a new order and never cancels one:
 * a person decides about anything still working.
 */

export interface RecoveryResult {
  positionId: string;
  botId: string;
  was: "opening" | "closing";
  action: "opened" | "closed" | "rejected" | "reverted_to_open" | "flagged";
  detail: string;
}

export async function recoverInFlightPositions(executor: BrokerExecutor, now: number = Date.now()): Promise<RecoveryResult[]> {
  const results: RecoveryResult[] = [];
  const stuck = positionsStore.query((p) => p.status === "opening" || p.status === "closing");

  for (const position of stuck) {
    const was = position.status as "opening" | "closing";
    const done = (action: RecoveryResult["action"], detail: string) => results.push({ positionId: position.id, botId: position.botId, was, action, detail });
    const flag = (reason: string) => {
      ensureBotRecord(position.botId);
      botsStore.update(position.botId, { needsAttention: true, needsAttentionReason: reason.slice(0, 300) });
      logDecision({ signalId: null, botId: position.botId, outcome: "executor_error", reason: reason.slice(0, 500), detail: { recovery: true, positionId: position.id }, now });
      done("flagged", reason);
    };

    if (!position.brokerOrderRef) {
      flag(`After a restart, a ${was} position (${position.shortStrike}/${position.longStrike}) has no order reference. Check the broker.`);
      continue;
    }
    let state;
    try {
      state = await executor.getOrder(position.brokerOrderRef);
    } catch (err) {
      flag(`After a restart, order ${position.brokerOrderRef} for a ${was} position couldn't be read back (${err instanceof Error ? err.message : String(err)}). Check the broker.`);
      continue;
    }
    const wanted = position.filledQuantity || position.requestedQuantity;
    const order = ordersStore.query((o) => o.ref === position.brokerOrderRef)[0];
    if (order) ordersStore.update(order.id, { status: state.status, filledQuantity: state.filledQuantity, rejectReason: state.rejectReason, updatedAt: now });

    if (was === "opening") {
      if (state.status === "filled" || ((state.status === "canceled" || state.status === "partially_filled") && state.filledQuantity > 0)) {
        if (state.status === "partially_filled") {
          flag(`After a restart, the opening order ${position.brokerOrderRef} is only partly filled (${state.filledQuantity} of ${position.requestedQuantity}) and may still be working. Check the broker.`);
          continue;
        }
        positionsStore.update(position.id, { status: "open", filledQuantity: state.filledQuantity, credit: state.averagePrice ?? position.credit });
        logDecision({ signalId: position.openSignalId, botId: position.botId, outcome: "opened", reason: `Recovered after a restart: the opening order had filled (${state.filledQuantity}).`, detail: { recovery: true, positionId: position.id }, now });
        done("opened", `filled ${state.filledQuantity}`);
      } else if (state.status === "rejected" || state.status === "canceled") {
        positionsStore.update(position.id, { status: "rejected" });
        done("rejected", state.status);
      } else {
        flag(`After a restart, the opening order ${position.brokerOrderRef} is still ${state.status} at the broker. It was left alone - check the broker.`);
      }
      continue;
    }

    // closing
    if (state.status === "filled" && state.filledQuantity >= wanted) {
      positionsStore.update(position.id, { status: "closed", closedAt: now, closePrice: state.averagePrice ?? null });
      logDecision({ signalId: position.closeSignalId, botId: position.botId, outcome: "closed", reason: "Recovered after a restart: the closing order had filled.", detail: { recovery: true, positionId: position.id }, now });
      done("closed", "filled");
    } else if ((state.status === "canceled" || state.status === "rejected") && state.filledQuantity === 0) {
      positionsStore.update(position.id, { status: "open" });
      flag(`After a restart, the closing order ${position.brokerOrderRef} had ended without filling, so the position is open again. The flip it belonged to did not finish - check the broker.`);
      results[results.length - 1] = { ...results[results.length - 1], action: "reverted_to_open" };
    } else {
      flag(`After a restart, the closing order ${position.brokerOrderRef} is ${state.status} (${state.filledQuantity} of ${wanted} filled). It was left alone - check the broker.`);
    }
  }
  return results;
}

export const isInFlight = (p: Position) => p.status === "opening" || p.status === "closing";
