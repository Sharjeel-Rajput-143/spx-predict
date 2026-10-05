"use client";

import { IconChevronRight } from "@/components/icons";
import { Drawer } from "../bot/primitives";
import { STEP_CATALOG, type StepKind } from "./model";

/** "Add Step": every kind of step, grouped Actions then Loops. */
export function AddStepDrawer({ onPick, onPaste, pasteLabel, onClose }: { onPick: (kind: StepKind) => void; onPaste?: () => void; pasteLabel?: string; onClose: () => void }) {
  return (
    <Drawer title="Add step" onClose={onClose} wide>
      <div className="space-y-6">
        {onPaste && (
          <button onClick={onPaste} className="flex w-full items-center justify-between rounded-xl border border-dashed border-accent/50 bg-accent/5 px-4 py-3 text-left text-sm hover:bg-accent/10">
            <span>
              <span className="block font-semibold text-accent">Paste copied action</span>
              <span className="block text-xs text-muted">{pasteLabel}</span>
            </span>
            <IconChevronRight width={16} height={16} className="text-accent" />
          </button>
        )}
        {(["Actions", "Loops"] as const).map((group) => (
          <section key={group}>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{group}</h3>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {STEP_CATALOG.filter((s) => s.group === group).map((s) => (
                <li key={s.kind}>
                  <button onClick={() => onPick(s.kind)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60">
                    <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-base font-bold ${s.tile}`}>{s.glyph}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{s.name}</span>
                      <span className="block text-xs text-muted">{s.description}</span>
                    </span>
                    <IconChevronRight width={16} height={16} className="shrink-0 text-faint" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Drawer>
  );
}
