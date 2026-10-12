"use client";

import { cn } from "@/lib/format";
import { Dropdown } from "../bot/primitives";

export interface Option {
  value: string;
  label: string;
}

/** A filter chip with a list of checkboxes: nothing ticked means "no filter"; the chip says how many are ticked. */
export function MultiSelect({ label, options, selected, onChange }: { label: string; options: Option[]; selected: string[]; onChange: (next: string[]) => void }) {
  const on = selected.length > 0;
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <Dropdown
      width="min-w-56"
      trigger={({ open, toggle: t }) => (
        <button
          onClick={t}
          aria-expanded={open}
          aria-label={`${label} filter`}
          className={cn("flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm transition-colors", on ? "border-accent bg-accent/10 text-accent" : "border-line bg-surface text-muted hover:text-fg")}
        >
          {label}
          {on && <span className="text-xs font-medium">{selected.length === 1 ? options.find((o) => o.value === selected[0])?.label ?? "1" : `${selected.length} selected`}</span>}
          <span aria-hidden className="text-[10px]">▾</span>
        </button>
      )}
    >
      {() =>
        options.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted">Nothing to filter by yet.</div>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {options.map((o) => (
              <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">
                <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} className="accent-[var(--accent)]" />
                <span className="truncate">{o.label}</span>
              </label>
            ))}
            {on && (
              <button onClick={() => onChange([])} className="mt-1 w-full rounded-lg px-3 py-1.5 text-left text-xs text-muted hover:bg-surface-2 hover:text-fg">
                Clear
              </button>
            )}
          </div>
        )
      }
    </Dropdown>
  );
}
