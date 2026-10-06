import "server-only";
import crypto from "node:crypto";
import { runsStore } from "./store";
import type { DecisionOutcome, Position, Run, TraceNode } from "./types";

const TYPE_NAME: Record<string, string> = { short_put_spread: "Short Put Spread", short_call_spread: "Short Call Spread" };
export const typeName = (type: string) => TYPE_NAME[type] ?? type;

const strike = (n: number) => n.toLocaleString("en-US");

/** "SPX Short Call Spread Oct 2 / -7,720 call, +7,725 call": short leg negative, long positive. */
export function describeLegs(p: Pick<Position, "underlying" | "type" | "expiry" | "shortStrike" | "longStrike">): string {
  const side = p.type === "short_put_spread" ? "put" : "call";
  const date = new Date(`${p.expiry}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  return `${p.underlying} ${typeName(p.type)} ${date} / -${strike(p.shortStrike)} ${side}, +${strike(p.longStrike)} ${side}`;
}

/**
 * Collects what one run walks through, in order, and saves it once at the end.
 * Each decision keeps the real value it compared, each action keeps the
 * settings it was sent with - so the log can replay the run, not summarise it.
 */
export class RunRecorder {
  readonly nodes: TraceNode[] = [];
  private saved = false;

  constructor(
    readonly meta: Omit<Run, "nodes" | "id"> & { id?: string },
  ) {}

  get id(): string {
    return (this.meta.id ??= `run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  }

  decision(text: string, result: boolean, measured: string): boolean {
    this.nodes.push({ kind: "decision", text, result, measured });
    return result;
  }

  action(node: { action: "open" | "close"; title: string; position?: Position | null; summary?: string; params: { label: string; value: string }[]; outcome: DecisionOutcome; reason: string }): void {
    this.nodes.push({
      kind: "action",
      action: node.action,
      title: node.title,
      positionId: node.position?.id ?? null,
      summary: node.summary ?? (node.position ? describeLegs(node.position) : ""),
      params: node.params,
      outcome: node.outcome,
      reason: node.reason,
    });
  }

  /** Writes the run. Safe to call more than once; only the first call saves. */
  save(): Run | null {
    if (this.saved) return null;
    this.saved = true;
    const run: Run = { ...this.meta, id: this.id, nodes: this.nodes };
    runsStore.insert(run);
    return run;
  }
}
