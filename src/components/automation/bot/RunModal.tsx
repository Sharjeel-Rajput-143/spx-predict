"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/format";
import type { Decision } from "@/lib/automation/types";
import { Field, Modal, Pill, buttonClass, inputClass } from "./primitives";
import { outcomeInfo } from "./model";

/** "Run Automation": pushes one signal through the engine now, exactly as if
 * TradingView had sent it - same lock, same guards, same decision log. */
export function RunModal({
  botId,
  initialSignal,
  lastPrice,
  onClose,
  onDone,
}: {
  botId: string;
  initialSignal?: "bullish" | "bearish";
  lastPrice?: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [signal, setSignal] = useState<"bullish" | "bearish">(initialSignal ?? "bullish");
  const [price, setPrice] = useState(lastPrice ? String(lastPrice) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Decision[] | null>(null);

  // Default the price to the live SPX quote when there is one.
  useEffect(() => {
    if (price) return;
    fetch("/api/quote?symbol=SPX")
      .then((r) => r.json())
      .then((q) => q?.tick?.price && setPrice(String(q.tick.price)))
      .catch(() => undefined);
  }, [price]);

  const run = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/automation/bots/${botId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signal, ...(price.trim() ? { price: Number(price) } : {}) }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(json.error ?? "The run failed.");
    setDecisions(json.decisions);
    onDone();
  };

  return (
    <Modal
      title="Run automation"
      onClose={onClose}
      footer={
        decisions ? (
          <button className={buttonClass.primary} onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className={buttonClass.secondary} onClick={onClose}>
              Cancel
            </button>
            <button className={buttonClass.primary} onClick={run} disabled={busy}>
              {busy ? "Running..." : "Run"}
            </button>
          </>
        )
      }
    >
      {decisions ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">The engine decided:</p>
          {decisions.length === 0 && <p className="text-sm text-muted">No decision was recorded.</p>}
          <ul className="space-y-2">
            {decisions.map((d) => {
              const info = outcomeInfo(d.outcome);
              return (
                <li key={d.id} className="rounded-lg border border-line px-3 py-2 text-sm">
                  <Pill tone={info.tone}>{info.label}</Pill>
                  <p className="mt-1 text-muted">{d.reason}</p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Runs this bot&apos;s logic once, as if that signal had just arrived from TradingView. It goes through the same guards (switch,
            hours, duplicates, limits) and may place a real order with the executor.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {(["bullish", "bearish"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSignal(s)}
                aria-pressed={signal === s}
                className={cn(
                  "rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                  signal === s ? "border-accent bg-accent/10" : "border-line hover:bg-surface-2",
                )}
              >
                <div className="font-medium capitalize">{s}</div>
                <div className="text-xs text-muted">{s === "bullish" ? "Wants a short put spread" : "Wants a short call spread"}</div>
              </button>
            ))}
          </div>
          <Field label="SPX price" hint="Defaults to the live quote when available. Strikes are built from this.">
            <input className={inputClass} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 7720.5" />
          </Field>
          {error && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
