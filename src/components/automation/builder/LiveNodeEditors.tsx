"use client";

import { useState, type ReactNode } from "react";
import { IconLink } from "@/components/icons";
import { Drawer, Dropdown, Field, InfoTip, Modal, buttonClass, inputClass } from "../bot/primitives";
import { TRADE_OPS, describeFinals, describeQuantity, validateCloseQuantity, validateClosePricing, type CloseSpeed, type ClosePricing, type TradeOp } from "@/lib/automation/closePricing";
import type { BotContext } from "../bot/BotDetail";
import type { BotInputs, MonitorKey, StrikeRounding } from "@/lib/automation/types";
import { CHECK_MAX_COUNT, CHECK_OPS, CHECK_STATUSES, CHECK_TYPES, defaultCheck, positionsWord, type CheckOp, type CheckSlot, type CheckStatus, type CheckType, type PositionCheck } from "@/lib/automation/positionChecks";
import { clock12 } from "./builtin";
import { NeedsInputs, SmartPricingModal, Shell, Row, inputsWith, num, priceLabel, type Direction } from "./editorParts";
import { OpenEditor } from "./OpenPositionEditor";

export { OpenEditor, inputsWith };
import type { Step } from "./model";

/**
 * The editors behind a built-in Bullish/Bearish flow. Unlike the preview
 * designs, these are LIVE: Save writes straight to the bot's real settings
 * (the same ones as Settings > Bot inputs) and applies to the next signal.
 * The flow's shape is the engine's logic, so it stays fixed - only the values
 * on its nodes can change, and only the ones the engine really reads.
 */

/** Every 5 minutes from 9:30am to 4:00pm, the way Option Alpha lists its times. */
const MARKS: string[] = [];
for (let m = 9 * 60 + 30; m <= 16 * 60; m += 5) MARKS.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
const withCurrent = (options: string[], current: string) => (options.includes(current) ? options : [...options, current].sort());

function useSave(ctx: BotContext, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const save = async (changes: Parameters<typeof inputsWith>[1]) => {
    if (!ctx.data.config) return;
    setBusy(true);
    const ok = await ctx.patch({ inputs: inputsWith(ctx.data.config, changes) }, "Saved to the bot's settings. It applies to the next signal.");
    setBusy(false);
    if (ok) onClose();
  };
  return { busy, save };
}

/** "Current market time is between X and Y". */
export function TimeWindowEditor({ ctx, onClose }: { ctx: BotContext; onClose: () => void }) {
  const cfg = ctx.data.config;
  const fallback = ctx.data.limits.hours;
  const [from, setFrom] = useState(cfg?.hours?.start ?? fallback.start);
  const [to, setTo] = useState(cfg?.hours?.end ?? fallback.end);
  const { busy, save } = useSave(ctx, onClose);
  if (!cfg) return <NeedsInputs ctx={ctx} onClose={onClose} />;
  const bad = from >= to;

  return (
    <Shell
      title="Market time window"
      ctx={ctx}
      onClose={onClose}
      footer={
        <div className="space-y-2">
          <button className={`${buttonClass.primary} w-full`} onClick={() => save({ hours: { start: from, end: to } })} disabled={busy || bad}>
            {busy ? "Saving..." : "Save"}
          </button>
          {cfg.hours && (
            <button className={`${buttonClass.secondary} w-full`} onClick={() => save({ hours: null })} disabled={busy}>
              Use the default window ({clock12(fallback.start)} - {clock12(fallback.end)})
            </button>
          )}
        </div>
      }
    >
      <Field label="Current market time is between">
        <div className="flex items-center gap-2">
          <select className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Start time">
            {withCurrent(MARKS, from).map((m) => (
              <option key={m} value={m}>
                {clock12(m)}
              </option>
            ))}
          </select>
          <span className="text-sm text-muted">and</span>
          <select className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} aria-label="End time">
            {withCurrent(MARKS, to).map((m) => (
              <option key={m} value={m}>
                {clock12(m)}
              </option>
            ))}
          </select>
        </div>
      </Field>
      {bad && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">The start has to be before the end.</p>}
    </Shell>
  );
}

/** "Close Position", laid out like Option Alpha's form. Price (SmartPricing and the final price) is the bot's own close setting;
 * Memo and Tags are written on the position this trigger closes. The position is the opposite side's spread and the quantity is all of it. */
export function CloseEditor({ direction, ctx, onClose }: { direction: Direction; ctx: BotContext; onClose: () => void }) {
  const cfg = ctx.data.config;
  const spread = direction === "bullish" ? "Short call spread" : "Short put spread";
  const saved = ctx.data.bot.closeSettings?.[direction];
  // Unless this trigger has its own pricing, the step uses the bot's SmartPricing setting and close price.
  const [pricing, setPricingValue] = useState<ClosePricing>(saved?.pricing ?? { speed: cfg?.smartPricing ?? "normal", percent: cfg?.closePricePercent ?? 100 });
  const [qMode, setQMode] = useState<"percent" | "contracts">(saved?.quantity?.mode ?? "percent");
  const [qPercent, setQPercent] = useState(saved?.quantity?.mode === "percent" ? String(saved.quantity.value) : "100");
  const [qContracts, setQContracts] = useState(saved?.quantity?.mode === "contracts" ? String(saved.quantity.value) : "");
  const [memo, setMemo] = useState(saved?.memo ?? "");
  const [tags, setTags] = useState((saved?.tags ?? []).join(", "));
  const [pricingOpen, setPricingOpen] = useState(false);
  const [lookup, setLookup] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!cfg) return <NeedsInputs ctx={ctx} onClose={onClose} />;

  const quantity = validateCloseQuantity(qMode === "percent" ? { mode: "percent", value: num(qPercent) } : { mode: "contracts", value: num(qContracts) });
  const allOfIt = quantity.ok && quantity.quantity.mode === "percent" && quantity.quantity.value === 100;
  const quantityLabel = quantity.ok ? describeQuantity(quantity.quantity) : "Check the quantity";

  const save = async () => {
    if (!quantity.ok) return;
    setBusy(true);
    const ok = await ctx.patch(
      { closeSettings: { [direction]: { memo, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), pricing, quantity: allOfIt ? null : quantity.quantity } } },
      "Saved to the bot's settings. It applies to the next signal.",
    );
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <>
      <Shell title="Close Position" ctx={ctx} onClose={onClose} footer={<button className={`${buttonClass.primary} w-full`} disabled={busy || !quantity.ok} onClick={save}>{busy ? "Saving..." : "Save"}</button>}>
        <div className="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-5 text-sm">
          <span>Position</span>
          <button onClick={() => setLookup(true)} className="inline-flex w-fit max-w-full items-center gap-2 rounded-lg border border-dashed border-accent/50 bg-accent/5 px-3 py-1.5 text-accent" title="Open the position lookup">
            <IconLink width={14} height={14} className="shrink-0" />
            <span className="truncate">{`Position (${cfg.underlying}, ${spread})`}</span>
          </button>
          <span>Price</span>
          <button onClick={() => setPricingOpen(true)} className={`${inputClass} flex items-center justify-between text-left`} aria-label="Price">
            <span>{priceLabel(pricing)}</span>
            <span className="text-faint">▾</span>
          </button>
          <span>Quantity</span>
          <div>
            <Dropdown
              width="w-72"
              trigger={({ toggle }) => (
                <button onClick={toggle} className={`${inputClass} flex items-center justify-between text-left`} aria-label="Quantity">
                  <span>{quantityLabel}</span>
                  <span className="text-faint">▾</span>
                </button>
              )}
            >
              {() => (
                <div className="space-y-3 p-3 text-sm">
                  <label className="flex items-center gap-3">
                    <input type="radio" name="quantity" checked={qMode === "percent"} onChange={() => setQMode("percent")} aria-label="Percent of position" className="h-4 w-4 accent-[var(--accent)]" />
                    <input className={`${inputClass} !w-20`} inputMode="decimal" value={qPercent} onFocus={() => setQMode("percent")} onChange={(e) => { setQMode("percent"); setQPercent(e.target.value); }} aria-label="Percent of position value" />
                    <span>% of position</span>
                  </label>
                  <label className="flex items-center gap-3">
                    <input type="radio" name="quantity" checked={qMode === "contracts"} onChange={() => setQMode("contracts")} aria-label="Contracts" className="h-4 w-4 accent-[var(--accent)]" />
                    <input className={`${inputClass} !w-20`} inputMode="numeric" placeholder="1" value={qContracts} onFocus={() => setQMode("contracts")} onChange={(e) => { setQMode("contracts"); setQContracts(e.target.value); }} aria-label="Contracts value" />
                    <span>contract</span>
                  </label>
                  <label className="flex items-center gap-3 text-faint" title="Index option spreads trade in contracts, not shares.">
                    <input type="radio" name="quantity" disabled aria-label="Shares" className="h-4 w-4" />
                    <input className={`${inputClass} !w-20`} placeholder="1" disabled aria-label="Shares value" />
                    <span>share</span>
                  </label>
                </div>
              )}
            </Dropdown>
            {!quantity.ok && <p className="mt-1 text-xs text-down">{quantity.reason}</p>}
          </div>
          <span>Memo</span>
          <textarea className={`${inputClass} min-h-24`} value={memo} onChange={(e) => setMemo(e.target.value)} aria-label="Memo" maxLength={500} />
          <span>Tags</span>
          <div>
            <input className={inputClass} value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
            <div className="mt-1 text-xs text-faint">Added immediately after the trade is filled. Separate with commas.</div>
          </div>
        </div>
        <div>
          <div className="mb-2 text-sm font-semibold">Options</div>
          <label className="flex items-center gap-2 text-sm text-faint" title="Not applicable: a spread is closed as one multi-leg order, and NDX options are cash settled.">
            <input type="checkbox" disabled /> Discard expiring OTM long leg(s) with no bid price
          </label>
        </div>
      </Shell>
      {pricingOpen && (
        <SmartPricingModal
          pricing={pricing}
          onApply={(p) => {
            setPricingValue(p);
            setPricingOpen(false);
          }}
          onClose={() => setPricingOpen(false)}
        />
      )}
      {lookup && (
        <Drawer title="Position Lookup" onClose={() => setLookup(false)} footer={<button className={`${buttonClass.secondary} w-full`} onClick={() => setLookup(false)}>Close</button>}>
          <div className="space-y-4 text-sm">
            <p className="text-muted">Finds the positions that match these filters:</p>
            <Row label="Symbol" value={cfg.underlying} />
            <Row label="Position Type" value={spread} />
          </div>
        </Drawer>
      )}
    </>
  );
}

/** A position check on the canvas: "Bot has <op> <count> with <type> type and <status> status". Saved on the bot, for this trigger,
 * and read by the engine at that step on the next signal. This bot only holds short put and short call spreads, so any other type
 * counts zero positions. `slot`: "close" is the check in front of Close Position (the opposite side), "open" the one in front of Open
 * (the wanted side: yes = already held, so nothing is opened). Unedited, the open check follows Settings > Safeguards > Per type. */
export function PositionCheckEditor({ slot, direction, type, ctx, onClose }: { slot: CheckSlot; direction: Direction; type: string; ctx: BotContext; onClose: () => void }) {
  const saved = ctx.data.bot.positionChecks?.[direction]?.[slot];
  const fallback = defaultCheck(slot === "open" ? ctx.data.limits.maxPositionsPerType : 1);
  const [check, setCheck] = useState<PositionCheck>(saved ?? fallback);
  const [busy, setBusy] = useState(false);
  const save = async (value: PositionCheck | null) => {
    setBusy(true);
    const ok = await ctx.patch({ positionChecks: { [direction]: { [slot]: value } } }, value ? "Saved to the bot's settings. It applies to the next signal." : "Back to the default check.");
    setBusy(false);
    if (ok) onClose();
  };
  const select = <T extends string | number>(value: T, onChange: (v: string) => void, options: readonly T[], label: string, text?: (v: T) => string) => (
    <select className={`${inputClass} !w-auto`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {options.map((o) => (
        <option key={o} value={o}>
          {text ? text(o) : o}
        </option>
      ))}
    </select>
  );
  return (
    <Shell
      title="Decision"
      ctx={ctx}
      onClose={onClose}
      footer={
        <div className="space-y-2">
          <button className={`${buttonClass.primary} w-full`} disabled={busy} onClick={() => save(check)}>
            {busy ? "Saving..." : "Save"}
          </button>
          {saved && (
            <button className={`${buttonClass.secondary} w-full`} disabled={busy} onClick={() => save(null)}>
              Back to the default{slot === "open" ? ` (${positionsWord(ctx.data.limits.maxPositionsPerType)}, the Per type safeguard)` : ""}
            </button>
          )}
        </div>
      }
    >
      <Field
        label="Follow the “Yes” path if…"
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Bot has</span>
          {select(check.op, (v) => setCheck({ ...check, op: v as CheckOp }), CHECK_OPS, "Operator")}
          {select(check.count, (v) => setCheck({ ...check, count: Number(v) }), Array.from({ length: CHECK_MAX_COUNT + 1 }, (_, n) => n), "Positions", (n) => positionsWord(n))}
          <span>with</span>
          {select(check.type ?? type, (v) => setCheck({ ...check, type: v as CheckType }), CHECK_TYPES, "Type")}
          <span>type and</span>
          {select(check.status, (v) => setCheck({ ...check, status: v as CheckStatus }), CHECK_STATUSES, "Status")}
          <span>status</span>
        </div>
      </Field>
    </Shell>
  );
}

/** The editor for a built-in flow's node, or null when the node has nothing to edit (it then opens read-only). */
export function liveNodeEditor({ step, direction, ctx, onClose }: { step: Step; direction: Direction; ctx: BotContext; onClose: () => void }): ReactNode | null {
  if (step.kind === "open_position") return <OpenEditor key={step.id} direction={direction} ctx={ctx} onClose={onClose} />;
  if (step.kind === "close_position") return <CloseEditor key={step.id} direction={direction} ctx={ctx} onClose={onClose} />;
  if (step.kind === "decision") {
    const t = step.conditions?.[0]?.templateId;
    if (t === "bot_time") return <TimeWindowEditor key={step.id} ctx={ctx} onClose={onClose} />;
    if (t === "bot_has_type") {
      const wantedType = direction === "bullish" ? "Short put spread" : "Short call spread";
      const type = step.conditions?.[0]?.values.type ?? wantedType;
      return <PositionCheckEditor key={step.id} slot={type === wantedType ? "open" : "close"} direction={direction} type={type} ctx={ctx} onClose={onClose} />;
    }
  }
  return null;
}

/** "Close Position" behind a Close Monitor, laid out like Option Alpha's form. The price and quantity are the engine's (the
 * bot's close price setting, 100% of the position); Memo and Tags are real: they are written on the position the monitor closes. */
export function MonitorCloseEditor({ monitor, ctx, onClose }: { monitor: MonitorKey; ctx: BotContext; onClose: () => void }) {
  const cfg = ctx.data.config;
  const saved = ctx.data.bot.monitors?.[monitor];
  const [memo, setMemo] = useState(saved?.memo ?? "");
  const [tags, setTags] = useState((saved?.tags ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const spread = monitor === "bullishClose" ? "Short Call Spread" : "Short Put Spread";

  const save = async () => {
    setBusy(true);
    const ok = await ctx.patch({ monitors: { [monitor]: { memo, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } } }, "Monitor saved.");
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Drawer title="Close Position" onClose={onClose} footer={<button className={`${buttonClass.primary} w-full`} disabled={busy} onClick={save}>{busy ? "Saving..." : "Save"}</button>}>
      <div className="space-y-5">
        <div className="grid grid-cols-[6rem_1fr] items-center gap-3 text-sm">
          <span>Position</span>
          <span className="inline-flex w-fit items-center gap-2 rounded-lg border border-dashed border-accent/50 bg-accent/5 px-3 py-1.5 text-accent">{`Position (${cfg?.underlying ?? "NDX"}, ${spread})`}</span>
          <span>Price</span>
          <span className="rounded-lg border border-line bg-surface-2/60 px-3 py-2.5">{cfg?.closePricePercent ?? 100}% of bid/ask</span>
          <span>Quantity</span>
          <span className="rounded-lg border border-line bg-surface-2/60 px-3 py-2.5">100% of position</span>
        </div>
        <Field label="Memo">
          <textarea className={`${inputClass} min-h-24`} value={memo} onChange={(e) => setMemo(e.target.value)} aria-label="Memo" maxLength={500} />
        </Field>
        <Field label="Tags" hint="Added immediately after the trade is filled. Separate with commas.">
          <input className={inputClass} value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
        </Field>
        <div>
          <div className="mb-2 text-sm font-semibold">Options</div>
          <label className="flex items-center gap-2 text-sm text-faint" title="Not applicable: a spread is closed as one multi-leg order, and NDX options are cash settled.">
            <input type="checkbox" disabled /> Discard expiring OTM long leg(s) with no bid price
          </label>
        </div>
      </div>
    </Drawer>
  );
}

/** The nodes of a Close Monitor's flow: the two checks are fixed (the default read-only Decision drawer is enough); Close Position has Memo and Tags. */
export function monitorNodeEditor({ step, monitor, ctx, onClose }: { step: Step; monitor: MonitorKey; ctx: BotContext; onClose: () => void }): ReactNode | null {
  if (step.kind === "close_position") return <MonitorCloseEditor key={step.id} monitor={monitor} ctx={ctx} onClose={onClose} />;
  return null;
}
