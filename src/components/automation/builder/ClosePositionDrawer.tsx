"use client";

import { useState } from "react";
import { IconLink } from "@/components/icons";
import { Checkbox, Drawer, Field, InfoTip, buttonClass, inputClass } from "../bot/primitives";
import { POSITION_TYPES, type Step } from "./model";

const PRICES = ["100% of bid/ask", "98% of bid/ask", "95% of bid/ask", "Mid price", "Bid price"];
const QUANTITIES = ["100% of position", "75% of position", "50% of position", "25% of position"];
const withCurrent = (options: string[], current: string) => (current && !options.includes(current) ? [current, ...options] : options);

/** "Close Position": a short, flat form. */
export function ClosePositionDrawer({ step, readOnly, onSave, onClose }: { step: Step; readOnly?: boolean; onSave: (config: Record<string, string>) => void; onClose: () => void }) {
  const [c, setC] = useState<Record<string, string>>(step.config);
  const set = (k: string, v: string) => setC((p) => ({ ...p, [k]: v }));
  const symbol = c.symbol || "SPX";
  const chip = c.type === "any" ? `Position (${symbol}, any spread)` : `Position (${symbol}, ${POSITION_TYPES[c.type] ?? "position"})`;

  return (
    <Drawer
      title="Close position"
      onClose={onClose}
      footer={
        readOnly ? (
          <button className={`${buttonClass.secondary} w-full`} onClick={onClose}>
            Close
          </button>
        ) : (
          <button className={`${buttonClass.primary} w-full`} onClick={() => onSave(c)}>
            Save
          </button>
        )
      }
    >
      <fieldset disabled={readOnly} className="min-w-0 space-y-5 border-0 p-0">
        <Field label="Position">
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2.5 text-sm font-medium">
              <span className="min-w-0 flex-1 truncate">{chip}</span>
              <IconLink width={14} height={14} className="shrink-0 text-faint" />
            </div>
            <select className={inputClass} value={c.type} onChange={(e) => set("type", e.target.value)} aria-label="Position to close">
              {Object.entries(POSITION_TYPES).map(([k, n]) => (
                <option key={k} value={k}>
                  {n}
                </option>
              ))}
              <option value="any">Any spread</option>
            </select>
          </div>
        </Field>
        <Field label="Price">
          <select className={inputClass} value={c.price} onChange={(e) => set("price", e.target.value)} aria-label="Price">
            {withCurrent(PRICES, c.price).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field label="Quantity">
          <select className={inputClass} value={c.qty} onChange={(e) => set("qty", e.target.value)} aria-label="Quantity">
            {withCurrent(QUANTITIES, c.qty).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field label="Memo" hint="Added immediately after the trade is filled">
          <textarea className={inputClass} rows={3} value={c.memo} onChange={(e) => set("memo", e.target.value)} aria-label="Memo" />
        </Field>
        <Field label="Tags">
          <input className={inputClass} value={c.tags} onChange={(e) => set("tags", e.target.value)} aria-label="Tags" />
        </Field>
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">Options</div>
          <div className="flex items-center">
            <Checkbox checked={c.discard === "1"} onChange={(v) => set("discard", v ? "1" : "")} label="Discard expiring OTM long leg(s) with no bid price" />
            <InfoTip text="A long leg that expires out of the money with no bid can't be sold - let it expire instead of trying to close it." />
          </div>
        </div>
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">Preview design. The signal engine closes the opposite side with its own limit order and waits for the fill.</p>
      </fieldset>
    </Drawer>
  );
}
