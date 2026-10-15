import "server-only";
import { ensureBotRecord } from "./bots";
import { logDecision } from "./decisions";
import { confirmOver } from "./orderWatch";
import { positionQuantity } from "./pnl";
import { botsStore, ordersStore, positionsStore } from "./store";
import { occSymbol } from "./tradierExecutor";
import type { BrokerExecutor, Order, OrderState, Position } from "./types";

/**
 * Resolve: getting a position out of "closing" (or "opening") when the engine could not tell what happened at the broker - an order that was
 * lost, a close done by hand, a cancel nobody confirmed. It NEVER lets anyone type a status. It asks the broker first (read-only), works out
 * what is really held, and offers only the actions that fit that answer:
 *
 *   an order is still working          -> cancel the order(s), then ask again
 *   the broker holds the whole spread  -> return it to "open" (or press Close position to try the close again)
 *   the broker holds nothing           -> mark it closed (or, for an opening, rejected)
 *   anything else (one leg, a size)    -> nothing: it says what the account holds, and a person fixes it at the broker
 *
 * A simulated position has no broker account to ask; it is offered the choices that fit its kind of stuck, with a plain warning.
 * Every use is logged with what the broker showed. Nothing here opens or closes anything at the broker, except cancelling an order that is
 * still working. Callers hold the bot's lock (see the route).
 */

export type ResolveAction = "cancel_orders" | "return_to_open" | "mark_closed" | "mark_open" | "mark_rejected";
export type Verdict = "order_working" | "holds_spread" | "holds_nothing" | "other_holdings" | "no_broker" | "broker_unreachable";

export interface WorkingOrder {
  id: string;
  ref: string;
  kind: Order["kind"];
  /** What the broker says it is, not what our row says. */
  status: OrderState["status"] | "unknown";
}

export interface Assessment {
  positionId: string;
  status: Position["status"];
  resolvable: boolean;
  verdict: Verdict | null;
  headline: string;
  detail: string;
  /** What the broker holds on each leg (signed contracts), or null when it was not asked or could not answer. */
  held: { short: number; long: number } | null;
  /** What our records say it should hold. */
  expected: { short: number; long: number };
  workingOrders: WorkingOrder[];
  /** The price the broker's own order shows it filled at, when it could be read. */
  fill: { price: number; quantity: number } | null;
  actions: ResolveAction[];
  /** The action needs a price the broker could not give: the person types it (per spread). */
  needsPrice: boolean;
  /** The existing "Close position" button also applies (the broker still holds the spread and nothing is working). */
  canRetryClose: boolean;
  /** No broker account was asked (a simulated position, or the broker is not connected). */
  noBroker: boolean;
}

export interface ResolveInput {
  action: ResolveAction;
  /** Must be true: the person has seen what the broker showed and means it. */
  confirm: boolean;
  /** A price per spread: the close debit for "mark_closed", the credit for "mark_open", when the broker's own order could not give one. */
  price?: number;
}

const STUCK: readonly Position["status"][] = ["closing", "opening"];
const isStuck = (p: Position) => STUCK.includes(p.status);
const WORKING = ["working", "partially_filled"] as const;
const money = (n: number) => `$${n.toFixed(2)}`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Our own rows for the position's orders, newest first. */
const ordersOf = (positionId: string): Order[] => ordersStore.query((o) => o.positionId === positionId).sort((a, b) => b.createdAt - a.createdAt);

async function stateOf(executor: BrokerExecutor, order: Order): Promise<OrderState | null> {
  try {
    return await executor.getOrder(order.ref);
  } catch {
    return null;
  }
}

function legSymbols(p: Position): { short: string; long: string } | null {
  if (!p.optionRoot) return null;
  const right = p.type === "short_put_spread" ? "put" : "call";
  return { short: occSymbol(p.optionRoot, p.expiry, right, p.shortStrike), long: occSymbol(p.optionRoot, p.expiry, right, p.longStrike) };
}

/** Read-only: asks the broker and says what can safely be done. Writes nothing. */
export async function assessPosition(positionId: string, executor: BrokerExecutor): Promise<Assessment> {
  const p = positionsStore.get(positionId);
  if (!p) throw new Error("Position not found.");
  const q = positionQuantity(p);
  const base: Assessment = {
    positionId,
    status: p.status,
    resolvable: false,
    verdict: null,
    headline: "",
    detail: "",
    held: null,
    expected: { short: -q, long: q },
    workingOrders: [],
    fill: null,
    actions: [],
    needsPrice: false,
    canRetryClose: false,
    noBroker: false,
  };
  if (!isStuck(p)) return { ...base, headline: `Nothing to resolve: this position is ${p.status}.`, detail: "Resolve is only for a position stuck in closing or opening." };
  base.resolvable = true;
  const closing = p.status === "closing";
  const rows = ordersOf(p.id);

  // 1. Any order of ours that might still be alive. The broker's word counts, not our row's.
  const working: WorkingOrder[] = [];
  const states = new Map<string, OrderState | null>();
  for (const o of rows) {
    const believed = (WORKING as readonly string[]).includes(o.status);
    const state = await stateOf(executor, o);
    states.set(o.id, state);
    if (state ? (WORKING as readonly string[]).includes(state.status) : believed) working.push({ id: o.id, ref: o.ref, kind: o.kind, status: state?.status ?? "unknown" });
  }
  if (working.length > 0) {
    return {
      ...base,
      verdict: "order_working",
      workingOrders: working,
      actions: ["cancel_orders"],
      headline: `${working.length === 1 ? "An order for this position is" : `${working.length} orders for this position are`} still working${working.some((w) => w.status === "unknown") ? " (or can't be read)" : ""}.`,
      detail: "Cancel it first. Once the broker confirms it is over, ask again and the position can be resolved from what the account really holds.",
    };
  }

  // The price the broker's own latest order of the right kind says it filled at.
  const wanted = closing ? "close" : "open";
  let fill: Assessment["fill"] = null;
  for (const o of rows) {
    if (o.kind !== wanted) continue;
    const s = states.get(o.id);
    if (s && s.status === "filled" && s.averagePrice !== undefined && s.filledQuantity > 0) {
      fill = { price: s.averagePrice, quantity: s.filledQuantity };
      break;
    }
  }

  // 2. What the broker holds.
  const symbols = legSymbols(p);
  const simulated = p.venue === "mock" || p.venue === undefined;
  if (simulated || !executor.listBrokerPositions) {
    const why = simulated ? "This is a simulated position: there is no broker account to ask." : "No broker is connected right now, so there is nothing to ask.";
    return {
      ...base,
      verdict: "no_broker",
      noBroker: true,
      fill,
      actions: closing ? ["return_to_open", "mark_closed"] : ["mark_open", "mark_rejected"],
      needsPrice: closing ? fill === null : false,
      headline: why,
      detail: `${why} Choose what really happened. ${closing ? "Return it to open if it is still held, or mark it closed if it is gone." : "Mark it open if the order filled, or rejected if nothing was opened."}`,
    };
  }
  if (!symbols) {
    return { ...base, verdict: "broker_unreachable", fill, headline: "This position has no option series recorded, so it can't be matched at the broker.", detail: "Check it at the broker by hand." };
  }
  let held: { short: number; long: number };
  try {
    const all = await executor.listBrokerPositions();
    const of = (sym: string) => all.filter((x) => x.symbol === sym).reduce((s, x) => s + x.quantity, 0);
    held = { short: of(symbols.short), long: of(symbols.long) };
  } catch (err) {
    return { ...base, verdict: "broker_unreachable", fill, headline: "The broker could not be reached, so nothing is offered.", detail: `Asking it failed: ${message(err)}. Try again in a moment.` };
  }

  const heldText = `the account holds ${held.short} of the short leg and ${held.long} of the long leg`;
  if (closing) {
    if (held.short <= -q && held.long >= q) {
      return { ...base, verdict: "holds_spread", held, fill, actions: ["return_to_open"], canRetryClose: true, headline: "The broker still holds the whole spread.", detail: `Nothing is working and ${heldText}. Press Close position to try the close again, or return it to open so the next alert can flip it normally.` };
    }
    if (held.short === 0 && held.long === 0) {
      return { ...base, verdict: "holds_nothing", held, fill, actions: ["mark_closed"], needsPrice: fill === null, headline: "The broker holds nothing of this spread.", detail: `Nothing is working and ${heldText}: it was closed (by hand, or by an order that was lost track of). Mark it closed${fill ? ` at the price the broker shows, ${money(fill.price)}` : " and enter the price it closed at"}.` };
    }
    return { ...base, verdict: "other_holdings", held, fill, headline: "The account holds something else.", detail: `Expected ${q} of the spread (short ${-q}, long ${q}) but ${heldText}. Nothing can be settled automatically: fix it at the broker, then ask again.` };
  }
  // opening
  const size = held.short < 0 && held.long > 0 ? Math.min(-held.short, held.long) : 0;
  if (size >= 1 && held.short === -size && held.long === size) {
    return { ...base, verdict: "holds_spread", held, fill, actions: ["mark_open"], headline: `The broker holds the spread (${size} contract${size === 1 ? "" : "s"}).`, detail: `Nothing is working and ${heldText}. Mark the position open at that size${fill ? `, credit ${money(fill.price)} from the broker's order` : ""}.`, needsPrice: fill === null };
  }
  if (held.short === 0 && held.long === 0) {
    return { ...base, verdict: "holds_nothing", held, fill, actions: ["mark_rejected"], headline: "The broker holds nothing of this spread.", detail: `Nothing is working and ${heldText}: the open never filled. Mark it rejected so it stops counting as held.` };
  }
  return { ...base, verdict: "other_holdings", held, fill, headline: "The account holds something else.", detail: `${heldText[0].toUpperCase()}${heldText.slice(1)}, which doesn't match one whole spread. Nothing can be settled automatically: fix it at the broker, then ask again.` };
}

export interface ResolveResult {
  action: ResolveAction;
  text: string;
  /** The position as it is now. */
  position: Position;
}

/** Cancels every order of the position that is still alive and waits for the broker to say each one is over; our rows are updated to the truth. */
async function cancelWorking(executor: BrokerExecutor, working: WorkingOrder[], confirmMs: number): Promise<void> {
  for (const w of working) {
    try {
      await executor.cancelOrder(w.ref);
    } catch (err) {
      throw new Error(`Could not cancel order ${w.ref}: ${message(err)}. Nothing else was changed.`);
    }
    const state = await confirmOver(executor, w.ref, confirmMs, 500); // throws when the broker does not confirm
    ordersStore.update(w.id, { status: state.status, filledQuantity: state.filledQuantity, rejectReason: state.rejectReason, updatedAt: Date.now() });
  }
}

/** Brings our own order rows in line with what the broker says, for orders it says are over (a row can stay "working" for good otherwise). */
async function refreshRows(executor: BrokerExecutor, positionId: string): Promise<void> {
  for (const o of ordersOf(positionId)) {
    if (!(WORKING as readonly string[]).includes(o.status)) continue;
    const s = await stateOf(executor, o);
    if (s && !(WORKING as readonly string[]).includes(s.status)) ordersStore.update(o.id, { status: s.status, filledQuantity: s.filledQuantity, rejectReason: s.rejectReason, updatedAt: Date.now() });
  }
}

/**
 * Does what was chosen, if and only if the broker's answer, asked again right now, allows it. Throws a message fit to show otherwise, having
 * changed nothing.
 */
export async function resolvePosition(positionId: string, input: ResolveInput, executor: BrokerExecutor, now: number = Date.now(), options: { cancelConfirmMs?: number } = {}): Promise<ResolveResult> {
  if (input.confirm !== true) throw new Error("Confirm that you have seen what the broker shows and want to do this.");
  const before = positionsStore.get(positionId);
  if (!before) throw new Error("Position not found.");
  const a = await assessPosition(positionId, executor);
  if (!a.resolvable) throw new Error(a.headline);
  if (!a.actions.includes(input.action)) {
    throw new Error(`That isn't available now. ${a.headline} ${a.detail}`.trim());
  }
  const p = positionsStore.get(positionId)!;
  const width = Math.abs(p.shortStrike - p.longStrike);
  const q = positionQuantity(p);
  const brokerNote = a.noBroker ? "no broker account was asked" : a.held ? `the broker held ${a.held.short} short / ${a.held.long} long` : "the broker was asked";
  let text: string;

  const price = (what: string): number => {
    const v = a.fill?.price ?? input.price;
    if (v === undefined || !Number.isFinite(v)) throw new Error(`Enter the ${what} (per spread): the broker's own order didn't show one.`);
    if (v <= 0 || v >= width) throw new Error(`The ${what} has to be above 0 and below the spread's width of ${width}.`);
    return Math.round(v * 100) / 100;
  };

  switch (input.action) {
    case "cancel_orders": {
      await cancelWorking(executor, a.workingOrders, options.cancelConfirmMs ?? 15_000);
      text = `Cancelled ${a.workingOrders.length} working order${a.workingOrders.length === 1 ? "" : "s"} and the broker confirmed each is over. The position itself is unchanged: ask again to resolve it.`;
      break;
    }
    case "return_to_open": {
      await refreshRows(executor, positionId);
      positionsStore.update(positionId, { status: "open", closeSignalId: null });
      text = `Returned to open (${brokerNote}); nothing was sent.`;
      break;
    }
    case "mark_closed": {
      const closePrice = price("price it closed at");
      await refreshRows(executor, positionId);
      positionsStore.update(positionId, { status: "closed", closedAt: now, closePrice });
      text = `Marked closed at ${money(closePrice)} per spread (${brokerNote}); nothing was sent.`;
      break;
    }
    case "mark_open": {
      const size = a.held ? Math.min(-a.held.short, p.requestedQuantity) : q || p.requestedQuantity;
      const credit = a.fill?.price ?? input.price ?? p.credit ?? undefined;
      if (credit === undefined || !Number.isFinite(credit) || credit <= 0 || credit >= width) throw new Error(`Enter the credit it opened at (per spread, above 0 and below the width of ${width}): the broker's own order didn't show one.`);
      await refreshRows(executor, positionId);
      positionsStore.update(positionId, { status: "open", filledQuantity: size, credit: Math.round(credit * 100) / 100 });
      text = `Marked open at ${size} contract${size === 1 ? "" : "s"}, credit ${money(credit)} (${brokerNote}); nothing was sent.`;
      break;
    }
    case "mark_rejected": {
      await refreshRows(executor, positionId);
      positionsStore.update(positionId, { status: "rejected" });
      text = `Marked rejected: nothing was opened (${brokerNote}); nothing was sent.`;
      break;
    }
  }

  const position = positionsStore.get(positionId)!;
  logDecision({
    signalId: null,
    botId: p.botId,
    outcome: "position_resolved",
    reason: `${p.underlying} ${p.shortStrike}/${p.longStrike} (was ${p.status}): ${text}`,
    detail: { positionId, action: input.action, was: p.status, verdict: a.verdict, held: a.held, fill: a.fill, noBroker: a.noBroker, resolvedBy: "person" },
    now,
  });

  // The flag was raised because of the stuck position: with none left for this bot, it is cleared. (Cancelling orders changes nothing about the position.)
  if (input.action !== "cancel_orders") {
    const left = positionsStore.query((x) => x.botId === p.botId && isStuck(x));
    const bot = ensureBotRecord(p.botId);
    if (left.length === 0 && bot.needsAttention) botsStore.update(p.botId, { needsAttention: false, needsAttentionReason: null });
  }
  return { action: input.action, text, position };
}
