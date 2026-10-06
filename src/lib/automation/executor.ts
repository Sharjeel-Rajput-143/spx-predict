import "server-only";
import crypto from "node:crypto";
import { positionsStore } from "./store";
import type { BrokerExecutor, OpenSpreadRequest, OrderState, Position } from "./types";

export type MockScenario =
  | { kind: "instant"; averagePrice?: number; delayMs?: number }
  | { kind: "delayed"; delayMs: number; averagePrice?: number }
  /** Fills `firstFillRatio` of the quantity after `delayMs`, then either fills
   * the remainder after `remainderDelayMs` or - if that's left unset/null -
   * never fills the remainder, so the engine's own timeout has to cancel it. */
  | { kind: "partial"; firstFillRatio: number; delayMs?: number; remainderDelayMs?: number | null; averagePrice?: number }
  | { kind: "reject"; reason: string; delayMs?: number }
  /** Stays "working" forever - only the engine's own timeout ends it. */
  | { kind: "never" }
  /** The place call itself throws, like a dropped connection would. */
  | { kind: "throw"; message: string };

export interface RecordedOrder {
  kind: "open" | "close";
  botId: string;
  positionType: Position["type"];
  shortStrike: number;
  longStrike: number;
  quantity: number;
  ref: string;
}

interface TrackedOrder {
  quantity: number;
  state: OrderState;
  timers: ReturnType<typeof setTimeout>[];
}

const DEFAULT_SCENARIO: MockScenario = { kind: "instant" };

export interface MockExecutorOptions {
  /** Report made-up close prices so the P/L screens have something to show.
   * Off by default: a mock has no market, so without this it reports no close
   * price at all and P/L stays unknown. Never enable it next to real money. */
  simulatePricing?: boolean;
}

/** Deterministic pseudo-random in [0, 1) from a string, so a given position
 * always "closes" at the same simulated price. */
function unitFromString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/** Roughly two in three simulated closes are winners, losers are capped below the width. */
export function simulatedCloseDebit(position: Position): number {
  const credit = position.credit ?? 1;
  const width = Math.abs(position.shortStrike - position.longStrike);
  const factor = 0.05 + 1.95 * Math.pow(unitFromString(position.id), 1.8);
  return Math.round(Math.min(credit * factor, width * 0.95) * 100) / 100;
}

/**
 * No network calls, no real pricing - just enough simulated async behavior
 * (delays, partial fills, rejections, orders that never fill) to exercise the
 * engine's failure paths the way a real broker eventually will in Phase 2.
 */
function scenarioPriceFor(position: Position, simulate: boolean): number | undefined {
  return simulate ? simulatedCloseDebit(position) : undefined;
}

export class MockExecutor implements BrokerExecutor {
  readonly venue = "mock" as const;
  private orders = new Map<string, TrackedOrder>();
  private scenarioQueues = new Map<string, MockScenario[]>();
  private simulatePricing: boolean;

  constructor(options: MockExecutorOptions = {}) {
    this.simulatePricing = options.simulatePricing ?? false;
  }

  /** Every order the engine has sent, in order - what tests assert on. */
  readonly placedOrders: RecordedOrder[] = [];

  /** Test hook: the next order placed for this bot consumes one queued
   * scenario (FIFO, so "close then open" in one flip can queue two in
   * order). An empty queue falls back to an instant full fill. */
  queueScenario(botId: string, scenario: MockScenario): void {
    const queue = this.scenarioQueues.get(botId) ?? [];
    queue.push(scenario);
    this.scenarioQueues.set(botId, queue);
  }

  private nextScenario(botId: string): MockScenario {
    const queue = this.scenarioQueues.get(botId);
    if (queue && queue.length > 0) return queue.shift()!;
    return DEFAULT_SCENARIO;
  }

  private schedule(tracked: TrackedOrder, ms: number, fn: () => void) {
    tracked.timers.push(setTimeout(fn, ms));
  }

  /** `fillPrice` is what the order reports as its average fill; undefined means "no price reported". */
  private place(order: Omit<RecordedOrder, "ref">, fillPrice: number | undefined): { ref: string } {
    const { botId, quantity } = order;
    const scenario = this.nextScenario(botId);
    if (scenario.kind === "throw") throw new Error(scenario.message);
    const ref = `mock-${crypto.randomUUID()}`;
    this.placedOrders.push({ ...order, ref });
    const tracked: TrackedOrder = { quantity, state: { status: "working", filledQuantity: 0 }, timers: [] };
    this.orders.set(ref, tracked);

    const priceOf = (s: { averagePrice?: number }) => s.averagePrice ?? fillPrice;

    switch (scenario.kind) {
      case "instant":
        this.schedule(tracked, scenario.delayMs ?? 0, () => {
          tracked.state = { status: "filled", filledQuantity: quantity, averagePrice: priceOf(scenario) };
        });
        break;
      case "delayed":
        this.schedule(tracked, scenario.delayMs, () => {
          tracked.state = { status: "filled", filledQuantity: quantity, averagePrice: priceOf(scenario) };
        });
        break;
      case "partial": {
        const firstQty = Math.max(1, Math.min(quantity, Math.floor(quantity * scenario.firstFillRatio)));
        this.schedule(tracked, scenario.delayMs ?? 0, () => {
          tracked.state = { status: "partially_filled", filledQuantity: firstQty, averagePrice: priceOf(scenario) };
          if (scenario.remainderDelayMs != null) {
            this.schedule(tracked, scenario.remainderDelayMs, () => {
              tracked.state = { status: "filled", filledQuantity: quantity, averagePrice: priceOf(scenario) };
            });
          }
        });
        break;
      }
      case "reject":
        this.schedule(tracked, scenario.delayMs ?? 0, () => {
          tracked.state = { status: "rejected", filledQuantity: 0, rejectReason: scenario.reason };
        });
        break;
      case "never":
        break;
    }

    return { ref };
  }

  async placeOpenOrder(req: OpenSpreadRequest): Promise<{ ref: string }> {
    return this.place(
      {
        kind: "open",
        botId: req.botId,
        positionType: req.positionType,
        shortStrike: req.shortStrike,
        longStrike: req.longStrike,
        quantity: req.quantity,
      },
      req.limitCredit,
    );
  }

  async placeCloseOrder(position: Position): Promise<{ ref: string }> {
    const quantity = position.filledQuantity || position.requestedQuantity;
    return this.place(
      {
        kind: "close",
        botId: position.botId,
        positionType: position.type,
        shortStrike: position.shortStrike,
        longStrike: position.longStrike,
        quantity,
      },
      scenarioPriceFor(position, this.simulatePricing),
    );
  }

  async getOrder(ref: string): Promise<OrderState> {
    const tracked = this.orders.get(ref);
    if (!tracked) throw new Error(`Unknown mock order ref "${ref}".`);
    return { ...tracked.state };
  }

  async cancelOrder(ref: string): Promise<void> {
    const tracked = this.orders.get(ref);
    if (!tracked) return;
    tracked.timers.forEach(clearTimeout);
    tracked.timers = [];
    if (tracked.state.status === "working" || tracked.state.status === "partially_filled") {
      tracked.state = { ...tracked.state, status: "canceled" };
    }
  }

  async listPositions(botId: string): Promise<Position[]> {
    return positionsStore.query((p) => p.botId === botId);
  }
}
