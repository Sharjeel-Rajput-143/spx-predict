"use client";

import { Field, inputClass } from "@/components/automation/bot/primitives";
import type { BotTemplate } from "@/lib/automation/types";

/** Every trading input is required. The offsets and expected credit have no
 * default on purpose - a guessed number there is how a 7715/7715 order happens. */
export interface BotFormValues {
  name: string;
  accountId: string;
  quantity: string;
  widthPoints: string;
  strikeIncrement: string;
  putShortOffset: string;
  callShortOffset: string;
  allocationLimit: string;
  openingCreditEstimate: string;
  group: string;
  tags: string;
}

export const BLANK_FORM: BotFormValues = {
  name: "",
  accountId: "paper-1",
  quantity: "3",
  widthPoints: "5",
  strikeIncrement: "5",
  putShortOffset: "",
  callShortOffset: "",
  allocationLimit: "20000",
  openingCreditEstimate: "",
  group: "",
  tags: "",
};

export function formFromTemplate(t: BotTemplate): BotFormValues {
  const c = t.config;
  return {
    name: "",
    accountId: c.accountId,
    quantity: String(c.quantity),
    widthPoints: String(c.widthPoints),
    strikeIncrement: String(c.strikeIncrement),
    putShortOffset: String(c.putShortOffset),
    callShortOffset: String(c.callShortOffset),
    allocationLimit: String(t.safeguards?.allocationLimit ?? c.allocationLimit),
    openingCreditEstimate: String(c.openingCreditEstimate),
    group: "",
    tags: "",
  };
}

/** Parses a numeric field; empty stays undefined so the server reports it as missing. */
const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

export function toInputs(f: BotFormValues) {
  return {
    name: f.name,
    accountId: f.accountId,
    underlying: "SPX" as const,
    quantity: num(f.quantity),
    widthPoints: num(f.widthPoints),
    strikeIncrement: num(f.strikeIncrement),
    putShortOffset: num(f.putShortOffset),
    callShortOffset: num(f.callShortOffset),
    allocationLimit: num(f.allocationLimit),
    openingCreditEstimate: num(f.openingCreditEstimate),
  };
}

/** The strike/size inputs, shared by "New bot" and the Bot Inputs editor. */
export function InputFields({ f, set, columns = 3 }: { f: BotFormValues; set: (key: keyof BotFormValues) => (e: React.ChangeEvent<HTMLInputElement>) => void; columns?: 2 | 3 }) {
  return (
    <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Spread &amp; strikes</h3>
          <div className={columns === 2 ? "grid gap-3 sm:grid-cols-2" : "grid gap-3 sm:grid-cols-3"}>
            <Field label="Quantity">
              <input className={inputClass} inputMode="numeric" value={f.quantity} onChange={set("quantity")} />
            </Field>
            <Field label="Width (points)">
              <input className={inputClass} inputMode="decimal" value={f.widthPoints} onChange={set("widthPoints")} />
            </Field>
            <Field label="Strike increment">
              <input className={inputClass} inputMode="decimal" value={f.strikeIncrement} onChange={set("strikeIncrement")} />
            </Field>
            <Field label="Short put offset" hint="Required. Signed points from the signal price.">
              <input className={inputClass} inputMode="decimal" value={f.putShortOffset} onChange={set("putShortOffset")} placeholder="required" />
            </Field>
            <Field label="Short call offset" hint="Required. Signed points from the signal price.">
              <input className={inputClass} inputMode="decimal" value={f.callShortOffset} onChange={set("callShortOffset")} placeholder="required" />
            </Field>
            <Field label="Expected credit" hint="Required. Per spread; used for the order limit and risk checks.">
              <input className={inputClass} inputMode="decimal" value={f.openingCreditEstimate} onChange={set("openingCreditEstimate")} placeholder="required" />
            </Field>
            <Field label="Allocation ($)">
              <input className={inputClass} inputMode="decimal" value={f.allocationLimit} onChange={set("allocationLimit")} />
            </Field>
          </div>
        </div>
  );
}
