"use client";

import { useState } from "react";
import { IconPlus } from "@/components/icons";
import { Btn, Drawer } from "../bot/primitives";
import { ConditionPicker } from "./ConditionPicker";
import { describeCondition, type Condition } from "./model";

/** "Decision": the conditions that must all hold to follow the Yes path. */
export function DecisionDrawer({
  title,
  heading,
  initial,
  readOnly,
  onSave,
  onClose,
}: {
  title: string;
  heading: string;
  initial: Condition[];
  readOnly?: boolean;
  onSave: (conditions: Condition[]) => void;
  onClose: () => void;
}) {
  const [conditions, setConditions] = useState<Condition[]>(initial);
  /** index being edited, "new" while adding, null when the picker is closed. */
  const [picking, setPicking] = useState<number | "new" | null>(null);

  return (
    <Drawer
      title={title}
      onClose={onClose}
      footer={
        readOnly ? (
          <Btn kind="secondary" className="w-full"  onClick={onClose}>
            Close
          </Btn>
        ) : (
          <Btn kind="primary" className="w-full"  onClick={() => onSave(conditions)} disabled={conditions.length === 0}>
            Save
          </Btn>
        )
      }
    >
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">{heading}</h3>
        {conditions.length === 0 && <p className="text-sm text-muted">No condition yet - add one with the + below.</p>}
        <ul className="space-y-2">
          {conditions.map((c, i) => (
            <li key={i}>
              {i > 0 && <div className="mb-2 text-[10px] font-bold tracking-wider text-faint">AND</div>}
              <div className="flex items-center gap-1 rounded-lg border border-line bg-surface-2/60">
                <button onClick={() => !readOnly && setPicking(i)} disabled={readOnly} className="min-w-0 flex-1 px-3 py-2.5 text-left text-sm font-medium hover:text-accent disabled:cursor-default disabled:hover:text-fg">
                  {describeCondition(c)}
                </button>
                {!readOnly && (
                  <button onClick={() => setConditions(conditions.filter((_, j) => j !== i))} aria-label="Remove condition" className="px-3 text-faint hover:text-down">
                    ×
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {!readOnly && (
          <button onClick={() => setPicking("new")} aria-label="Add condition" className="grid h-9 w-9 place-items-center rounded-lg border border-dashed border-line text-muted hover:border-accent hover:text-accent">
            <IconPlus width={16} height={16} />
          </button>
        )}
      </div>

      {picking !== null && (
        <ConditionPicker
          initial={picking === "new" ? undefined : conditions[picking]}
          onPick={(c) => {
            setConditions(picking === "new" ? [...conditions, c] : conditions.map((x, j) => (j === picking ? c : x)));
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </Drawer>
  );
}
