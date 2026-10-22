import "server-only";
import { positionPL, positionQuantity } from "./pnl";
import { spreadMarket } from "./smartPricing";
import { positionsStore } from "./store";
import { easternDateKey } from "./tradingHours";
import type { BrokerExecutor, LossCheckSnapshot, Position } from "./types";

/**
 * The daily loss limit. Today's result for a bot is
 *
 *   realized  = the profit/loss of the bot's positions that CLOSED or EXPIRED today (New York date): a fill's result, or an expired
 *               position's settlement (the end-of-day estimate, or what a person typed). A closed position with no price has no result and
 *               counts as 0 - it is counted and named in the Log, never guessed.
 *   open loss = what the positions still held would lose if bought back now (the broker's mark, else the spread quote's middle). Only a
 *               loss counts; an open profit does not offset anything. When it cannot be worked out (no mark and no quote) it is UNKNOWN: it is
 *               not counted, and the Log says so.
 *
 * The limit is reached when realized + open loss is at or below minus the limit. It blocks NEW OPENS only (see engine.ts): never a close, never
 * a flip's close, and it does not switch the bot off. Nothing is stored that has to be cleared: the next trading day starts from zero.
 */

export interface RealizedToday {
  /** Net profit/loss of positions that closed or expired today (wins and losses together). */
  realized: number;
  /** How many positions closed or expired today. */
  closedToday: number;
  /** Of those, how many have no result (closed with no price) and so count as 0. */
  unpriced: number;
}

/** Pure: the realized result of `positions` for the New York day of `nowMs`. */
export function sumRealizedToday(positions: readonly Position[], nowMs: number): RealizedToday {
  const today = easternDateKey(nowMs);
  let realized = 0;
  let closedToday = 0;
  let unpriced = 0;
  for (const p of positions) {
    if ((p.status !== "closed" && p.status !== "expired") || p.closedAt == null || easternDateKey(p.closedAt) !== today) continue;
    closedToday++;
    const pl = positionPL(p);
    if (pl === null) unpriced++;
    else realized += pl;
  }
  return { realized: Math.round(realized * 100) / 100, closedToday, unpriced };
}

export function realizedToday(botId: string, nowMs: number): RealizedToday {
  return sumRealizedToday(positionsStore.query((p) => p.botId === botId), nowMs);
}

export type OpenLoss = { known: true; loss: number; source: string } | { known: false; why: string };

/**
 * What the positions still held would lose, as a number at or below 0. Each position is priced from the broker's mark, else from the spread
 * quote's middle. If any held position can be priced neither way the answer is UNKNOWN for the whole - no guess is made for it.
 */
export async function openLossOf(held: readonly Position[], executor: BrokerExecutor): Promise<OpenLoss> {
  const priced = held.filter((p) => p.status === "open" || p.status === "closing");
  if (priced.length === 0) return { known: true, loss: 0, source: "no position held" };
  let loss = 0;
  const sources = new Set<string>();
  for (const p of priced) {
    if (p.credit == null) return { known: false, why: `a ${p.status} position has no credit recorded, so its result can't be worked out` };
    const qty = positionQuantity(p);
    let debit: number | null = null;
    try {
      const mark = (await executor.getSpreadMark?.(p, qty)) ?? null;
      if (mark !== null && mark > 0) {
        debit = mark;
        sources.add("broker mark");
      }
    } catch {
      /* try the quote */
    }
    if (debit === null && executor.getSpreadQuote) {
      try {
        const legs = await executor.getSpreadQuote({ underlying: p.underlying, optionRoot: p.optionRoot, expiry: p.expiry, type: p.type, shortStrike: p.shortStrike, longStrike: p.longStrike });
        const market = legs ? spreadMarket("debit", legs) : null;
        if (market && market.mid > 0) {
          debit = market.mid;
          sources.add("quote middle");
        }
      } catch {
        /* unknown below */
      }
    }
    if (debit === null) return { known: false, why: "there is no broker mark and no spread quote for the position held" };
    const pl = (p.credit - debit) * 100 * qty;
    if (pl < 0) loss += pl;
  }
  return { known: true, loss: Math.round(loss * 100) / 100, source: [...sources].join(" and ") };
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

export interface LossCheck {
  hit: boolean;
  /** realized + the open loss when known. */
  total: number;
  /** The one Log line: realized, open loss (or that it is unknown), the limit and the verdict. */
  line: string;
  snapshot: LossCheckSnapshot;
}

/** Pure: judges one evaluation. Hit = total at or below minus the limit. */
export function judgeLossLimit(args: { limit: number; today: RealizedToday; open: OpenLoss; at: number }): LossCheck {
  const { limit, today, open, at } = args;
  const openLoss = open.known ? open.loss : null;
  const total = Math.round((today.realized + (openLoss ?? 0)) * 100) / 100;
  const hit = limit > 0 && total <= -limit + 1e-9;
  const realizedText = `realized ${usd(today.realized)} (${today.closedToday} closed or expired today${today.unpriced > 0 ? `, ${today.unpriced} with no price counted as 0` : ""})`;
  const openText = open.known ? `open loss ${usd(open.loss)} (${open.source})` : `open loss UNKNOWN (${open.why}) - not counted, not guessed`;
  const line = `Day's result: ${realizedText}, ${openText}, total ${usd(total)}, daily loss limit ${usd(limit)} - ${hit ? "LIMIT REACHED" : "within the limit"}`;
  return {
    hit,
    total,
    line,
    snapshot: { at, limit, realized: today.realized, openLoss, ...(open.known ? {} : { openLossWhy: open.why }), total, hit, closedToday: today.closedToday, unpriced: today.unpriced },
  };
}

/** One evaluation for a bot, reading today's results from the data and the open loss from the broker. */
export async function checkDailyLoss(args: { botId: string; limit: number; now: number; executor: BrokerExecutor; exclude?: ReadonlySet<string> }): Promise<LossCheck> {
  const { botId, limit, now, executor, exclude } = args;
  const today = realizedToday(botId, now);
  const held = positionsStore.query((p) => p.botId === botId && (p.status === "open" || p.status === "closing") && !exclude?.has(p.id));
  const open = await openLossOf(held, executor);
  return judgeLossLimit({ limit, today, open, at: now });
}
