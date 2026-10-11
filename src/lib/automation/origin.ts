import type { Signal } from "./types";

/** Where a signal came from, read off the signal itself (so it works for every entry already in the log):
 *  - "tradingview": a real call to a webhook URL
 *  - "test_hook": the Test Hook button on a webhook, or the status page's test alert
 *  - "manual": the Run button on a bot
 *  - "retry": the bot trying again an open an alert had asked for and that was dropped */
export type SignalOrigin = "tradingview" | "test_hook" | "manual" | "retry";

export const ORIGIN_LABEL: Record<SignalOrigin, string> = { tradingview: "TradingView", test_hook: "Test Hook", manual: "Manual run", retry: "Retry" };

type Raw = { source?: string; test?: boolean; webhook?: string; origin?: string } | null;

export function signalOrigin(signal: Pick<Signal, "raw">): SignalOrigin {
  const raw = signal.raw as Raw;
  if (raw?.source === "manual") return "manual";
  if (raw?.origin === "retry") return "retry";
  if (raw?.test === true || raw?.origin === "test_hook") return "test_hook";
  return "tradingview";
}

/** The webhook the call came through, when it came through a named one. */
export const signalWebhookName = (signal: Pick<Signal, "raw">): string | null => {
  const name = (signal.raw as Raw)?.webhook;
  return typeof name === "string" && name ? name : null;
};

/** "TradingView: BullishNDX", "Test Hook: BullishNDX", "Test alert" (a test not through a webhook), "Manual run". */
export function originLabel(signal: Pick<Signal, "raw">): string {
  const origin = signalOrigin(signal);
  const name = signalWebhookName(signal);
  if (origin === "test_hook" && !name) return "Test alert";
  return name && origin !== "manual" ? `${ORIGIN_LABEL[origin]}: ${name}` : ORIGIN_LABEL[origin];
}
