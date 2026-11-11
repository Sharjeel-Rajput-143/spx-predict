import type { Position } from "./types";

/**
 * Facts about the executors that trade a real instrument (Deriv's contracts, Bybit's perpetual) rather than an option spread. Plain functions, no I/O.
 * The engine's spread arithmetic (strikes, width, a credit) means nothing to them, so nothing about their results is ever worked out from it.
 */

/** A position whose result is the broker's own report of the trade (Deriv's profit for the contract, Bybit's closed profit and loss), never an estimate from strikes or a credit. */
export const reportsOwnResult = (p: Pick<Position, "venue">): boolean => p.venue === "deriv" || p.venue === "bybit";

/** A position that has no expiry: it stays held until a close order closes it (a perpetual future). It is never marked expired by the clock, because the instrument is still held at the broker. */
export const holdsUntilClosed = (p: Pick<Position, "venue">): boolean => p.venue === "bybit";

const BROKER_NAMES = { deriv: "Deriv", bybit: "Bybit" } as const;

/** "Deriv" / "Bybit" for a venue that reports its own result, else null. */
export const brokerNameOf = (venue: string | undefined): string | null => (venue === "deriv" || venue === "bybit" ? BROKER_NAMES[venue] : null);

/** What a position says while the broker's own result has not been read yet. */
export const unknownResultFor = (venue: string | undefined): string => `unknown, check ${brokerNameOf(venue) ?? "the broker"}`;
