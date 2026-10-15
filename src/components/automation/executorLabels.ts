/**
 * What to call the executor on the screens. One place, so no screen goes on saying "mock executor" after the app has been connected to a
 * broker. Plain functions of the executor status the server reports.
 */
export interface ExecutorLike {
  venue: "mock" | "tradier" | "ibkr" | null;
  sandbox?: boolean | null;
  /** Broker only: the underlyings its orders go to; every other bot runs on the internal simulation. */
  bridgeSymbols?: string[];
}

export type Tone = "warn" | "ok" | "error" | "neutral";

const BROKER_NAME = { tradier: "Tradier", ibkr: "Interactive Brokers" } as const;

/** The label on each account row. */
export function accountPill(x: ExecutorLike): { text: string; tone: Tone } {
  if (x.venue === "ibkr" || x.venue === "tradier") {
    const name = x.venue === "ibkr" ? "Interactive Brokers (bridge)" : "Tradier";
    return x.sandbox === false ? { text: `LIVE · ${name}`, tone: "error" } : { text: `Paper · ${name}`, tone: "ok" };
  }
  return { text: "Paper · simulation", tone: "warn" };
}

/** What an account row can't say on its own: which bots really go to the broker. */
export function routingNote(x: ExecutorLike): string | null {
  if (x.venue !== "ibkr" || !x.bridgeSymbols || x.bridgeSymbols.length === 0) return null;
  return `Orders for ${x.bridgeSymbols.join(", ")} go to the bridge. A bot on any other underlying (SPX) runs on the internal simulation: its positions are labelled simulated, nothing reaches the broker, and its prices come from the public feed.`;
}

/** The line under the bots list. */
export function ordersFooter(x: ExecutorLike | null): string {
  if (!x || x.venue === null || x.venue === "mock") return "orders go to the internal simulation";
  const name = BROKER_NAME[x.venue];
  const where = x.sandbox === false ? `the ${name} LIVE account` : `the ${name} paper account`;
  return x.venue === "ibkr" && x.bridgeSymbols?.length ? `${x.bridgeSymbols.join(", ")} orders go to ${where}; other bots use the simulation` : `orders go to ${where}`;
}

/** The hover text on the Live filter chip. */
export function liveChipTip(x: ExecutorLike | null): string {
  if (x && (x.venue === "ibkr" || x.venue === "tradier")) return x.sandbox === false ? `${BROKER_NAME[x.venue]} LIVE account: real money` : `${BROKER_NAME[x.venue]} paper account: no real money is involved`;
  return "No live broker is connected: orders go to the internal simulation";
}
