"use client";

import { useState } from "react";
import { IconChevronDown, IconChevronRight, IconLink } from "@/components/icons";
import { cn } from "@/lib/format";
import { Btn, Drawer, Field, InfoTip, inputClass, TextPromptModal } from "../bot/primitives";
import { ENTRY_CRITERIA, POSITION_CRITERIA, critKey, critValueKey, enabledCriteria, type Criterion } from "./criteria";
import { POSITION_TYPES, val, type BotInput, type Step } from "./model";

const PRICES = ["100% of bid/ask", "98% of bid/ask", "95% of bid/ask", "Mid price", "Bid price"];
const EXITS = ["None", "Profit 50% / Stop 200%", "Profit 25% / Stop 100%", "Profit 80% only"];

/** Always keeps the current value selectable, even if it isn't one of the presets. */
const withCurrent = (options: string[], current: string) => (current && !options.includes(current) ? [current, ...options] : options);

/**
 * "Open <type>": a long form. Position Details are always open; Entry
 * Criteria and Position Criteria are collapsed checklists of optional filters.
 * Any numeric field can be turned into a shared "bot input". It's a design -
 * the engine builds its own strikes from the bot's offsets and width.
 */
export function OpenPositionDrawer({
  step,
  inputs,
  readOnly,
  onCreateInput,
  onUpdateInput,
  onSave,
  onClose,
}: {
  step: Step;
  inputs: BotInput[];
  readOnly?: boolean;
  onCreateInput: (name: string, value: string) => string;
  onUpdateInput: (id: string, value: string) => void;
  onSave: (config: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [config, setConfig] = useState<Record<string, string>>(step.config);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [accordion, setAccordion] = useState<{ entry: boolean; position: boolean }>({ entry: false, position: false });
  const [naming, setNaming] = useState<string | null>(null);

  const draftStep: Step = { ...step, config };
  const get = (k: string) => val(draftStep, k, inputs);
  const boundInput = (k: string) => inputs.find((i) => i.id === config[`in:${k}`]);
  const set = (k: string, v: string) => {
    const bound = boundInput(k);
    if (bound) onUpdateInput(bound.id, v);
    else setConfig((c) => ({ ...c, [k]: v }));
  };

  const type = get("type");
  const side = type === "short_call_spread" ? "call" : "put";
  const setType = (t: string) => setConfig((c) => ({ ...c, type: t, short_dir: t === "short_call_spread" ? "above" : "below", long_dir: t === "short_call_spread" ? "above" : "below" }));

  const row = (opts: { id: string; label: string; summary: string; bindKey?: string; detail: React.ReactNode }) => {
    const open = expanded === opts.id;
    const bound = opts.bindKey ? boundInput(opts.bindKey) : undefined;
    return (
      <li key={opts.id} className="border-b border-line last:border-b-0">
        <div className="flex items-center gap-2 px-4 py-3">
          <button onClick={() => setExpanded(open ? null : opts.id)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <span className="w-28 shrink-0 text-xs font-medium text-muted">{opts.label}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{opts.summary}</span>
            {open ? <IconChevronDown width={14} height={14} className="shrink-0 text-faint" /> : <IconChevronRight width={14} height={14} className="shrink-0 text-faint" />}
          </button>
          {opts.bindKey && (
            <button
              onClick={() => (bound ? setConfig((c) => { const { [`in:${opts.bindKey}`]: _gone, ...rest } = c; return rest; }) : setNaming(opts.bindKey!))}
              aria-label={bound ? `Unlink ${opts.label} from input` : `Convert ${opts.label} to a bot input`}
              title={bound ? `Linked to input “${bound.name}” - click to unlink` : "Convert to a bot input"}
              className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", bound ? "bg-accent/15 text-accent" : "text-faint hover:bg-surface-2 hover:text-fg")}
            >
              <IconLink width={14} height={14} />
            </button>
          )}
        </div>
        {open && (
          <div className="space-y-2 bg-surface-2/40 px-4 pb-3 pt-1">
            {bound && <p className="text-[11px] text-accent">Linked to input “{bound.name}” - editing it changes every step that uses it.</p>}
            {opts.detail}
          </div>
        )}
      </li>
    );
  };

  const num = (k: string, ph: string, prefix?: string) => (
    <div className="flex items-center gap-1.5">
      {prefix && <span className="text-sm text-muted">{prefix}</span>}
      <input className={cn(inputClass, "max-w-32")} inputMode="decimal" value={get(k)} onChange={(e) => set(k, e.target.value)} placeholder={ph} aria-label={k} />
    </div>
  );

  const dirSelect = (k: string) => (
    <select className={cn(inputClass, "max-w-28")} value={get(k)} onChange={(e) => set(k, e.target.value)} aria-label={k}>
      <option>above</option>
      <option>below</option>
    </select>
  );

  const critList = (list: Criterion[]) => (
    <ul className="divide-y divide-line">
      {list.map((c) => {
        const on = config[critKey(c.id)] === "1";
        return (
          <li key={c.id} className="flex flex-wrap items-center gap-x-1 gap-y-1 px-4 py-2.5 text-sm">
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => setConfig((cfg) => ({ ...cfg, [critKey(c.id)]: e.target.checked ? "1" : "0" }))}
              aria-label={c.pieces.map((p) => (p.t === "text" ? p.v : "…")).join("")}
              className="mr-2 h-4 w-4 accent-[var(--accent)]"
            />
            {c.pieces.map((p, i) =>
              p.t === "text" ? (
                <span key={i} className={on ? "" : "text-muted"}>
                  {p.v}
                </span>
              ) : (
                <input
                  key={i}
                  value={config[critValueKey(c.id, p.k)] ?? ""}
                  onChange={(e) => setConfig((cfg) => ({ ...cfg, [critValueKey(c.id, p.k)]: e.target.value }))}
                  placeholder={p.ph}
                  disabled={!on}
                  aria-label={`${c.id} ${p.k}`}
                  className="w-16 rounded border border-line bg-bg px-1.5 py-0.5 text-sm outline-none focus:border-accent disabled:opacity-40"
                />
              ),
            )}
            {c.tip && <InfoTip text={c.tip} />}
          </li>
        );
      })}
    </ul>
  );

  const accordionSection = (key: "entry" | "position", title: string, list: Criterion[]) => (
    <section className="rounded-xl border border-line">
      <button onClick={() => setAccordion((a) => ({ ...a, [key]: !a[key] }))} aria-expanded={accordion[key]} className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold">
        <span>
          {title} <span className="ml-1 text-xs font-normal text-faint">{enabledCriteria(config, list).length} on</span>
        </span>
        <IconChevronDown width={16} height={16} className={cn("text-faint transition-transform", !accordion[key] && "-rotate-90")} />
      </button>
      {accordion[key] && <div className="border-t border-line">{critList(list)}</div>}
    </section>
  );

  const shortSummary = `$${get("short_off") || "0"} ${get("short_dir")} underlying price`;
  const longSummary = `$${get("long_off") || "0"} ${get("long_dir")} short ${side} leg`;

  return (
    <Drawer
      title={`Open ${POSITION_TYPES[type] ?? "position"}`}
      onClose={onClose}
      wide
      footer={
        readOnly ? (
          <Btn kind="secondary" className="w-full"  onClick={onClose}>
            Close
          </Btn>
        ) : (
          <Btn kind="primary" className="w-full"  onClick={() => onSave(config)}>
            Save
          </Btn>
        )
      }
    >
      <fieldset disabled={readOnly} className="min-w-0 space-y-5 border-0 p-0">
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Position details</h3>
          <ul className="rounded-xl border border-line">
            <li className="border-b border-line px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-xs font-medium text-muted">Position type</span>
                <select className={cn(inputClass, "flex-1")} value={type} onChange={(e) => setType(e.target.value)} aria-label="Position type">
                  {Object.entries(POSITION_TYPES).map(([k, name]) => (
                    <option key={k} value={k}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            </li>
            {row({ id: "symbol", label: "Symbol", summary: get("symbol") || "—", bindKey: "symbol", detail: <input className={cn(inputClass, "max-w-40")} value={get("symbol")} onChange={(e) => set("symbol", e.target.value)} aria-label="Symbol" /> })}
            {row({
              id: "exp",
              label: "Expiration",
              summary: `${get("exp_op")} ${get("exp_days")} days`,
              bindKey: "exp_days",
              detail: (
                <div className="flex items-center gap-2">
                  <select className={cn(inputClass, "max-w-32")} value={get("exp_op")} onChange={(e) => set("exp_op", e.target.value)} aria-label="Expiration rule">
                    <option>exactly</option>
                    <option>at least</option>
                    <option>at most</option>
                  </select>
                  {num("exp_days", "0")}
                  <span className="text-sm text-muted">days</span>
                </div>
              ),
            })}
            {row({
              id: "short",
              label: `Short ${side}`,
              summary: shortSummary,
              bindKey: "short_off",
              detail: (
                <div className="flex flex-wrap items-center gap-2">
                  {num("short_off", "0.00", "$")}
                  {dirSelect("short_dir")}
                  <span className="text-sm text-muted">underlying price</span>
                </div>
              ),
            })}
            {row({
              id: "long",
              label: `Long ${side}`,
              summary: longSummary,
              bindKey: "long_off",
              detail: (
                <div className="flex flex-wrap items-center gap-2">
                  {num("long_off", "0.00", "$")}
                  {dirSelect("long_dir")}
                  <span className="text-sm text-muted">short {side} leg</span>
                </div>
              ),
            })}
            {row({ id: "size", label: "Position size", summary: `${get("size") || "?"} contracts`, bindKey: "size", detail: <div className="flex items-center gap-2">{num("size", "1")}<span className="text-sm text-muted">contracts</span></div> })}
            {row({
              id: "price",
              label: "Price",
              summary: get("price"),
              bindKey: "price",
              detail: (
                <select className={inputClass} value={get("price")} onChange={(e) => set("price", e.target.value)} aria-label="Price">
                  {withCurrent(PRICES, get("price")).map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              ),
            })}
            {row({
              id: "exit",
              label: "Exit options",
              summary: get("exit"),
              detail: (
                <select className={inputClass} value={get("exit")} onChange={(e) => set("exit", e.target.value)} aria-label="Exit options">
                  {withCurrent(EXITS, get("exit")).map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              ),
            })}
            <li className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-xs font-medium text-muted">Tags</span>
                <input className={cn(inputClass, "flex-1")} value={get("tags")} onChange={(e) => set("tags", e.target.value)} placeholder="e.g. opening-bias" aria-label="Tags" />
              </div>
            </li>
          </ul>
        </section>

        {accordionSection("entry", "Entry criteria", ENTRY_CRITERIA)}
        {accordionSection("position", "Position criteria", POSITION_CRITERIA)}

        <Field label="">
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            Preview design. The signal engine builds its own strikes from the bot&apos;s offsets and width, and applies its own safeguards - it doesn&apos;t read these settings yet.
          </p>
        </Field>
      </fieldset>

      {naming && (
        <TextPromptModal
          title="Convert to bot input"
          label="Input name"
          initial={naming === "exp_days" ? "Expiration days" : naming === "short_off" ? "Short offset" : naming === "long_off" ? "Spread width" : naming === "size" ? "Position size" : naming === "price" ? "Price" : "Symbol"}
          confirmLabel="Create input"
          onClose={() => setNaming(null)}
          onSubmit={(name) => {
            const id = onCreateInput(name, get(naming));
            setConfig((c) => ({ ...c, [`in:${naming}`]: id }));
            setNaming(null);
          }}
        />
      )}
    </Drawer>
  );
}
