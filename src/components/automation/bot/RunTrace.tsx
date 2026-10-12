"use client";

import Link from "next/link";
import { useState } from "react";
import { IconInfo } from "@/components/icons";
import { cn } from "@/lib/format";
import type { Run, TraceAction, TraceDecision } from "@/lib/automation/types";
import { Btn, Drawer, Pill } from "./primitives";
import { etDateTime, outcomeInfo } from "./model";

type View = { name: "trace" } | { name: "decision"; node: TraceDecision };

/**
 * "Automation Log": a replay of one run. Each check shows its recorded
 * Yes/No (tap it for the value it compared), each order is a result card with
 * the exact legs and a frozen copy of the settings it used, and it always ends.
 */
export function RunTrace({
  run,
  positionExists,
  onViewPosition,
  onAutomation,
  onClose,
}: {
  run: Run;
  /** Whether a position still exists (it may have been deleted with its bot's history). */
  positionExists: (positionId: string) => boolean;
  onViewPosition: (positionId: string) => void;
  onAutomation: () => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>({ name: "trace" });

  if (view.name === "decision") {
    return <DecisionLog node={view.node} run={run} onBack={() => setView({ name: "trace" })} onClose={onClose} />;
  }

  return (
    <Drawer title="Automation log" onClose={onClose} wide>
      <div className="space-y-5">
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Automation</dt>
            <dd className="mt-0.5">
              <button onClick={onAutomation} className="font-semibold text-accent hover:underline">
                {run.automation}
              </button>
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Triggered by</dt>
            <dd className="mt-0.5">
              {run.source === "webhook" ? (
                <Link href="/settings" className="font-semibold text-accent hover:underline">
                  {run.trigger}
                </Link>
              ) : (
                <span className="font-semibold">{run.trigger}</span>
              )}
            </dd>
          </div>
        </dl>

        <div className="rounded-xl border border-line bg-bg px-4 py-5">
          <div className="text-center">
            <div className="tabular text-[11px] text-faint">{etDateTime(run.startedAt)}</div>
            <div className="mt-0.5 text-sm font-semibold">Start automation</div>
          </div>

          <ol className="mt-1">
            {run.nodes.map((node, i) => (
              <li key={i}>
                <Arrow />
                {node.kind === "decision" ? (
                  <DecisionNode node={node} onOpen={() => setView({ name: "decision", node })} />
                ) : (
                  <ActionCard node={node} exists={!!node.positionId && positionExists(node.positionId)} onViewPosition={onViewPosition} />
                )}
              </li>
            ))}
            <li>
              <Arrow />
              <div className="text-center text-sm font-semibold">End</div>
            </li>
          </ol>
        </div>
      </div>
    </Drawer>
  );
}

const Arrow = () => (
  <div aria-hidden className="py-1.5 text-center text-faint">
    ↓
  </div>
);

/** The same orange-circle pill the flow builder draws, with the recorded answer beneath it. */
function DecisionNode({ node, onOpen }: { node: TraceDecision; onOpen: () => void }) {
  return (
    <div className="text-center">
      <button
        onClick={onOpen}
        title="See the value it checked"
        className="inline-flex max-w-full items-center gap-3 rounded-full border border-line bg-surface py-1.5 pl-2 pr-4 text-left hover:border-accent"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-amber-500/20 text-sm font-bold text-amber-500">?</span>
        <span className="text-sm font-medium">{node.text}</span>
      </button>
      <div className={cn("mt-1 text-xs font-semibold", node.result ? "text-up" : "text-down")}>{node.result ? "Yes" : "No"}</div>
    </div>
  );
}

function ActionCard({ node, exists, onViewPosition }: { node: TraceAction; exists: boolean; onViewPosition: (id: string) => void }) {
  const ok = node.outcome === "opened" || node.outcome === "closed";
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 text-left">
      <div className="flex items-center gap-2">
        <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg text-sm font-bold", node.action === "open" ? "bg-up-soft text-up" : "bg-down-soft text-down")}>
          {node.action === "open" ? "+" : "−"}
        </span>
        <span className="min-w-0 flex-1 text-sm font-semibold">{node.title}</span>
        <ParamsTip params={node.params} />
      </div>
      {node.summary && <p className="tabular mt-2 text-sm text-muted">{node.summary}</p>}
      {node.steps && node.steps.length > 0 && (
        <ol aria-label="Prices tried" className="mt-2 space-y-1 border-l-2 border-line pl-3 text-xs text-muted">
          {node.steps.map((step, i) => (
            <li key={i} className="tabular">
              {step}
            </li>
          ))}
        </ol>
      )}
      {!ok && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <Pill tone={outcomeInfo(node.outcome).tone}>{outcomeInfo(node.outcome).label}</Pill>
          <span className="text-muted">{node.reason}</span>
        </div>
      )}
      {node.positionId && (
        <Btn kind="secondary" className="mt-3 !px-3 !py-1.5"
          onClick={() => onViewPosition(node.positionId!)}
          disabled={!exists}
          title={exists ? undefined : "This position is no longer in the list"}
          
        >
          View position
        </Btn>
      )}
    </div>
  );
}

/** (i) icon: a dark card listing what the order was sent with, as it was then. */
function ParamsTip({ params }: { params: { label: string; value: string }[] }) {
  return (
    <span className="group relative">
      <button type="button" aria-label="Settings this order was sent with" className="text-faint hover:text-fg focus:text-fg">
        <IconInfo width={16} height={16} />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-30 mt-1.5 hidden w-72 rounded-lg bg-neutral-900 px-3 py-2.5 text-left text-xs text-white shadow-xl group-focus-within:block group-hover:block"
      >
        <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-neutral-400">As sent</span>
        {params.map((p) => (
          <span key={p.label} className="flex justify-between gap-3 py-0.5">
            <span className="text-neutral-400">{p.label}</span>
            <span className="tabular text-right">{p.value}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/** Drill-down: the condition, whether it held, and the value the engine measured. */
export function DecisionLog({ node, run, onBack, onClose }: { node: TraceDecision; run: Run; onBack: () => void; onClose: () => void }) {
  return (
    <Drawer title="Decision log" onClose={onClose} onBack={onBack} wide>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-line px-4 py-3">
          <span
            aria-label={node.result ? "Passed" : "Failed"}
            className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-sm font-bold", node.result ? "bg-up-soft text-up" : "bg-down-soft text-down")}
          >
            {node.result ? "✓" : "×"}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold">{node.text}</div>
            <div className="tabular mt-1 text-sm text-muted">{node.measured}</div>
          </div>
        </div>
        <p className="text-xs text-faint">
          {node.result ? "This condition held, so the run carried on." : "This condition did not hold, so the run stopped here."} Recorded {etDateTime(run.startedAt)} for {run.automation}.
        </p>
      </div>
    </Drawer>
  );
}
