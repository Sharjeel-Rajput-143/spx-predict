import type { ExitOptions } from "./openSettings";

/** True when at least one exit option is set. */
export function hasExitOptions(exit: ExitOptions | null | undefined): boolean {
  return !!exit && Object.values(exit).some((v) => v !== undefined && v !== null);
}

const dollars = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** The rows the Position details panel shows: what this position will be closed on, "None" for what is not set. */
export function exitOptionRows(exit: ExitOptions | null | undefined): [string, string][] {
  return [
    ["Profit %", exit?.profitPercent !== undefined ? `${exit.profitPercent}% of the credit` : "None"],
    ["Profit $", exit?.profitDollars !== undefined ? dollars(exit.profitDollars) : "None"],
    ["Stop loss %", exit?.stopPercent !== undefined ? `${exit.stopPercent}% of the credit` : "None"],
    ["Stop loss $", exit?.stopDollars !== undefined ? dollars(exit.stopDollars) : "None"],
    ["Touch", exit?.touchPoints !== undefined ? `within ${exit.touchPoints} points of the short strike` : "None"],
    ["Close before expiry", exit?.expirationMinutes !== undefined ? `${exit.expirationMinutes} minute${exit.expirationMinutes === 1 ? "" : "s"} before the market closes, at market` : "None"],
  ];
}

/** Which triggers of a bot have exit options on their Open Position step. */
export function botExitTriggers(openSettings: Partial<Record<"bullish" | "bearish", { exit?: ExitOptions } | null>> | null | undefined): ("bullish" | "bearish")[] {
  return (["bullish", "bearish"] as const).filter((d) => hasExitOptions(openSettings?.[d]?.exit));
}

/** Said wherever exit options are shown: what they depend on. */
export const EXIT_OPTIONS_NOTE =
  "Set on a trigger's Open Position step; a position keeps the ones it was opened with. They are checked every minute while the market is open, on a server that stays up. Profit and stop need live option prices (a broker connection); touch needs the live underlying price; the expiration exit needs only the clock.";
