"use client";

import { useState } from "react";
import { IconX } from "../icons";
import { TICKERS, TIMEFRAMES, type Timeframe } from "@/lib/config";
import type { AlertConnectionView, ConditionType, IndicatorOperand, ValueOperand } from "@/lib/automations/types";
import { IndicatorOperandFields } from "./IndicatorOperandFields";

const CONDITIONS: { value: ConditionType; label: string }[] = [
  { value: "crossing_up", label: "Crossing Up" },
  { value: "crossing_down", label: "Crossing Down" },
  { value: "greater_than", label: "Greater Than" },
  { value: "less_than", label: "Less Than" },
  { value: "crosses_value", label: "Crosses Value" },
];

const fieldClass = "w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm";
const labelClass = "mb-1 block text-xs font-medium text-muted";

export function AddRuleModal({
  connections,
  onClose,
  onCreated,
}: {
  connections: AlertConnectionView[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [symbol, setSymbol] = useState(TICKERS[0].symbol);
  const [timeframe, setTimeframe] = useState<Timeframe>("5m");
  const [operandA, setOperandA] = useState<IndicatorOperand>({ mode: "indicator", kind: "ema", settings: { length: 9, source: "close" }, lineKey: "value" });
  const [condition, setCondition] = useState<ConditionType>("crossing_up");
  const [operandB, setOperandB] = useState<IndicatorOperand | ValueOperand>({
    mode: "indicator",
    kind: "ema",
    settings: { length: 20, source: "close" },
    lineKey: "value",
  });
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError(null);
    if (!connectionId) {
      setError("Pick a connection.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/automations/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, timeframe, operandA, condition, operandB, connectionId, message }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }
      onCreated();
      onClose();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  if (connections.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
        <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-4 text-sm" onClick={(e) => e.stopPropagation()}>
          <p className="text-muted">Add a connection first - a rule needs somewhere to send its webhook.</p>
          <button onClick={onClose} className="mt-3 rounded-lg bg-fg px-3 py-1.5 text-sm font-semibold text-bg">
            Got it
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-line bg-surface sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line p-4">
          <h2 className="text-sm font-semibold">Add rule</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-fg">
            <IconX width={16} height={16} />
          </button>
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto p-4 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass}>Symbol</label>
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className={fieldClass}>
                {TICKERS.map((t) => (
                  <option key={t.symbol} value={t.symbol}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Timeframe</label>
              <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)} className={fieldClass}>
                {TIMEFRAMES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <IndicatorOperandFields value={operandA} onChange={(v) => setOperandA(v as IndicatorOperand)} allowFixedValue={false} label="First indicator" />

          <div>
            <label className={labelClass}>Condition</label>
            <select value={condition} onChange={(e) => setCondition(e.target.value as ConditionType)} className={fieldClass}>
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <IndicatorOperandFields value={operandB} onChange={setOperandB} allowFixedValue label="Compare against" />

          <div>
            <label className={labelClass}>Connection</label>
            <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className={fieldClass}>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.platform})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass}>Custom message (optional)</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              placeholder="Sent as `message` in the webhook payload"
              className={`${fieldClass} resize-none`}
            />
          </div>

          {error && <p className="text-xs text-down">{error}</p>}
        </div>

        <div className="border-t border-line p-4">
          <button
            onClick={submit}
            disabled={saving}
            className="w-full rounded-lg bg-fg px-3 py-2 text-sm font-semibold text-bg disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save rule"}
          </button>
        </div>
      </div>
    </div>
  );
}
