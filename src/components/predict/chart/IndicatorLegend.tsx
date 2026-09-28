"use client";

import { useEffect, useRef, useState } from "react";
import { INDICATOR_DEFS, type ActiveIndicator, type PriceSource } from "@/lib/indicators/registry";
import { cn } from "@/lib/format";
import { IconEye, IconEyeOff, IconGear, IconX } from "../../icons";

const SOURCES: PriceSource[] = ["close", "open", "high", "low", "hl2"];

export function IndicatorLegend({
  indicators,
  values,
  onToggle,
  onRemove,
  onUpdate,
}: {
  indicators: ActiveIndicator[];
  values: Record<string, string>;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, settings: ActiveIndicator["settings"]) => void;
}) {
  if (indicators.length === 0) return null;
  return (
    <div className="pointer-events-auto absolute left-2 top-8 z-10 flex flex-col gap-0.5 text-[11px]">
      {indicators.map((ind) => (
        <IndicatorRow
          key={ind.id}
          indicator={ind}
          value={values[ind.id] ?? "-"}
          onToggle={() => onToggle(ind.id)}
          onRemove={() => onRemove(ind.id)}
          onUpdate={(s) => onUpdate(ind.id, s)}
        />
      ))}
    </div>
  );
}

function IndicatorRow({
  indicator,
  value,
  onToggle,
  onRemove,
  onUpdate,
}: {
  indicator: ActiveIndicator;
  value: string;
  onToggle: () => void;
  onRemove: () => void;
  onUpdate: (settings: ActiveIndicator["settings"]) => void;
}) {
  const def = INDICATOR_DEFS[indicator.kind];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const paramSummary = def.params.map((p) => indicator.settings[p.key]).join(",");

  return (
    <div ref={ref} className="group relative flex items-center gap-1.5 rounded bg-bg/60 px-1.5 py-0.5 backdrop-blur-sm">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: indicator.settings.color ?? "#2962ff" }} />
      <span className={cn("font-medium", !indicator.visible && "opacity-50")}>
        {def.label}
        {paramSummary && <span className="text-faint">({paramSummary})</span>}
      </span>
      <span className={cn("tabular text-muted", !indicator.visible && "opacity-50")}>{value}</span>

      <span className="ml-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button onClick={onToggle} aria-label={indicator.visible ? "Hide" : "Show"} className="text-muted hover:text-fg">
          {indicator.visible ? <IconEye width={12} height={12} /> : <IconEyeOff width={12} height={12} />}
        </button>
        <button onClick={() => setOpen((o) => !o)} aria-label="Settings" className="text-muted hover:text-fg">
          <IconGear width={12} height={12} />
        </button>
        <button onClick={onRemove} aria-label="Remove" className="text-muted hover:text-down">
          <IconX width={12} height={12} />
        </button>
      </span>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-line bg-surface p-3 text-xs shadow-lg">
          <div className="mb-2 font-semibold">{def.label} settings</div>
          <div className="flex flex-col gap-2">
            {def.params.map((p) => (
              <label key={p.key} className="flex items-center justify-between gap-2">
                <span className="text-muted">{p.label}</span>
                <input
                  type="number"
                  min={p.min}
                  max={p.max}
                  step={p.step ?? 1}
                  value={indicator.settings[p.key] ?? ""}
                  onChange={(e) => onUpdate({ [p.key]: Number(e.target.value) })}
                  className="w-16 rounded border border-line bg-transparent px-1 py-0.5 text-right tabular"
                />
              </label>
            ))}
            {def.sourceSelectable && (
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted">Source</span>
                <select
                  value={indicator.settings.source ?? "close"}
                  onChange={(e) => onUpdate({ source: e.target.value as PriceSource })}
                  className="rounded border border-line bg-surface px-1 py-0.5"
                >
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center justify-between gap-2">
              <span className="text-muted">Color</span>
              <input
                type="color"
                value={indicator.settings.color ?? "#2962ff"}
                onChange={(e) => onUpdate({ color: e.target.value })}
                className="h-6 w-10 rounded border border-line bg-transparent"
              />
            </label>
            {indicator.settings.color2 !== undefined && (
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted">Color 2</span>
                <input
                  type="color"
                  value={indicator.settings.color2}
                  onChange={(e) => onUpdate({ color2: e.target.value })}
                  className="h-6 w-10 rounded border border-line bg-transparent"
                />
              </label>
            )}
            <label className="flex items-center justify-between gap-2">
              <span className="text-muted">Line width</span>
              <input
                type="number"
                min={1}
                max={6}
                value={indicator.settings.lineWidth ?? 1.5}
                onChange={(e) => onUpdate({ lineWidth: Number(e.target.value) })}
                className="w-16 rounded border border-line bg-transparent px-1 py-0.5 text-right tabular"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
