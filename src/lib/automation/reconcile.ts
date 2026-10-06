import "server-only";
import { logDecision } from "./decisions";
import { ensureBotRecord } from "./bots";
import { botsStore, positionsStore } from "./store";
import { occSymbol } from "./tradierExecutor";
import type { BrokerExecutor, Position } from "./types";

/**
 * "Automated does not mean unattended": compares what our records say is open
 * with what the broker itself holds, leg by leg. It reports and flags - it
 * never closes or opens anything to "fix" a difference, because a person has
 * to decide which side is right.
 */

export type ProblemKind = "missing_at_broker" | "quantity_mismatch" | "unknown_at_broker" | "no_option_root";

export interface ReconcileProblem {
  kind: ProblemKind;
  symbol: string;
  /** Contracts we expect (negative = short). */
  expected?: number;
  /** Contracts the broker holds. */
  actual?: number;
  botId?: string;
  text: string;
}

export interface ReconcileReport {
  checkedAt: number;
  ok: boolean;
  /** Option legs our open positions say the account holds. */
  expectedLegs: number;
  /** Option legs the broker reports. */
  brokerLegs: number;
  problems: ReconcileProblem[];
}

const OPTION_SYMBOL = /^([A-Z]+)\d{6}[CP]\d{8}$/;

const legsOf = (p: Position): { symbol: string; quantity: number }[] | null => {
  if (!p.optionRoot) return null;
  const right = p.type === "short_put_spread" ? "put" : "call";
  const q = p.filledQuantity || p.requestedQuantity;
  return [
    { symbol: occSymbol(p.optionRoot, p.expiry, right, p.shortStrike), quantity: -q },
    { symbol: occSymbol(p.optionRoot, p.expiry, right, p.longStrike), quantity: q },
  ];
};

/** Reads the broker's positions and compares. Executors that can't list them (the mock) have nothing to compare. */
export async function reconcile(executor: BrokerExecutor, now: number = Date.now()): Promise<ReconcileReport> {
  if (!executor.listBrokerPositions) throw new Error("This executor has no broker account to compare against.");
  const broker = await executor.listBrokerPositions();

  const expected = new Map<string, { quantity: number; botIds: Set<string> }>();
  const problems: ReconcileProblem[] = [];
  const roots = new Set<string>();

  for (const p of positionsStore.query((x) => x.status === "open")) {
    const legs = legsOf(p);
    if (!legs) {
      problems.push({ kind: "no_option_root", symbol: `${p.underlying} ${p.shortStrike}/${p.longStrike}`, botId: p.botId, text: `${p.botId}: an open position has no option root recorded, so it can't be matched at the broker.` });
      continue;
    }
    roots.add(p.optionRoot!);
    for (const leg of legs) {
      const e = expected.get(leg.symbol) ?? { quantity: 0, botIds: new Set<string>() };
      e.quantity += leg.quantity;
      e.botIds.add(p.botId);
      expected.set(leg.symbol, e);
    }
  }

  const held = new Map(broker.map((b) => [b.symbol, b.quantity]));
  for (const [symbol, e] of expected) {
    const actual = held.get(symbol) ?? 0;
    const botId = [...e.botIds][0];
    if (actual === 0) problems.push({ kind: "missing_at_broker", symbol, expected: e.quantity, actual: 0, botId, text: `${symbol}: we show ${e.quantity} but the broker holds none.` });
    else if (actual !== e.quantity) problems.push({ kind: "quantity_mismatch", symbol, expected: e.quantity, actual, botId, text: `${symbol}: we show ${e.quantity} but the broker holds ${actual}.` });
  }
  // Only options on a series our bots trade count as "unknown" - the account may hold other things that aren't ours.
  for (const b of broker) {
    const root = OPTION_SYMBOL.exec(b.symbol)?.[1];
    if (root && roots.has(root) && !expected.has(b.symbol) && b.quantity !== 0) {
      problems.push({ kind: "unknown_at_broker", symbol: b.symbol, expected: 0, actual: b.quantity, text: `${b.symbol}: the broker holds ${b.quantity} that none of our open positions explain.` });
    }
  }

  return { checkedAt: now, ok: problems.length === 0, expectedLegs: expected.size, brokerLegs: broker.filter((b) => OPTION_SYMBOL.test(b.symbol)).length, problems };
}

/** Flags every bot involved and writes an error decision (which raises an Error alert). Never trades. */
export function flagMismatches(report: ReconcileReport): void {
  if (report.ok) return;
  const bots = new Set(report.problems.map((p) => p.botId).filter((b): b is string => !!b));
  const summary = `Broker position mismatch: ${report.problems.map((p) => p.text).join(" ")}`;
  for (const botId of bots) {
    ensureBotRecord(botId);
    botsStore.update(botId, { needsAttention: true, needsAttentionReason: summary.slice(0, 300) });
    logDecision({ signalId: null, botId, outcome: "executor_error", reason: summary.slice(0, 500), detail: { reconcile: report.problems }, now: report.checkedAt });
  }
}
