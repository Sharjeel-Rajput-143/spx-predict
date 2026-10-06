import "server-only";
import { ensureBotRecord, getBotLimits, getBotStaticConfig, isKnownBot } from "./bots";
import { logDecision } from "./decisions";
import { positionQuantity } from "./pnl";
import { activePositionsForBot } from "./safeguards";
import { botsStore, positionsStore } from "./store";
import type { Position } from "./types";

const cleanTags = (tags: unknown): string[] =>
  Array.isArray(tags) ? [...new Set(tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean))].slice(0, 20) : [];

/** Edit the labels and note on one position. Nothing else about it can change here. */
export function updatePositionMeta(positionId: string, patch: { tags?: string[]; notes?: string }): Position {
  const position = positionsStore.get(positionId);
  if (!position) throw new Error("Position not found.");
  const next: Partial<Position> = {};
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.notes !== undefined) {
    if (typeof patch.notes !== "string") throw new Error("Notes must be text.");
    next.notes = patch.notes.slice(0, 5000);
  }
  return positionsStore.update(positionId, next) ?? position;
}

/**
 * Types in the result of a position that expired without a fill to price it by (the end-of-day sweep in manual
 * mode, a sweep with no price to estimate from, or a position left over from an earlier day). It can replace an
 * estimate too. The number has to be possible for the trade: no more than the credit kept, no worse than the
 * most it could lose. Callers hold the bot's lock (see the route).
 */
export function enterPositionPL(positionId: string, pl: unknown, now: number = Date.now()): Position {
  const position = positionsStore.get(positionId);
  if (!position) throw new Error("Position not found.");
  if (position.status !== "expired") throw new Error(`Only an expired position takes a P/L by hand (this one is ${position.status}).`);
  if (typeof pl !== "number" || !Number.isFinite(pl)) throw new Error("The P/L must be a number of dollars, e.g. 125 or -310.");

  const quantity = positionQuantity(position);
  const credit = position.credit;
  if (credit != null) {
    const best = credit * 100 * quantity;
    const worst = -((Math.abs(position.shortStrike - position.longStrike) - credit) * 100 * quantity);
    if (pl > best + 0.005 || pl < worst - 0.005) {
      throw new Error(`That can't be this trade's result: it ranges from ${worst.toFixed(2)} (worst) to +${best.toFixed(2)} (best).`);
    }
  }
  const rounded = Math.round(pl * 100) / 100;
  const updated = positionsStore.update(positionId, { settlement: { kind: "manual", pl: rounded, at: now } }) ?? position;
  logDecision({
    signalId: null,
    botId: position.botId,
    outcome: "eod_sweep",
    reason: `P/L of ${rounded < 0 ? "-" : "+"}$${Math.abs(rounded).toFixed(2)} entered by hand for ${position.underlying} ${position.shortStrike}/${position.longStrike}.`,
    detail: { positionId, pl: rounded, manual: true },
    now,
  });
  return updated;
}

const botName = (id: string) => {
  try {
    return getBotStaticConfig(id).name;
  } catch {
    return botsStore.get(id)?.name ?? id;
  }
};

/**
 * Reassigns an open position to another bot, so that bot's switch, limits and
 * flips govern it from now on. Only an open position can move; the target must
 * be able to trade, be on the same account, and have room for it.
 * Callers hold both bots' locks (see the route).
 */
export function movePosition(positionId: string, targetBotId: string, now: number = Date.now()): Position {
  const position = positionsStore.get(positionId);
  if (!position) throw new Error("Position not found.");
  if (position.status !== "open") throw new Error(`Only an open position can be moved (this one is ${position.status}).`);
  const sourceBotId = position.botId;
  if (targetBotId === sourceBotId) throw new Error("It's already on that bot.");
  if (!isKnownBot(targetBotId)) throw new Error("That bot doesn't exist.");
  if (ensureBotRecord(targetBotId).archived) throw new Error("That bot is archived.");

  let target;
  try {
    target = getBotStaticConfig(targetBotId);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "That bot isn't set up yet.");
  }
  let source;
  try {
    source = getBotStaticConfig(sourceBotId);
  } catch {
    source = null;
  }
  if (source && source.accountId !== target.accountId) {
    throw new Error("A position can only move between bots on the same account.");
  }

  const limits = getBotLimits(targetBotId);
  if (activePositionsForBot(targetBotId).length >= limits.totalPositionLimit) {
    throw new Error(`${target.name} is already at its position limit (${limits.totalPositionLimit}).`);
  }
  if (activePositionsForBot(targetBotId, position.type).length >= limits.maxPositionsPerType) {
    throw new Error(`${target.name} already holds the most ${position.type.replace(/_/g, " ")}s it's allowed.`);
  }

  const moved = positionsStore.update(positionId, { botId: targetBotId }) ?? position;
  const detail = { positionId, from: sourceBotId, to: targetBotId, moved: true };
  logDecision({ signalId: null, botId: sourceBotId, outcome: "position_moved", reason: `Moved to ${target.name}.`, detail, now });
  logDecision({ signalId: null, botId: targetBotId, outcome: "position_moved", reason: `Moved in from ${botName(sourceBotId)}.`, detail, now });
  return moved;
}
