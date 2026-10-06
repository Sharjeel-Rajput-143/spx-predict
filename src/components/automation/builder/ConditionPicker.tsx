"use client";

import { useState } from "react";
import { IconChevronDown, IconSearch } from "@/components/icons";
import { cn } from "@/lib/format";
import { Drawer, buttonClass } from "../bot/primitives";
import {
  CONDITION_CATALOG,
  CONDITION_CATEGORIES,
  VISIBLE_CONDITIONS,
  conditionMatches,
  isConditionComplete,
  newCondition,
  type Condition,
  type ConditionTemplate,
} from "./model";

/** A condition shown as a sentence whose blanks are inline controls. */
export function ConditionSentence({
  template,
  values,
  onChange,
}: {
  template: ConditionTemplate;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-0.5 gap-y-1 text-sm leading-7">
      {template.tokens.map((tok, i) => {
        if (tok.t === "text") return <span key={i}>{tok.v}</span>;
        if (tok.t === "select")
          return (
            <select
              key={i}
              value={values[tok.k] ?? tok.options[0]}
              onChange={(e) => onChange(tok.k, e.target.value)}
              aria-label={tok.k}
              className="cursor-pointer rounded border-b border-dashed border-accent bg-accent/5 px-1.5 py-0.5 text-sm font-medium text-accent outline-none focus:bg-accent/10"
            >
              {tok.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          );
        return (
          <input
            key={i}
            value={values[tok.k] ?? ""}
            onChange={(e) => onChange(tok.k, e.target.value)}
            placeholder={tok.placeholder}
            aria-label={tok.k}
            size={Math.max(6, (values[tok.k] ?? "").length + 1)}
            className="rounded border-b border-dashed border-accent bg-accent/5 px-1.5 py-0.5 text-sm font-medium text-accent outline-none placeholder:font-normal placeholder:text-faint focus:bg-accent/10"
          />
        );
      })}
    </span>
  );
}

/** "Select" panel: search, collapsible categories, mad-libs conditions. */
export function ConditionPicker({
  initial,
  onPick,
  onClose,
}: {
  initial?: Condition;
  onPick: (c: Condition) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  // Values being edited per template, so switching between rows loses nothing.
  const [drafts, setDrafts] = useState<Record<string, Condition>>(() => (initial ? { [initial.templateId]: initial } : {}));
  const [open, setOpen] = useState<Record<string, boolean>>({ Bot: true, ...(initial ? { [CONDITION_CATALOG.find((t) => t.id === initial.templateId)!.category]: true } : {}) });
  const searching = query.trim() !== "";

  const draftFor = (id: string): Condition => drafts[id] ?? newCondition(id);
  const setValue = (id: string, key: string, value: string) =>
    setDrafts((d) => {
      const base = d[id] ?? newCondition(id);
      return { ...d, [id]: { ...base, values: { ...base.values, [key]: value } } };
    });

  return (
    <Drawer title="Select" onClose={onClose} wide>
      <div className="space-y-4">
        <div className="relative">
          <IconSearch width={16} height={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conditions..."
            aria-label="Search conditions"
            className="w-full rounded-lg border border-line bg-bg py-2 pl-9 pr-3 text-sm outline-none focus:border-accent"
            autoFocus
          />
        </div>

        {CONDITION_CATEGORIES.map((cat) => {
          const items = CONDITION_CATALOG.filter((t) => t.category === cat && conditionMatches(t, query));
          if (items.length === 0) return null;
          const expanded = searching || !!open[cat];
          return (
            <section key={cat} className="rounded-xl border border-line">
              <button
                onClick={() => setOpen((o) => ({ ...o, [cat]: !o[cat] }))}
                aria-expanded={expanded}
                className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold"
              >
                <span>
                  {cat} <span className="ml-1 text-xs font-normal text-faint">{items.length}</span>
                </span>
                <IconChevronDown width={16} height={16} className={cn("text-faint transition-transform", !expanded && "-rotate-90")} />
              </button>
              {expanded && (
                <ul className="divide-y divide-line border-t border-line">
                  {items.map((t) => {
                    const draft = draftFor(t.id);
                    return (
                      <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <ConditionSentence template={t} values={draft.values} onChange={(k, v) => setValue(t.id, k, v)} />
                        <button
                          className={cn(buttonClass.secondary, "shrink-0 !px-3 !py-1.5")}
                          onClick={() => onPick(draft)}
                          disabled={!isConditionComplete(draft)}
                          title={isConditionComplete(draft) ? undefined : "Fill in the blanks first"}
                        >
                          Use
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
        {searching && VISIBLE_CONDITIONS.every((t) => !conditionMatches(t, query)) && <p className="text-sm text-muted">No condition matches &ldquo;{query}&rdquo;.</p>}
      </div>
    </Drawer>
  );
}
