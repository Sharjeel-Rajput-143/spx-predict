/**
 * Which broker the app talks to, and where its prices come from. Plain functions of the environment (no server-only, no imports),
 * so config.ts, store.ts and the executors all read the setting the same way.
 *
 *   BROKER=internal | ibkr | tradier   (EXECUTOR=mock | ibkr | tradier is the older spelling of the same switch)
 *   PRICE_SOURCE=feed | broker         (feed: Google/Yahoo, the default; broker: the broker's own index quote)
 *
 * "internal" is the app's own simulation (the mock executor): nothing reaches a broker. Anything unrecognised is an error,
 * never a silent fallback to something else.
 */

export type ExecutorKind = "mock" | "tradier" | "ibkr";
export type PriceSource = "feed" | "broker";

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined) => (v ?? "").trim().toLowerCase();

function parseKind(name: "BROKER" | "EXECUTOR", raw: string): ExecutorKind {
  if (raw === "mock" || raw === "internal") return "mock";
  if (raw === "tradier" || raw === "ibkr") return raw;
  throw new Error(`${name} must be ${name === "BROKER" ? '"internal" or "ibkr" (or "tradier")' : '"mock" or "tradier" (or "ibkr")'}, got "${raw}".`);
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

export function priceSource(env: Env = process.env): PriceSource {
  const raw = clean(env.PRICE_SOURCE) || "feed";
  if (raw !== "feed" && raw !== "broker") throw new Error(`PRICE_SOURCE must be "feed" or "broker", got "${raw}".`);
  return raw;
}
