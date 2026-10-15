"use client";

import { useCallback, useEffect, useState } from "react";
import type { Assessment, ResolveAction } from "@/lib/automation/positionResolve";
import { Btn, Checkbox, inputClass, Pill } from "./primitives";

/**
 * Resolve: for a position stuck in "closing" or "opening". The screen asks the broker first (read-only) and shows only the actions that
 * fit what the broker says. Nothing is typed into a status: the most a person types is a price when the broker's own order can't give one.
 */

const ACTION_LABEL: Record<ResolveAction, { label: string; tone: "primary" | "secondary" | "danger"; busy: string }> = {
  cancel_orders: { label: "Cancel the working order", tone: "primary", busy: "Cancelling…" },
  return_to_open: { label: "Return to open", tone: "primary", busy: "Returning…" },
  mark_closed: { label: "Mark closed", tone: "danger", busy: "Marking…" },
  mark_open: { label: "Mark open", tone: "primary", busy: "Marking…" },
  mark_rejected: { label: "Mark rejected", tone: "danger", busy: "Marking…" },
};

const PRICE_LABEL: Partial<Record<ResolveAction, string>> = {
  mark_closed: "Price it closed at (per spread)",
  mark_open: "Credit it opened at (per spread)",
};

const VERDICT_TONE = { holds_spread: "ok", holds_nothing: "warn", order_working: "warn", other_holdings: "error", no_broker: "neutral", broker_unreachable: "error" } as const;

/** The picture, with no fetching: what the broker said, and what can be done. Server-renderable. */
export function ResolveView({
  assessment: a,
  confirmed,
  onConfirm,
  price,
  onPrice,
  busy,
  onAct,
  onRetryClose,
}: {
  assessment: Assessment;
  confirmed: boolean;
  onConfirm: (v: boolean) => void;
  price: string;
  onPrice: (v: string) => void;
  busy: ResolveAction | null;
  onAct: (action: ResolveAction) => void;
  onRetryClose?: () => void;
}) {
  if (!a.resolvable) return <p className="text-sm text-muted">{a.headline}</p>;
  const needsPrice = a.needsPrice && a.actions.some((x) => x === "mark_closed" || x === "mark_open");
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {a.verdict && <Pill tone={VERDICT_TONE[a.verdict]}>{a.noBroker ? "no broker asked" : a.verdict === "broker_unreachable" ? "broker unreachable" : "broker asked"}</Pill>}
          <span className="font-semibold">{a.headline}</span>
        </div>
        <p className="text-muted">{a.detail}</p>
      </div>

      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 rounded-lg bg-surface-2 px-3 py-2 text-xs">
        <dt className="text-faint">Our records say</dt>
        <dd>{a.status}; it should hold {a.expected.short} short leg and +{a.expected.long} long leg</dd>
        <dt className="text-faint">The broker holds</dt>
        <dd>{a.held ? `${a.held.short} short leg and ${a.held.long} long leg` : a.noBroker ? "not asked" : "unknown"}</dd>
        {a.workingOrders.length > 0 && (
          <>
            <dt className="text-faint">Still working</dt>
            <dd>{a.workingOrders.map((w) => `${w.kind} order ${w.ref} (${w.status})`).join(", ")}</dd>
          </>
        )}
        {a.fill && (
          <>
            <dt className="text-faint">Broker's fill</dt>
            <dd>
              {a.fill.quantity} at ${a.fill.price.toFixed(2)}
            </dd>
          </>
        )}
      </dl>

      {needsPrice && (
        <label className="block space-y-1">
          <span className="text-xs text-muted">{PRICE_LABEL[a.actions.find((x) => PRICE_LABEL[x]) as ResolveAction]}: the broker's own order didn't show one</span>
          <input className={inputClass} inputMode="decimal" value={price} onChange={(e) => onPrice(e.target.value)} aria-label="Price per spread" placeholder="e.g. 2.40" />
        </label>
      )}

      {a.actions.length === 0 && !a.canRetryClose ? (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500">Nothing can be done from here. Fix it at the broker, then open this again.</p>
      ) : (
        <div className="space-y-3">
          <Checkbox
            checked={confirmed}
            onChange={onConfirm}
            label={a.noBroker ? "I know no broker account was asked. This is what really happened." : "I have seen what the broker shows and want to do this."}
          />
          <div className="flex flex-wrap gap-2">
            {a.actions.map((action) => (
              <Btn key={action} kind={ACTION_LABEL[action].tone} disabled={!confirmed || busy !== null} onClick={() => onAct(action)}>
                {busy === action ? ACTION_LABEL[action].busy : ACTION_LABEL[action].label}
              </Btn>
            ))}
            {a.canRetryClose && onRetryClose && (
              <Btn kind="secondary" disabled={busy !== null} onClick={onRetryClose}>
                Close position (try the close again)
              </Btn>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Fetches the broker's answer and carries out the chosen action. */
export function ResolvePanel({
  positionId,
  onChanged,
  onRetryClose,
  notify,
  onDone,
}: {
  positionId: string;
  onChanged: () => void;
  onRetryClose: () => void;
  notify: (tone: "ok" | "error", text: string) => void;
  onDone: () => void;
}) {
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState<ResolveAction | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/automation/positions/${positionId}/resolve`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error ?? "Couldn't ask the broker.");
      else setAssessment(json.assessment as Assessment);
    } catch {
      setError("Couldn't reach the server.");
    }
  }, [positionId]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: ResolveAction) => {
    setBusy(action);
    try {
      const parsed = Number(price.replace(/,/g, ""));
      const res = await fetch(`/api/automation/positions/${positionId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, confirm: confirmed, ...(price.trim() !== "" && Number.isFinite(parsed) ? { price: parsed } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        notify("error", json.error ?? "That didn't work.");
      } else {
        notify("ok", json.result?.text ?? "Done.");
        setConfirmed(false);
        setPrice("");
        onChanged();
        if (action === "cancel_orders") setAssessment(json.result?.assessment ?? null);
        else onDone();
      }
    } catch {
      notify("error", "Couldn't reach the server.");
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-down">{error}</p>
        <Btn kind="secondary" onClick={() => void load()}>
          Ask again
        </Btn>
      </div>
    );
  }
  if (!assessment) return <p className="text-sm text-muted">Asking the broker…</p>;
  return (
    <div className="space-y-3">
      <ResolveView assessment={assessment} confirmed={confirmed} onConfirm={setConfirmed} price={price} onPrice={setPrice} busy={busy} onAct={(a) => void act(a)} onRetryClose={onRetryClose} />
      <button type="button" onClick={() => void load()} className="text-xs text-muted hover:text-fg">
        Ask the broker again
      </button>
    </div>
  );
}
