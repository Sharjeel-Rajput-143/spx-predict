/**
 * What to call the executor on the screens. One place, so no screen goes on saying "mock executor" after the app has been connected to a
 * broker. Plain functions of the executor status the server reports.
 */
import { BYBIT_UNDERLYING } from "@/lib/automation/executorKind";

export interface ExecutorLike {
  venue: "mock" | "tradier" | "ibkr" | "deriv" | "bybit" | null;
  sandbox?: boolean | null;
  /** Broker only: the underlyings its orders go to; every other bot runs on the internal simulation. */
  bridgeSymbols?: string[];
}

export type Tone = "warn" | "ok" | "error" | "neutral";

const BROKER_NAME = { tradier: "Tradier", ibkr: "Interactive Brokers", deriv: "Deriv", bybit: "Bybit" } as const;

/** Whether the Automation page shows its Bybit tab: only when Bybit is the broker. */
export const showsBybitTab = (x: ExecutorLike | null): boolean => x?.venue === "bybit";

/** The label on each account row. */
export function accountPill(x: ExecutorLike): { text: string; tone: Tone } {
  if (x.venue === "ibkr" || x.venue === "tradier" || x.venue === "deriv" || x.venue === "bybit") {
    const name = x.venue === "ibkr" ? "Interactive Brokers (bridge)" : x.venue === "deriv" ? "Deriv (demo)" : x.venue === "bybit" ? "Bybit (demo)" : "Tradier";
    return x.sandbox === false ? { text: `LIVE · ${name.replace(" (demo)", "")}`, tone: "error" } : { text: `Paper · ${name}`, tone: "ok" };
  }
  return { text: "Paper · simulation", tone: "warn" };
}

/** The underlyings whose orders really reach the broker. Bybit serves BTC and nothing else, whatever BRIDGE_SYMBOLS says (that setting is for the IBKR bridge and Deriv). */
const routedSymbols = (x: ExecutorLike): string[] => (x.venue === "bybit" ? [BYBIT_UNDERLYING] : (x.bridgeSymbols ?? []));

/** What an account row can't say on its own: which bots really go to the broker. */
export function routingNote(x: ExecutorLike): string | null {
  if ((x.venue !== "ibkr" && x.venue !== "deriv" && x.venue !== "bybit") || routedSymbols(x).length === 0) return null;
  return `Orders for ${routedSymbols(x).join(", ")} go to ${x.venue === "deriv" ? "Deriv" : x.venue === "bybit" ? "Bybit" : "the bridge"}. A bot on any other underlying (${x.venue === "bybit" ? "the NDX Bias Bot, SPX" : "SPX"}) runs on the internal simulation: its positions are labelled simulated, nothing reaches the broker, and its prices come from the public feed.`;
}

/** The line under the bots list. */
export function ordersFooter(x: ExecutorLike | null): string {
  if (!x || x.venue === null || x.venue === "mock") return "orders go to the internal simulation";
  const name = BROKER_NAME[x.venue];
  const where = x.sandbox === false ? `the ${name} LIVE account` : `the ${name} paper account`;
  return (x.venue === "ibkr" || x.venue === "deriv" || x.venue === "bybit") && routedSymbols(x).length ? `${routedSymbols(x).join(", ")} orders go to ${where}; other bots use the simulation` : `orders go to ${where}`;
}

/** The hover text on the Live filter chip. */
export function liveChipTip(x: ExecutorLike | null): string {
  if (x && (x.venue === "ibkr" || x.venue === "tradier" || x.venue === "deriv" || x.venue === "bybit")) return x.sandbox === false ? `${BROKER_NAME[x.venue]} LIVE account: real money` : `${BROKER_NAME[x.venue]} paper account: no real money is involved`;
  return "No live broker is connected: orders go to the internal simulation";
}
