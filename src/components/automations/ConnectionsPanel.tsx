"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import type { AlertConnectionView } from "@/lib/automations/types";
import { AddConnectionModal } from "./AddConnectionModal";

export function ConnectionsPanel() {
  const [connections, setConnections] = useState<AlertConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const load = () => {
    fetch("/api/automations/connections")
      .then((r) => r.json())
      .then((data) => setConnections(data.connections ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const toggleActive = async (c: AlertConnectionView) => {
    await fetch(`/api/automations/connections/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !c.active }),
    });
    load();
  };

  const remove = async (c: AlertConnectionView) => {
    if (!confirm(`Delete the connection "${c.label}"?`)) return;
    const res = await fetch(`/api/automations/connections/${c.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error ?? "Could not delete this connection.");
      return;
    }
    load();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Webhook URLs are encrypted at rest and masked here - once saved, the full URL is never shown again.</p>
        <button
          onClick={() => setShowAdd(true)}
          className="shrink-0 rounded-lg bg-fg px-3 py-1.5 text-sm font-semibold text-bg hover:brightness-110"
        >
          Add connection
        </button>
      </div>

      {loading ? (
        <div className="h-24 animate-pulse rounded-2xl bg-surface-2" />
      ) : connections.length === 0 ? (
        <Card className="p-6 text-center text-sm text-faint">No connections yet. Add one to start building rules.</Card>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {connections.map((c) => (
            <Card key={c.id} className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{c.label}</div>
                  <div className="text-xs text-faint">{c.platform}</div>
                  <div className="tabular mt-1 truncate text-xs text-muted">{c.maskedUrl}</div>
                </div>
                <button
                  onClick={() => remove(c)}
                  className="shrink-0 text-xs font-medium text-muted hover:text-down"
                  aria-label={`Delete ${c.label}`}
                >
                  Delete
                </button>
              </div>
              <label className="mt-2 flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={c.active} onChange={() => toggleActive(c)} />
                Active
              </label>
            </Card>
          ))}
        </div>
      )}

      {showAdd && (
        <AddConnectionModal
          onClose={() => setShowAdd(false)}
          onCreated={(c) => setConnections((prev) => [...prev, c])}
        />
      )}
    </div>
  );
}
