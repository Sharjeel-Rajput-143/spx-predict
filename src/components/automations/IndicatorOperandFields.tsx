"use client";

import { INDICATOR_DEFS, INDICATOR_LINE_KEYS, type IndicatorKind, type PriceSource } from "@/lib/indicators/registry";
import type { IndicatorOperand, ValueOperand } from "@/lib/automations/types";

const ALL_KINDS = Object.keys(INDICATOR_DEFS) as IndicatorKind[];
const SOURCES: PriceSource[] = ["close", "open", "high", "low", "hl2"];

const fieldClass = "w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm";
const labelClass = "mb-1 block text-xs font-medium text-muted";

function defaultIndicatorOperand(kind: IndicatorKind): IndicatorOperand {
  const def = INDICATOR_DEFS[kind];
  return { mode: "indicator", kind, settings: { ...def.defaultSettings }, lineKey: INDICATOR_LINE_KEYS[kind][0].key };
}

/** Lets the user configure either operand of an alert rule condition: pick
 * any indicator + its settings (reusing the same registry the chart's
 * indicator picker uses) and, for indicators with more than one output line
 * (MACD, Bollinger, Stochastic), which line to read - or a plain fixed value. */
export function IndicatorOperandFields({
  value,
  onChange,
  allowFixedValue,
  label,
}: {
  value: IndicatorOperand | ValueOperand;
  onChange: (v: IndicatorOperand | ValueOperand) => void;
  allowFixedValue: boolean;
  label: string;
}) {
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-faint">{label}</span>
        {allowFixedValue && (
          <div className="inline-flex rounded-lg bg-surface-2 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => onChange(defaultIndicatorOperand("ema"))}
              className={value.mode === "indicator" ? "rounded-md bg-surface px-2 py-1 font-semibold" : "px-2 py-1 text-muted"}
            >
              Indicator
            </button>
            <button
              type="button"
              onClick={() => onChange({ mode: "value", value: 0 })}
              className={value.mode === "value" ? "rounded-md bg-surface px-2 py-1 font-semibold" : "px-2 py-1 text-muted"}
            >
              Fixed value
            </button>
          </div>
        )}
      </div>

      {value.mode === "value" ? (
        <div>
          <label className={labelClass}>Value</label>
          <input
            type="number"
            step="any"
            value={value.value}
            onChange={(e) => onChange({ mode: "value", value: Number(e.target.value) })}
            className={fieldClass}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <label className={labelClass}>Indicator</label>
            <select
              value={value.kind}
              onChange={(e) => onChange(defaultIndicatorOperand(e.target.value as IndicatorKind))}
              className={fieldClass}
            >
              {ALL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {INDICATOR_DEFS[k].label}
                </option>
              ))}
            </select>
          </div>

          {INDICATOR_DEFS[value.kind].params.map((p) => (
            <div key={p.key}>
              <label className={labelClass}>{p.label}</label>
              <input
                type="number"
                min={p.min}
                max={p.max}
                step={p.step ?? 1}
                value={(value.settings[p.key] as number) ?? ""}
                onChange={(e) => onChange({ ...value, settings: { ...value.settings, [p.key]: Number(e.target.value) } })}
                className={fieldClass}
              />
            </div>
          ))}

          {INDICATOR_DEFS[value.kind].sourceSelectable && (
            <div>
              <label className={labelClass}>Source</label>
              <select
                value={value.settings.source ?? "close"}
                onChange={(e) => onChange({ ...value, settings: { ...value.settings, source: e.target.value as PriceSource } })}
                className={fieldClass}
              >
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          )}

          {INDICATOR_LINE_KEYS[value.kind].length > 1 && (
            <div className="col-span-2">
              <label className={labelClass}>Line</label>
              <select
                value={value.lineKey}
                onChange={(e) => onChange({ ...value, lineKey: e.target.value })}
                className={fieldClass}
              >
                {INDICATOR_LINE_KEYS[value.kind].map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
