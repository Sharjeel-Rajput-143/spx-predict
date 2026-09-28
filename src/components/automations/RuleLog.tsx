"use client";

import { useEffect, useState } from "react";
import type { AlertTriggerLog } from "@/lib/automations/types";

export function RuleLog({ ruleId }: { ruleId: string }) {
  const [log, setLog] = useState<AlertTriggerLog[] | null>(null);

  useEffect(() => {
    fetch(`/api/automations/rules/${ruleId}/log`)
      .then((r) => r.json())
      .then((data) => setLog(data.log ?? []));
  }, [ruleId]);

  if (log === null) return <div className="mt-2 h-12 animate-pulse rounded-lg bg-surface-2" />;
  if (log.length === 0) return <p className="mt-2 text-xs text-faint">No deliveries yet.</p>;

  return (
    <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-line">
      {log.map((entry) => (
        <li key={entry.id} className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5 text-xs last:border-b-0">
          <span className="text-muted">{new Date(entry.firedAt).toLocaleString()}</span>
          <span className="flex items-center gap-1.5">
            {entry.attempt > 1 && <span className="text-faint">attempt {entry.attempt}</span>}
            <span
              className={
                "rounded px-1.5 py-0.5 font-medium " + (entry.success ? "bg-up-soft text-up" : "bg-down-soft text-down")
              }
            >
              {entry.success ? `${entry.statusCode}` : entry.error ?? entry.statusCode ?? "failed"}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
