import type { Position, PositionStatus, PositionType } from "./types";
import { ACTIVE_POSITION_STATUSES } from "./types";

/**
 * The two position checks on a Bullish/Bearish canvas, as Option Alpha words them:
 * "Bot has <exactly or more than> <1 position> with <type> type and <any> status".
 * `close` is the check in front of the Close Position step (the opposite side), `open` the one in front of the Open step
 * (the side the signal wants; true = already held, so nothing is opened). The type is Option Alpha's list; unset it is the side the
 * flow is for. This bot only ever holds short put and short call spreads, so any other type counts zero positions.
 * Unset, they are what the engine has always done: close when one or more of the opposite side is held in any status, and
 * don't open when the wanted side is already held up to the bot's per-type limit.
 */

export const CHECK_OPS = ["more than", "less than", "exactly", "exactly or more than", "exactly or less than"] as const;
export type CheckOp = (typeof CHECK_OPS)[number];

/** Option Alpha also offers "error"; a position here is never left in an error status (a failed order is rejected, not held). */
export const CHECK_STATUSES = ["any", "opening", "open", "closing"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const CHECK_TYPES = ["any", "Long equity", "Long call", "Long call spread", "Long put", "Long put spread", "Short call spread", "Short put spread", "Iron butterfly", "Iron condor"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

const TYPE_LABEL: Record<PositionType, CheckType> = { short_put_spread: "Short put spread", short_call_spread: "Short call spread" };
/** How a position's type is worded in a check. */
export const typeLabel = (type: PositionType): CheckType => TYPE_LABEL[type];

export const CHECK_MAX_COUNT = 10;

export interface PositionCheck {
  op: CheckOp;
  count: number;
  /** Unset = the side the flow is for. */
  type?: CheckType;
  status: CheckStatus;
}

export type CheckSlot = "close" | "open";
export type PositionChecks = Partial<Record<"bullish" | "bearish", Partial<Record<CheckSlot, PositionCheck>>>>;

export const defaultCheck = (count = 1): PositionCheck => ({ op: "exactly or more than", count, status: "any" });

/** The check as the engine has always asked it (one or more, any status, the flow's own side): its log wording is the older one. */
export function isDefaultForm(check: PositionCheck, sideLabel: string): boolean {
  return check.op === "exactly or more than" && check.status === "any" && (check.type === undefined || check.type === sideLabel);
}

export function checkHolds(check: PositionCheck, held: number): boolean {
  switch (check.op) {
    case "more than":
      return held > check.count;
    case "less than":
      return held < check.count;
    case "exactly":
      return held === check.count;
    case "exactly or more than":
      return held >= check.count;
    case "exactly or less than":
      return held <= check.count;
  }
}

/** The positions a check counts, out of all the bot's positions: those of its type (`sideLabel` unless it names another) whose status matches. */
export function matching(positions: Position[], check: PositionCheck, sideLabel: string): Position[] {
  const type = check.type ?? sideLabel;
  return positions.filter(
    (p) => (check.status === "any" ? ACTIVE_POSITION_STATUSES.includes(p.status) : p.status === (check.status as PositionStatus)) && (type === "any" || TYPE_LABEL[p.type] === type),
  );
}

export const positionsWord = (n: number) => `${n} position${n === 1 ? "" : "s"}`;

export function describeCheck(check: PositionCheck, sideLabel: string): string {
  return `Bot has ${check.op} ${positionsWord(check.count)} with ${check.type ?? sideLabel} type and ${check.status} status`;
}

/** A saved check, or the reason it can't be used. Anything not exactly one of the offered choices is refused. */
export function validateCheck(value: unknown): { ok: true; check: PositionCheck } | { ok: false; reason: string } {
  const v = value as Partial<PositionCheck> | null;
  if (!v || typeof v !== "object") return { ok: false, reason: "A position check needs an operator, a count and a status." };
  if (!CHECK_OPS.includes(v.op as CheckOp)) return { ok: false, reason: `The operator must be one of: ${CHECK_OPS.join(", ")}.` };
  if (typeof v.count !== "number" || !Number.isInteger(v.count) || v.count < 0 || v.count > CHECK_MAX_COUNT) return { ok: false, reason: `The count must be a whole number from 0 to ${CHECK_MAX_COUNT}.` };
  if (v.type !== undefined && !CHECK_TYPES.includes(v.type as CheckType)) return { ok: false, reason: `The type must be one of: ${CHECK_TYPES.join(", ")}.` };
  if (!CHECK_STATUSES.includes(v.status as CheckStatus)) return { ok: false, reason: `The status must be one of: ${CHECK_STATUSES.join(", ")}.` };
  return { ok: true, check: { op: v.op as CheckOp, count: v.count, ...(v.type !== undefined ? { type: v.type as CheckType } : {}), status: v.status as CheckStatus } };
}
