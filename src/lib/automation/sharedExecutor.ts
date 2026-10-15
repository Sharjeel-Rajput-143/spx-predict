import "server-only";
import { MockExecutor } from "./executor";
import { IbkrExecutor, readIbkrConfig } from "./ibkrExecutor";
import { TradierExecutor, readTradierConfig } from "./tradierExecutor";
import { bridgeSymbols, executorKind, priceSource, type ExecutorKind, type PriceSource } from "./executorKind";
import { RoutedExecutor } from "./routedExecutor";
import type { BrokerExecutor, CloseOrderOptions, ExecutorVenue, OpenSpreadRequest, OrderState, Position } from "./types";

/** AUTOMATION_MOCK_PRICING=simulated makes the mock report made-up close
 * prices so the P/L screens can be exercised; leave it unset otherwise. */
export const MOCK_PRICING_SIMULATED = process.env.AUTOMATION_MOCK_PRICING === "simulated";

export { executorKind };
export type { ExecutorKind };

function buildExecutor(kind: ExecutorKind): BrokerExecutor {
  if (kind === "tradier") return new TradierExecutor(readTradierConfig());
  // The bridge takes some underlyings only (NDX): a bot on another one stays on the internal simulation, labelled as such (see routedExecutor.ts).
  if (kind === "ibkr") return new RoutedExecutor(new IbkrExecutor(readIbkrConfig()), new MockExecutor({ simulatePricing: MOCK_PRICING_SIMULATED }), bridgeSymbols());
  return new MockExecutor({ simulatePricing: MOCK_PRICING_SIMULATED });
}

// One instance per process, shared by every route's copy of this module (Next bundles routes separately).
const g = globalThis as typeof globalThis & { __automationExecutor?: { key: string; executor: BrokerExecutor } };

/** Builds (once) the executor the settings ask for. Throws a clear error when
 * a broker is selected but not safely configured - nothing is sent. */
export function getExecutor(): BrokerExecutor {
  const kind = executorKind();
  const key = `${kind}:${MOCK_PRICING_SIMULATED}`;
  if (g.__automationExecutor?.key !== key) {
    g.__automationExecutor = { key, executor: buildExecutor(kind) };
  }
  return g.__automationExecutor.executor;
}

export interface ExecutorStatus {
  kind: ExecutorKind | null;
  venue: ExecutorVenue | null;
  /** Why the chosen executor can't be used, or null when it can. */
  error: string | null;
  /** A broker only: where requests would go (the Tradier API, or the bridge in front of IB Gateway). */
  baseUrl?: string;
  /** A broker only: true for a paper/sandbox account, false when real money is allowed. */
  sandbox?: boolean;
  /** Where the underlying's price comes from: the public feed, or the broker's own quote. */
  priceSource?: PriceSource;
  /** A broker only: the underlyings its orders go to. Bots on any other underlying run on the internal simulation. */
  bridgeSymbols?: string[];
}

/** Paper money or nothing real at all: the only places a test call or a test alert may run. Real money never. */
export const isPaperStatus = (s: Pick<ExecutorStatus, "venue" | "sandbox">): boolean => s.venue === "mock" || ((s.venue === "tradier" || s.venue === "ibkr") && s.sandbox === true);

export function executorStatus(): ExecutorStatus {
  let kind: ExecutorKind;
  let source: PriceSource;
  try {
    kind = executorKind();
    source = priceSource();
  } catch (err) {
    return { kind: null, venue: null, error: err instanceof Error ? err.message : String(err) };
  }
  if (source === "broker" && kind !== "ibkr") {
    return { kind, venue: kind, error: 'PRICE_SOURCE=broker needs a broker that can quote prices (BROKER=ibkr). Set PRICE_SOURCE=feed, or BROKER=ibkr.', priceSource: source };
  }
  if (kind === "mock") return { kind, venue: "mock", error: null, priceSource: source };
  try {
    if (kind === "ibkr") {
      const c = readIbkrConfig();
      return { kind, venue: "ibkr", error: null, baseUrl: c.baseUrl, sandbox: !c.allowLive, priceSource: source, bridgeSymbols: bridgeSymbols() };
    }
    const c = readTradierConfig();
    return { kind, venue: "tradier", error: null, baseUrl: c.baseUrl, sandbox: c.sandbox, priceSource: source };
  } catch (err) {
    return { kind, venue: kind, error: err instanceof Error ? err.message : String(err), priceSource: source };
  }
}

/** The executor the running process uses. A thin delegate, so a misconfigured
 * EXECUTOR surfaces as a clear error at the moment of use (and in
 * `executorStatus()`) instead of breaking every page that imports this. */
export const sharedExecutor: BrokerExecutor = {
  get venue() {
    return executorStatus().venue ?? undefined;
  },
  placeOpenOrder: (req: OpenSpreadRequest) => getExecutor().placeOpenOrder(req),
  placeCloseOrder: (position: Position, options?: CloseOrderOptions) => getExecutor().placeCloseOrder(position, options),
  getOrder: (ref: string): Promise<OrderState> => getExecutor().getOrder(ref),
  cancelOrder: (ref: string) => getExecutor().cancelOrder(ref),
  listPositions: (botId: string) => getExecutor().listPositions(botId),
  // Optional abilities are only there when the executor in use has them (the mock has none of these).
  get getSpreadQuote() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.getSpreadQuote ? ex.getSpreadQuote.bind(ex) : undefined;
  },
  get limitOnly() {
    return executorStatus().error ? undefined : getExecutor().limitOnly;
  },
  get limitOnlyFor() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.limitOnlyFor ? ex.limitOnlyFor.bind(ex) : undefined;
  },
  get venueFor() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.venueFor ? ex.venueFor.bind(ex) : undefined;
  },
  get getUnderlyingQuote() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.getUnderlyingQuote ? ex.getUnderlyingQuote.bind(ex) : undefined;
  },
  get getOptionChain() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.getOptionChain ? ex.getOptionChain.bind(ex) : undefined;
  },
  get listBrokerPositions() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.listBrokerPositions ? ex.listBrokerPositions.bind(ex) : undefined;
  },
  get getBalances() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.getBalances ? ex.getBalances.bind(ex) : undefined;
  },
};
