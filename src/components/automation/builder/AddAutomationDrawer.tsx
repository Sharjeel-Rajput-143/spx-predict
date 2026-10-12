"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconAutomation, IconChevronDown, IconFolder, IconSearch } from "@/components/icons";
import { cn } from "@/lib/format";
import { Btn, Drawer, EscapeLayer, Field, inputClass, Pill } from "../bot/primitives";
import type { AutomationDraft } from "./model";
import { SCHEDULES, attach, loadAttached, loadLibrary, type Attachment } from "./store";

/** "+ Add Automation": pick an automation (this bot's, or from your library, or
 * start a new one) and the schedule it should follow. */
export function AddAutomationDrawer({
  botId,
  builtIns,
  preselectId,
  onNew,
  onAttached,
  onClose,
}: {
  botId: string;
  /** The bot's own, always-on automations - listed under "This Bot" but not selectable. */
  builtIns: string[];
  preselectId?: string;
  onNew: () => void;
  onAttached: (a: Attachment[]) => void;
  onClose: () => void;
}) {
  const [library, setLibrary] = useState<AutomationDraft[]>([]);
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(preselectId ?? null);
  const [schedule, setSchedule] = useState("");
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLibrary(loadLibrary());
    setAttached(loadAttached(botId));
  }, [botId]);

  const selected = library.find((d) => d.id === selectedId);
  const attachedIds = new Set(attached.map((a) => a.draftId));
  const q = query.trim().toLowerCase();
  const match = (d: AutomationDraft) => !q || d.name.toLowerCase().includes(q);

  const thisBot = useMemo(() => library.filter((d) => attachedIds.has(d.id) && match(d)), [library, attached, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const byFolder = useMemo(() => {
    const map = new Map<string, AutomationDraft[]>();
    for (const d of library.filter((d) => !attachedIds.has(d.id) && match(d))) map.set(d.folder, [...(map.get(d.folder) ?? []), d]);
    return [...map.entries()];
  }, [library, attached, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (d: AutomationDraft) => {
    setSelectedId(d.id);
    setQuery("");
    setListOpen(false);
  };

  const save = () => {
    if (!selected || !schedule) return;
    onAttached(attach(botId, { draftId: selected.id, schedule, enabled: true }));
    onClose();
  };

  const row = (d: AutomationDraft) => (
    <li key={d.id}>
      <button onClick={() => pick(d)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2", d.id === selectedId && "text-accent")}>
        <IconAutomation width={15} height={15} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate">{d.name}</span>
        <span className="text-[11px] text-faint">{d.steps.length} step{d.steps.length === 1 ? "" : "s"}</span>
      </button>
    </li>
  );

  return (
    <Drawer
      title="Add automation"
      onClose={onClose}
      footer={
        <Btn kind="primary" className="w-full"  onClick={save} disabled={!selected || !schedule}>
          Save
        </Btn>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center gap-2">
          <Pill tone="warn">Preview</Pill>
          <span className="text-xs text-muted">Attached automations are saved in this browser and don&apos;t run yet.</span>
        </div>

        <Field label="Automation">
          <div className="flex items-start gap-2">
            <div className="relative flex-1" ref={boxRef}>
              <div className="relative">
                <IconSearch width={15} height={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                <input
                  role="combobox"
                  aria-expanded={listOpen}
                  aria-label="Automation"
                  value={listOpen ? query : (selected?.name ?? "")}
                  onChange={(e) => setQuery(e.target.value)}
                  onFocus={() => setListOpen(true)}
                  placeholder="Search automations..."
                  className={cn(inputClass, "pl-9 pr-8")}
                />
                <IconChevronDown width={15} height={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint" />
              </div>
              {listOpen && (
                <>
                  <EscapeLayer onEscape={() => setListOpen(false)} />
                  <button aria-label="Close list" className="fixed inset-0 z-10 cursor-default" onClick={() => setListOpen(false)} />
                  <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-xl">
                    <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">This bot</div>
                    <ul>
                      {builtIns.map((name) => (
                        <li key={name} className="flex items-center gap-2.5 px-3 py-2 text-sm text-faint">
                          <IconAutomation width={15} height={15} className="shrink-0" />
                          <span className="flex-1">{name}</span>
                          <span className="text-[11px]">built-in</span>
                        </li>
                      ))}
                      {thisBot.map(row)}
                    </ul>
                    <div className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted">My library</div>
                    {byFolder.length === 0 ? (
                      <p className="px-3 py-2 text-sm text-faint">{library.length === 0 ? "Nothing saved yet - use New." : "No other automations match."}</p>
                    ) : (
                      byFolder.map(([folder, drafts]) => (
                        <div key={folder}>
                          <div className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-muted"><IconFolder width={13} height={13} /> {folder}</div>
                          <ul className="pl-3">{drafts.map(row)}</ul>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
            <Btn kind="secondary" className="shrink-0"  onClick={onNew}>
              New
            </Btn>
          </div>
        </Field>

        <Field label="Schedule" hint="When it runs. Attached automations with a schedule appear under Monitors.">
          <select className={inputClass} value={schedule} onChange={(e) => setSchedule(e.target.value)} aria-label="Schedule">
            <option value="" disabled>
              Select a schedule
            </option>
            {SCHEDULES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Drawer>
  );
}
