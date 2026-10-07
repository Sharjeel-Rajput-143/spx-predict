"use client";

import { useState } from "react";

/**
 * A webhook URL with its secret hidden. The page only ever has the masked path; the full URL is fetched when a
 * person asks (Reveal, or Copy for TradingView), kept in this component only while it is revealed, and never logged.
 */
export function SecretUrl({
  webhookId,
  maskedPath,
  origin,
  onCopied,
  onProblem,
}: {
  webhookId: string;
  maskedPath: string;
  origin: string;
  onCopied?: () => void;
  onProblem?: (message: string) => void;
}) {
  const [full, setFull] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchFull = async (): Promise<string | null> => {
    try {
      const res = await fetch(`/api/automation/webhooks/${webhookId}/url`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      return ((await res.json()) as { path: string }).path;
    } catch {
      onProblem?.("Couldn't get the webhook URL.");
      return null;
    }
  };

  const reveal = async () => {
    setBusy(true);
    setFull(await fetchFull());
    setBusy(false);
  };

  const copy = async () => {
    setBusy(true);
    const path = full ?? (await fetchFull());
    setBusy(false);
    if (!path) return;
    try {
      await navigator.clipboard.writeText(`${origin}${path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      onCopied?.();
    } catch {
      onProblem?.("Couldn't copy it.");
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">Webhook URL (keep it secret)</span>
        <span className="flex gap-3">
          <button type="button" className="text-xs text-accent hover:underline disabled:opacity-50" disabled={busy} onClick={full ? () => setFull(null) : reveal}>
            {full ? "Hide" : "Reveal"}
          </button>
          <button type="button" className="text-xs text-accent hover:underline disabled:opacity-50" disabled={busy} onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-line bg-bg px-3 py-2 font-mono text-xs" aria-label="Webhook URL">
        {origin}
        {full ?? maskedPath}
      </pre>
    </div>
  );
}
