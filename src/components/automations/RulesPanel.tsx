"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { IconChevron } from "../icons";
import type { AlertConnectionView, AlertRule } from "@/lib/automations/types";
import { AddRuleModal } from "./AddRuleModal";
import { RuleLog } from "./RuleLog";

type RuleView = AlertRule & { description: string };

function relativeTime(ms: number | null): string {
  if (ms == null) return "never";
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function RulesPanel({ connections }: { connections: AlertConnectionView[] }) {
  const [rules, setRules] = useState<RuleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = () => {
    fetch("/api/automations/rules")
      .then((r) => r.json())
      .then((data) => setRules(data.rules ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const toggleEnabled = async (rule: RuleView) => {
    await fetch(`/api/automations/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !rule.enabled }),
    });
    load();
  };

  const remove = async (rule: RuleView) => {
    if (!confirm(`Delete the rule "${rule.name}"?`)) return;
    await fetch(`/api/automations/rules/${rule.id}`, { method: "DELETE" });
    load();
  };

  const connectionLabel = (id: string) => connections.find((c) => c.id === id)?.label ?? "(deleted connection)";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Evaluated once per bar close, using the same indicator math as the chart.</p>
        <button
          onClick={() => setShowAdd(true)}
          className="shrink-0 rounded-lg bg-fg px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110"
        >
          Add rule
        </button>
      </div>

      {loading ? (
        <div className="h-24 animate-pulse rounded-2xl bg-surface-2" />
      ) : rules.length === 0 ? (
        <Card className="p-6 text-center text-sm text-faint">No rules yet. Add one to start watching for a signal.</Card>
      ) : (
        <div className="flex flex-col gap-2">
          {rules.map((rule) => (
            <Card key={rule.id} className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{rule.name}</div>
                  <div className="text-xs text-muted">{rule.description}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-faint">
                    <span>via {connectionLabel(rule.connectionId)}</span>
                    <span>last triggered {relativeTime(rule.lastTriggeredAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-muted">
                    <input type="checkbox" checked={rule.enabled} onChange={() => toggleEnabled(rule)} />
                    Enabled
                  </label>
                  <button onClick={() => remove(rule)} className="text-xs font-medium text-muted hover:text-down" aria-label={`Delete ${rule.name}`}>
                    Delete
                  </button>
                </div>
              </div>

              <button
                onClick={() => setExpanded(expanded === rule.id ? null : rule.id)}
                className="mt-2 flex items-center gap-1 text-xs font-medium text-muted hover:text-fg"
              >
                <IconChevron width={12} height={12} className={expanded === rule.id ? "rotate-180" : ""} />
                {expanded === rule.id ? "Hide" : "View"} trigger history
              </button>
              {expanded === rule.id && <RuleLog ruleId={rule.id} />}
            </Card>
          ))}
        </div>
      )}

      {showAdd && <AddRuleModal connections={connections} onClose={() => setShowAdd(false)} onCreated={load} />}
    </div>
  );
}
