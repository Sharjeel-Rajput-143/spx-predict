"use client";

import { useMemo, useState } from "react";
import { INDICATOR_DEFS, type IndicatorKind } from "@/lib/indicators/registry";
import { cn } from "@/lib/format";
import { IconSearch, IconX } from "../icons";

const ALL_KINDS = Object.keys(INDICATOR_DEFS) as IndicatorKind[];

export function IndicatorsModal({
  hasVolume,
  onAdd,
  onClose,
}: {
  hasVolume: boolean;
  onAdd: (kind: IndicatorKind) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ALL_KINDS.filter((k) => {
      const def = INDICATOR_DEFS[k];
      if (def.requiresVolume && !hasVolume) return false;
      return !q || def.label.toLowerCase().includes(q) || k.includes(q);
    });
  }, [query, hasVolume]);

  const overlays = results.filter((k) => INDICATOR_DEFS[k].category === "overlay");
  const oscillators = results.filter((k) => INDICATOR_DEFS[k].category === "oscillator");

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-line bg-surface sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line p-3">
          <IconSearch width={16} height={16} className="shrink-0 text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search indicators..."
            className="w-full bg-transparent text-sm outline-none placeholder:text-faint"
          />
          <button onClick={onClose} aria-label="Close" className="shrink-0 text-muted hover:text-fg">
            <IconX width={16} height={16} />
          </button>
        </div>

        <div className="overflow-y-auto p-2">
          {overlays.length > 0 && (
            <IndicatorGroup title="Overlays" kinds={overlays} onAdd={onAdd} onClose={onClose} />
          )}
          {oscillators.length > 0 && (
            <IndicatorGroup title="Oscillators" kinds={oscillators} onAdd={onAdd} onClose={onClose} />
          )}
          {results.length === 0 && <p className="py-8 text-center text-sm text-faint">No matches</p>}
          {!hasVolume && (
            <p className="px-3 py-2 text-xs text-faint">VWAP needs a symbol with volume (SPY, QQQ, ES1!).</p>
          )}
        </div>
      </div>
    </div>
  );
}

function IndicatorGroup({
  title,
  kinds,
  onAdd,
  onClose,
}: {
  title: string;
  kinds: IndicatorKind[];
  onAdd: (kind: IndicatorKind) => void;
  onClose: () => void;
}) {
  return (
    <div className="mb-1">
      <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</div>
      <ul>
        {kinds.map((k) => {
          const def = INDICATOR_DEFS[k];
          return (
            <li key={k}>
              <button
                onClick={() => {
                  onAdd(k);
                  onClose();
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2",
                )}
              >
                <span>{def.label}</span>
                <span className="text-xs text-faint">
                  {def.params.map((p) => def.defaultSettings[p.key]).join(", ")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
