"use client";

import { useState } from "react";
import { IconCopy } from "@/components/icons";

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
  inline = false,
}: {
  webhookId: string;
  maskedPath: string;
  origin: string;
  onCopied?: () => void;
  onProblem?: (message: string) => void;
  /** One line like Option Alpha's list: "URL: https://.../hook/•••• [copy icon]" (Reveal is a small link). */
  inline?: boolean;
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

  if (inline) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="shrink-0">URL:</span>
        <span className="min-w-0 truncate font-mono text-[13px]" aria-label="Webhook URL">
          {origin}
          {full ?? maskedPath}
        </span>
        <button type="button" className="shrink-0 text-xs text-accent hover:underline disabled:opacity-50" disabled={busy} onClick={full ? () => setFull(null) : reveal}>
          {full ? "Hide" : "Reveal"}
        </button>
        <button type="button" aria-label="Copy webhook URL" title={copied ? "Copied" : "Copy the webhook URL"} disabled={busy} onClick={copy} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50">
          <IconCopy width={16} height={16} className={copied ? "text-up" : undefined} />
        </button>
      </div>
    );
  }

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
