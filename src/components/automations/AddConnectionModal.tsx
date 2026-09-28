"use client";

import { useState } from "react";
import { IconX } from "../icons";
import type { AlertConnectionView } from "@/lib/automations/types";

export function AddConnectionModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (connection: AlertConnectionView) => void;
}) {
  const [label, setLabel] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/automations/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, platform: "Option Alpha", webhookUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }
      onCreated(data.connection);
      onClose();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-t-2xl border border-line bg-surface p-4 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Add connection</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-fg">
            <IconX width={16} height={16} />
          </button>
        </div>

        <div className="flex flex-col gap-3 text-sm">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Platform</label>
            <select disabled className="w-full rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-muted">
              <option>Option Alpha</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Label</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. My 0DTE bot"
              className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm outline-none placeholder:text-faint"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Webhook URL</label>
            <input
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://app.optionalpha.com/hook/..."
              className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm outline-none placeholder:text-faint"
            />
            <p className="mt-1 text-xs text-faint">
              This is masked as soon as it's saved - you won't be able to view the full URL again here.
            </p>
          </div>

          {error && <p className="text-xs text-down">{error}</p>}

          <button
            onClick={submit}
            disabled={saving || !label.trim() || !webhookUrl.trim()}
            className="mt-1 rounded-lg bg-fg px-3 py-2 text-sm font-semibold text-bg disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save connection"}
          </button>
        </div>
      </div>
    </div>
  );
}
