import "server-only";
import { MockExecutor } from "./executor";
import { TradierExecutor, readTradierConfig } from "./tradierExecutor";
import type { BrokerExecutor, ExecutorVenue, OpenSpreadRequest, OrderState, Position } from "./types";

/** AUTOMATION_MOCK_PRICING=simulated makes the mock report made-up close
 * prices so the P/L screens can be exercised; leave it unset otherwise. */
export const MOCK_PRICING_SIMULATED = process.env.AUTOMATION_MOCK_PRICING === "simulated";

export type ExecutorKind = "mock" | "tradier";

/** EXECUTOR=mock (the default) or tradier. Anything else is an error, not a silent fallback. */
export function executorKind(env: Record<string, string | undefined> = process.env): ExecutorKind {
  const raw = (env.EXECUTOR ?? "mock").trim().toLowerCase() || "mock";
  if (raw !== "mock" && raw !== "tradier") throw new Error(`EXECUTOR must be "mock" or "tradier", got "${raw}".`);
  return raw;
}

// One instance per process, shared by every route's copy of this module (Next bundles routes separately).
const g = globalThis as typeof globalThis & { __automationExecutor?: { key: string; executor: BrokerExecutor } };

/** Builds (once) the executor the settings ask for. Throws a clear error when
 * EXECUTOR=tradier is selected but not safely configured - nothing is sent. */
export function getExecutor(): BrokerExecutor {
  const kind = executorKind();
  const key = `${kind}:${MOCK_PRICING_SIMULATED}`;
  if (g.__automationExecutor?.key !== key) {
    g.__automationExecutor = { key, executor: kind === "tradier" ? new TradierExecutor(readTradierConfig()) : new MockExecutor({ simulatePricing: MOCK_PRICING_SIMULATED }) };
  }
  return g.__automationExecutor.executor;
}

export interface ExecutorStatus {
  kind: ExecutorKind | null;
  venue: ExecutorVenue | null;
  /** Why the chosen executor can't be used, or null when it can. */
  error: string | null;
  /** Tradier only: where requests would go. */
  baseUrl?: string;
  sandbox?: boolean;
}

export function executorStatus(): ExecutorStatus {
  let kind: ExecutorKind;
  try {
    kind = executorKind();
  } catch (err) {
    return { kind: null, venue: null, error: err instanceof Error ? err.message : String(err) };
  }
  if (kind === "mock") return { kind, venue: "mock", error: null };
  try {
    const c = readTradierConfig();
    return { kind, venue: "tradier", error: null, baseUrl: c.baseUrl, sandbox: c.sandbox };
  } catch (err) {
    return { kind, venue: "tradier", error: err instanceof Error ? err.message : String(err) };
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
  placeCloseOrder: (position: Position, options?: { pricePercent?: number; limitDebit?: number; quantity?: number }) => getExecutor().placeCloseOrder(position, options),
  getOrder: (ref: string): Promise<OrderState> => getExecutor().getOrder(ref),
  cancelOrder: (ref: string) => getExecutor().cancelOrder(ref),
  listPositions: (botId: string) => getExecutor().listPositions(botId),
  // Optional abilities are only there when the executor in use has them (the mock has none of these).
  get getSpreadQuote() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.getSpreadQuote ? ex.getSpreadQuote.bind(ex) : undefined;
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
