import "server-only";
import { BybitExecutor, readBybitConfig } from "./bybitExecutor";
import { LiveBybitExecutor, readLiveConfig } from "./bybitLive";
import { appLiveGuard } from "./liveGuard";
import { PerBotExecutor } from "./perBotExecutor";
import { DerivExecutor, readDerivConfig } from "./derivExecutor";
import { MockExecutor } from "./executor";
import { IbkrExecutor, readIbkrConfig } from "./ibkrExecutor";
import { TradierExecutor, readTradierConfig } from "./tradierExecutor";
import { BYBIT_UNDERLYING, bridgeSymbols, executorKind, priceSource, type ExecutorKind, type PriceSource } from "./executorKind";
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
  // Deriv trades NDX only (US Tech 100): a bot on another underlying (SPX) stays on the internal simulation, the same way.
  if (kind === "deriv") return new RoutedExecutor(new DerivExecutor(readDerivConfig()), new MockExecutor({ simulatePricing: MOCK_PRICING_SIMULATED }), bridgeSymbols());
  // Bybit trades one perpetual (BTCUSDT) for the NDX bot, the same way; any other bot stays on the simulation.
  if (kind === "bybit") {
    const config = readBybitConfig();
    // Said once, when the executor is built (not for every status read): what the running app actually loaded. Only the limit is named, never the key, secret or other settings.
    console.info(`[bybit] demo executor ready: daily loss limit $${config.dailyMaxLossUsd}`);
    // Bybit takes the BTC bot's orders ONLY (BYBIT_UNDERLYING): the NDX Bias Bot, whatever its switch says, runs on the internal simulation and can never place a Bybit order.
    const demo = new RoutedExecutor(new BybitExecutor(config), new MockExecutor({ simulatePricing: MOCK_PRICING_SIMULATED }), [BYBIT_UNDERLYING]);
    // The live bot's orders go to a SEPARATE executor on the real host with its own key, only if that key is set; otherwise its calls are refused (see perBotExecutor.ts).
    return new PerBotExecutor(demo, liveBybitExecutor);
  }
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

/** The Bybit executor behind the router, or null when Bybit is not the broker (or is not configured). For the results panel and the risk monitor. */
export function bybitExecutor(): BybitExecutor | null {
  if (executorStatus().error || executorKind() !== "bybit") return null;
  // Not `instanceof`: Next compiles each route as its own copy of this code, while the one executor is shared between them (see getExecutor), so the object may have
  // been built by another copy's classes. It is recognised by what it is: the broker behind the router that says it is Bybit and can read the account.
  const primary = (getExecutor() as { primaryExecutor?: BrokerExecutor }).primaryExecutor;
  return primary?.venue === "bybit" && typeof (primary as Partial<BybitExecutor>).getAccountPosition === "function" ? (primary as BybitExecutor) : null;
}

const lg = globalThis as typeof globalThis & { __liveBybit?: { executor: LiveBybitExecutor | null; error: string | null } };

/** The live Bybit executor, built once from the live key; null (with the reason in liveExecutorProblem) when there is no usable live key. Never throws. Makes no request. */
export function liveBybitExecutor(): LiveBybitExecutor | null {
  if (!lg.__liveBybit) {
    try {
      lg.__liveBybit = { executor: new LiveBybitExecutor(readLiveConfig(), appLiveGuard), error: null };
    } catch (err) {
      lg.__liveBybit = { executor: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return lg.__liveBybit.executor;
}

/** Why there is no live executor (a sentence without any value), or null when there is one. */
export function liveExecutorProblem(): string | null {
  liveBybitExecutor();
  return lg.__liveBybit?.error ?? null;
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
export const isPaperStatus = (s: Pick<ExecutorStatus, "venue" | "sandbox">): boolean => s.venue === "mock" || ((s.venue === "tradier" || s.venue === "ibkr" || s.venue === "deriv" || s.venue === "bybit") && s.sandbox === true);

export function executorStatus(): ExecutorStatus {
  let kind: ExecutorKind;
  let source: PriceSource;
  try {
    kind = executorKind();
    source = priceSource();
  } catch (err) {
    return { kind: null, venue: null, error: err instanceof Error ? err.message : String(err) };
  }
  if (source === "broker" && kind !== "ibkr" && kind !== "deriv") {
    return { kind, venue: kind, error: 'PRICE_SOURCE=broker needs a broker that can quote prices (BROKER=deriv). Set PRICE_SOURCE=feed, or BROKER=deriv.', priceSource: source };
  }
  if (kind === "mock") return { kind, venue: "mock", error: null, priceSource: source };
  try {
    if (kind === "deriv") {
      const c = readDerivConfig();
      return { kind, venue: "deriv", error: null, baseUrl: c.apiBase, sandbox: !c.allowReal, priceSource: source, bridgeSymbols: bridgeSymbols() };
    }
    if (kind === "bybit") {
      const c = readBybitConfig();
      return { kind, venue: "bybit", error: null, baseUrl: c.apiBase, sandbox: true, priceSource: source, bridgeSymbols: [BYBIT_UNDERLYING] };
    }
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
  get lastBuyMinutesFor() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.lastBuyMinutesFor ? ex.lastBuyMinutesFor.bind(ex) : undefined;
  },
  get entryBlock() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.entryBlock ? ex.entryBlock.bind(ex) : undefined;
  },
  get syncPositions() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.syncPositions ? ex.syncPositions.bind(ex) : undefined;
  },
  get getContractResult() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.getContractResult ? ex.getContractResult.bind(ex) : undefined;
  },
  get tradingWindowFor() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.tradingWindowFor ? ex.tradingWindowFor.bind(ex) : undefined;
  },
  get isPaperAccount() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.isPaperAccount ? ex.isPaperAccount.bind(ex) : undefined;
  },
  get getSpreadMark() {
    const ex = executorStatus().error ? null : getExecutor();
    return ex?.getSpreadMark ? ex.getSpreadMark.bind(ex) : undefined;
  },
};
