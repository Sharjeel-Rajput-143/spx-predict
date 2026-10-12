"use client";

import { useState } from "react";
import { Btn, Drawer, Field, inputClass } from "../bot/primitives";
import { stepInfo, type Step } from "./model";

/** Edits a step's settings (conditions use the picker instead). */
export function NodeEditor({ step, readOnly, onSave, onClose }: { step: Step; readOnly?: boolean; onSave: (config: Record<string, string>) => void; onClose: () => void }) {
  const [c, setC] = useState<Record<string, string>>(step.config);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setC((p) => ({ ...p, [k]: e.target.value }));
  const info = stepInfo(step.kind);

  const body = (() => {
    switch (step.kind) {
      case "open_trade_idea":
        return (
          <Field label="Symbol">
            <input className={inputClass} value={c.symbol} onChange={set("symbol")} />
          </Field>
        );
      case "update_exit":
        return (
          <>
            <Field label="Profit target (% of premium)">
              <input className={inputClass} inputMode="decimal" value={c.profit} onChange={set("profit")} placeholder="e.g. 50" />
            </Field>
            <Field label="Stop loss (% of premium)">
              <input className={inputClass} inputMode="decimal" value={c.stop} onChange={set("stop")} placeholder="e.g. 200" />
            </Field>
          </>
        );
      case "notification":
        return (
          <>
            <Field label="Message">
              <textarea className={inputClass} rows={3} value={c.message} onChange={set("message")} placeholder="What should it say?" />
            </Field>
            <Field label="Send to">
              <select className={inputClass} value={c.channel} onChange={set("channel")}>
                <option>In-app</option>
                <option>Email</option>
              </select>
            </Field>
          </>
        );
      case "tags":
        return (
          <>
            <Field label="Action">
              <select className={inputClass} value={c.action} onChange={set("action")}>
                <option>Add tag</option>
                <option>Remove tag</option>
              </select>
            </Field>
            <Field label="Tag">
              <input className={inputClass} value={c.tag} onChange={set("tag")} placeholder="e.g. opening-bias" />
            </Field>
          </>
        );
      case "loop_positions":
        return (
          <Field label="Repeat for each of">
            <select className={inputClass} value={c.over} onChange={set("over")}>
              <option>Open positions</option>
              <option>Positions opened today</option>
              <option>Closed positions</option>
            </select>
          </Field>
        );
      case "loop_symbols":
        return (
          <Field label="Symbols" hint="Separated by spaces.">
            <input className={inputClass} value={c.symbols} onChange={set("symbols")} placeholder="SPX SPY QQQ" />
          </Field>
        );
      default:
        return <p className="text-sm text-muted">This step has nothing to configure - put steps inside it on the canvas.</p>;
    }
  })();

  return (
    <Drawer
      title={info.name}
      onClose={onClose}
      footer={
        readOnly ? (
          <Btn kind="secondary" className="w-full"  onClick={onClose}>
            Close
          </Btn>
        ) : (
          <Btn kind="primary" className="w-full"  onClick={() => onSave(c)}>
            Save
          </Btn>
        )
      }
    >
      <fieldset disabled={readOnly} className="min-w-0 space-y-4 border-0 p-0">
        <p className="text-sm text-muted">{info.description}</p>
        {body}
      </fieldset>
    </Drawer>
  );
}
