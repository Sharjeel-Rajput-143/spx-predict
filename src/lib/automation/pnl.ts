import { reportsOwnResult } from "./brokerVenue";
import type { Position } from "./types";

/**
 * Profit and loss, derived only from prices the executor actually reported.
 * A closed position is "priced" once its close order filled at a known debit;
 * everything else (open, expired, or closed with no fill price) has no P/L -
 * it is never guessed. Realized P/L = (credit - close debit) x 100 x quantity.
 */
export function positionQuantity(p: Position): number {
  return p.filledQuantity || p.requestedQuantity;
}

export function positionPL(p: Position): number | null {
  // A Deriv or Bybit position's result is the broker's own report when it has been read: never worked out from strikes or a credit.
  if (reportsOwnResult(p) && p.settlement?.kind === "broker") return p.settlement.pl;
  // An expired position has no fill to price it by; its result is what the end-of-day sweep
  // estimated from the underlying, or what a person typed in - and says so (positionPLKind).
  if (p.status === "expired") return p.settlement?.pl ?? null;
  if (p.status !== "closed" || p.closePrice == null || p.credit == null) return null;
  return (p.credit - p.closePrice) * 100 * positionQuantity(p);
}

/** Where a P/L came from: a close order's fill, an estimate from the underlying's price, a person, or the broker's own report of the contract (Deriv). */
export function positionPLKind(p: Position): "fill" | "estimated" | "manual" | "broker" | null {
  if (positionPL(p) === null) return null;
  if (reportsOwnResult(p) && p.settlement?.kind === "broker") return "broker";
  return p.status === "expired" ? (p.settlement?.kind ?? null) : "fill";
}

/** Capital at risk on one position: (width - credit) x 100 x quantity. */
export function positionRisk(p: Position, fallbackCredit?: number): number | null {
  const credit = p.credit ?? fallbackCredit;
  if (credit == null) return null;
  return (Math.abs(p.shortStrike - p.longStrike) - credit) * 100 * positionQuantity(p);
}

export function positionPremium(p: Position, fallbackCredit?: number): number | null {
  const credit = p.credit ?? fallbackCredit;
  return credit == null ? null : credit * 100 * positionQuantity(p);
}

export interface PositionStats {
  /** Positions that are no longer active (closed, expired, rejected excluded). */
  finished: number;
  /** Positions (closed or expired) with a known P/L. */
  priced: number;
  /** Of those, how many were estimated or typed in rather than filled. */
  settledWithoutFill: number;
  closedPL: number | null;
  wins: number;
  losses: number;
  winRate: number | null;
  avgPL: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  maxDrawdown: number | null;
  streak: { kind: "win" | "loss"; count: number } | null;
  /** Cumulative realized P/L in the order positions closed. */
  curve: { at: number; value: number }[];
}

export function computeStats(positions: Position[]): PositionStats {
  const finished = positions.filter((p) => p.status === "closed" || p.status === "expired").length;
  const priced = positions
    .map((p) => ({ p, pl: positionPL(p) }))
    .filter((x): x is { p: Position; pl: number } => x.pl !== null)
    .sort((a, b) => (a.p.closedAt ?? 0) - (b.p.closedAt ?? 0));

  if (priced.length === 0) {
    return {
      finished,
      priced: 0,
      settledWithoutFill: 0,
      closedPL: null,
      wins: 0,
      losses: 0,
      winRate: null,
      avgPL: null,
      avgWin: null,
      avgLoss: null,
      profitFactor: null,
      maxDrawdown: null,
      streak: null,
      curve: [],
    };
  }

  const wins = priced.filter((x) => x.pl > 0);
  const losses = priced.filter((x) => x.pl < 0);
  const grossWin = wins.reduce((s, x) => s + x.pl, 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x.pl, 0));
  const total = priced.reduce((s, x) => s + x.pl, 0);

  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const curve = priced.map((x) => {
    running += x.pl;
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, peak - running);
    return { at: x.p.closedAt ?? 0, value: running };
  });

  // Current streak: consecutive same-sign results at the end (breakeven ends it).
  let streak: PositionStats["streak"] = null;
  for (let i = priced.length - 1; i >= 0; i--) {
    const kind = priced[i].pl > 0 ? "win" : priced[i].pl < 0 ? "loss" : null;
    if (!kind) break;
    if (!streak) streak = { kind, count: 1 };
    else if (streak.kind === kind) streak.count++;
    else break;
  }

  return {
    finished,
    priced: priced.length,
    settledWithoutFill: priced.filter((x) => positionPLKind(x.p) !== "fill").length,
    closedPL: total,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / priced.length,
    avgPL: total / priced.length,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdown,
    streak,
    curve,
  };
}
