/**
 * Which broker the app talks to, and where its prices come from. Plain functions of the environment (no server-only, no imports),
 * so config.ts, store.ts and the executors all read the setting the same way.
 *
 *   BROKER=internal | deriv | bybit | tradier  (EXECUTOR=mock | tradier | deriv | bybit is the older spelling of the same switch)
 *   The Interactive Brokers (ibkr) backend is still built and still selectable, but it is hidden: it is not advertised while Deriv is the broker.
 *   PRICE_SOURCE=feed | broker         (feed: Google/Yahoo, the default; broker: the broker's own index quote)
 *
 * "internal" is the app's own simulation (the mock executor): nothing reaches a broker. Anything unrecognised is an error,
 * never a silent fallback to something else.
 */

export type ExecutorKind = "mock" | "tradier" | "ibkr" | "deriv" | "bybit";
export type PriceSource = "feed" | "broker";

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined) => (v ?? "").trim().toLowerCase();

function parseKind(name: "BROKER" | "EXECUTOR", raw: string): ExecutorKind {
  if (raw === "mock" || raw === "internal") return "mock";
  if (raw === "tradier" || raw === "ibkr" || raw === "deriv" || raw === "bybit") return raw;
  throw new Error(`${name} must be ${name === "BROKER" ? '"internal", "deriv" or "bybit" (or "tradier")' : '"mock" or "tradier" (or "deriv" or "bybit")'}, got "${raw}".`);
}

/** The broker setting. Both spellings set and disagreeing is an error: it is never guessed which one was meant. */
export function executorKind(env: Env = process.env): ExecutorKind {
  const broker = clean(env.BROKER);
  const executor = clean(env.EXECUTOR);
  const a = broker ? parseKind("BROKER", broker) : null;
  const b = executor ? parseKind("EXECUTOR", executor) : null;
  if (a && b && a !== b) throw new Error(`BROKER=${broker} and EXECUTOR=${executor} disagree. Set only one of them (BROKER is the newer name).`);
  return a ?? b ?? "mock";
}

/** True when a real broker (paper or live) is chosen. An unreadable setting counts as "no": executorStatus() reports it loudly. */
export function isBrokerKind(env: Env = process.env): boolean {
  try {
    return executorKind(env) !== "mock";
  } catch {
    return false;
  }
}

/** The underlyings the bridge to IBKR takes (BRIDGE_SYMBOLS, default just NDX). A bot on any other underlying runs on the internal simulation. */
export function bridgeSymbols(env: Env = process.env): string[] {
  const raw = (env.BRIDGE_SYMBOLS ?? "NDX").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  for (const s of raw) if (!/^[A-Z]{1,6}$/.test(s)) throw new Error(`BRIDGE_SYMBOLS must be a comma-separated list of symbols like "NDX", got "${s}".`);
  return raw.length > 0 ? raw : ["NDX"];
}

export function priceSource(env: Env = process.env): PriceSource {
  const raw = clean(env.PRICE_SOURCE) || "feed";
  if (raw !== "feed" && raw !== "broker") throw new Error(`PRICE_SOURCE must be "feed" or "broker", got "${raw}".`);
  return raw;
}

/** The underlying the Bybit demo executor serves, and the only one: the BTC Bybit Bot's. Every other bot (the NDX Bias Bot included) stays on the internal simulation when BROKER=bybit. */
export const BYBIT_UNDERLYING = "BTC";
