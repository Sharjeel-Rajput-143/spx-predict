"use client";

import { useState, type ReactNode } from "react";
import { IconLink } from "@/components/icons";
import { Drawer, Field, Modal, buttonClass, inputClass } from "../bot/primitives";
import type { SmartPricingMode } from "@/lib/automation/smartPricing";
import type { BotContext } from "../bot/BotDetail";
import type { BotInputs, MonitorKey, StrikeRounding } from "@/lib/automation/types";
import { CHECK_MAX_COUNT, CHECK_OPS, CHECK_STATUSES, CHECK_TYPES, defaultCheck, positionsWord, type CheckOp, type CheckSlot, type CheckStatus, type CheckType, type PositionCheck } from "@/lib/automation/positionChecks";
import { clock12 } from "./builtin";
import type { Step } from "./model";

/**
 * The editors behind a built-in Bullish/Bearish flow. Unlike the preview
 * designs, these are LIVE: Save writes straight to the bot's real settings
 * (the same ones as Settings > Bot inputs) and applies to the next signal.
 * The flow's shape is the engine's logic, so it stays fixed - only the values
 * on its nodes can change, and only the ones the engine really reads.
 */

type Direction = "bullish" | "bearish";

/** Every 5 minutes from 9:30am to 4:00pm, the way Option Alpha lists its times. */
const MARKS: string[] = [];
for (let m = 9 * 60 + 30; m <= 16 * 60; m += 5) MARKS.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
const withCurrent = (options: string[], current: string) => (options.includes(current) ? options : [...options, current].sort());

/** The bot's saved inputs with some values replaced; `hours: null` returns it to the default window. */
export function inputsWith(config: NonNullable<BotContext["data"]["config"]>, changes: Omit<Partial<BotInputs>, "hours"> & { hours?: { start: string; end: string } | null }): Record<string, unknown> {
  const { id: _id, ...base } = config;
  const next: Record<string, unknown> = { ...base, ...changes };
  if (changes.hours === null) delete next.hours;
  return next;
}

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

const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

function Shell({ title, ctx, onClose, footer, children }: { title: string; ctx: BotContext; onClose: () => void; footer?: ReactNode; children: ReactNode }) {
  return (
    <Drawer title={title} onClose={onClose} footer={footer}>
      <div className="space-y-5">
        {children}
      </div>
    </Drawer>
  );
}

function NeedsInputs({ ctx, onClose }: { ctx: BotContext; onClose: () => void }) {
  return (
    <Drawer title="Not set up yet" onClose={onClose} footer={<button className={`${buttonClass.secondary} w-full`} onClick={onClose}>Close</button>}>
      <p className="text-sm text-muted">{ctx.data.bot.configError ?? "This bot has no trading inputs yet."} Set them first under Settings &gt; Bot inputs; then this step can be edited here.</p>
    </Drawer>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-2/60 px-3 py-2 text-sm">
    <span className="text-muted">{label}</span>
    <span className="font-medium">{value}</span>
  </div>
);

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

/** "Open Short Put/Call Spread". */
export function OpenEditor({ direction, ctx, onClose }: { direction: Direction; ctx: BotContext; onClose: () => void }) {
  const cfg = ctx.data.config;
  const put = direction === "bullish";
  const side = put ? "put" : "call";
  const [offset, setOffset] = useState(cfg ? String(put ? cfg.putShortOffset : cfg.callShortOffset) : "");
  const [width, setWidth] = useState(cfg ? String(cfg.widthPoints) : "");
  const [quantity, setQuantity] = useState(cfg ? String(cfg.quantity) : "");
  const [credit, setCredit] = useState(cfg ? String(cfg.openingCreditEstimate) : "");
  const [percent, setPercent] = useState(cfg ? String(cfg.openPricePercent ?? 100) : "100");
  const [rounding, setRounding] = useState<StrikeRounding>(cfg?.strikeRounding ?? "outward");
  const { busy, save } = useSave(ctx, onClose);
  if (!cfg) return <NeedsInputs ctx={ctx} onClose={onClose} />;

  return (
    <Shell
      title={`Open short ${side} spread`}
      ctx={ctx}
      onClose={onClose}
      footer={
        <button
          className={`${buttonClass.primary} w-full`}
          disabled={busy}
          onClick={() =>
            save({
              ...(put ? { putShortOffset: num(offset) } : { callShortOffset: num(offset) }),
              widthPoints: num(width),
              quantity: num(quantity),
              openingCreditEstimate: num(credit),
              openPricePercent: num(percent),
              strikeRounding: rounding,
            })
          }
        >
          {busy ? "Saving..." : "Save"}
        </button>
      }
    >
      <div className="space-y-2">
        <Row label="Symbol" value={cfg.underlying} />
        <Row label="Expiration" value="Exactly 0 days (same day)" />
      </div>
      <Field label={`Short ${side} strike`}>
        <input className={inputClass} inputMode="decimal" value={offset} onChange={(e) => setOffset(e.target.value)} aria-label={`Short ${side} offset`} />
      </Field>
      <Field label="Rounding">
        <select className={inputClass} value={rounding} onChange={(e) => setRounding(e.target.value as StrikeRounding)} aria-label="Strike rounding">
          <option value="outward">Out of the money</option>
          <option value="nearest">Nearest strike</option>
        </select>
      </Field>
      <Field label={`Long ${side} strike`}>
        <input className={inputClass} inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} aria-label="Spread width" />
      </Field>
      <Field label="Position size">
        <input className={inputClass} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} aria-label="Contracts" />
      </Field>
      <Field label="Expected credit">
        <input className={inputClass} inputMode="decimal" value={credit} onChange={(e) => setCredit(e.target.value)} aria-label="Expected credit" />
      </Field>
      <Field label="Final price (%)">
        <input className={inputClass} inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} aria-label="Open price percent" />
      </Field>
    </Shell>
  );
}

const SMART_MODES: { mode: SmartPricingMode; label: string }[] = [
  { mode: "normal", label: "Normal - up to 4 prices, 10 seconds each" },
  { mode: "fast", label: "Fast - up to 3 prices, 5 seconds each" },
  { mode: "patient", label: "Patient - up to 5 prices, 20 seconds each" },
  { mode: "off", label: "Off - 1 limit price" },
];

/** Option Alpha's SmartPricing dialog: the ladder preset and the final price. Both are the bot's real settings. */
function SmartPricingModal({ mode, percent, onApply, onClose }: { mode: SmartPricingMode; percent: string; onApply: (mode: SmartPricingMode, percent: string) => void; onClose: () => void }) {
  const [m, setM] = useState(mode);
  const [pct, setPct] = useState(percent);
  const bad = !(num(pct) > 0 && num(pct) <= 100);
  return (
    <Modal title="SmartPricing" onClose={onClose} footer={<button className={`${buttonClass.primary} px-8`} disabled={bad} onClick={() => onApply(m, pct)}>Save</button>}>
      <div className="space-y-5">
        <p className="text-sm text-muted">The bot places timed, limit orders traversing the bid/ask spread to the final price set below.</p>
        <select className={inputClass} value={m} onChange={(e) => setM(e.target.value as SmartPricingMode)} aria-label="SmartPricing">
          {SMART_MODES.map((o) => (
            <option key={o.mode} value={o.mode}>
              {o.label}
            </option>
          ))}
        </select>
        <div>
          <div className="text-sm font-semibold">Final Price</div>
          <p className="mt-1 text-sm text-muted">The price for the final order placed by your bot: the worst price it will accept when closing. The last price waits for the order timeout, then cancels.</p>
          <div className="mt-3 flex items-center gap-2 text-sm">
            <input className={`${inputClass} !w-24`} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} aria-label="Final price percent" />
            <span>% of bid/ask spread</span>
          </div>
          {bad && <p className="mt-2 text-xs text-down">Enter a percent above 0, up to 100.</p>}
        </div>
      </div>
    </Modal>
  );
}

/** "Close Position", laid out like Option Alpha's form. Price (SmartPricing and the final price) is the bot's own close setting;
 * Memo and Tags are written on the position this trigger closes. The position is the opposite side's spread and the quantity is all of it. */
export function CloseEditor({ direction, ctx, onClose }: { direction: Direction; ctx: BotContext; onClose: () => void }) {
  const cfg = ctx.data.config;
  const spread = direction === "bullish" ? "Short call spread" : "Short put spread";
  const saved = ctx.data.bot.closeSettings?.[direction];
  const [percent, setPercent] = useState(cfg ? String(cfg.closePricePercent ?? 100) : "100");
  const [mode, setMode] = useState<SmartPricingMode>(cfg?.smartPricing ?? "normal");
  const [memo, setMemo] = useState(saved?.memo ?? "");
  const [tags, setTags] = useState((saved?.tags ?? []).join(", "));
  const [pricing, setPricing] = useState(false);
  const [lookup, setLookup] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!cfg) return <NeedsInputs ctx={ctx} onClose={onClose} />;

  const save = async () => {
    setBusy(true);
    const ok = await ctx.patch(
      { inputs: inputsWith(cfg, { closePricePercent: num(percent), smartPricing: mode }), closeSettings: { [direction]: { memo, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } } },
      "Saved to the bot's settings. It applies to the next signal.",
    );
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <>
      <Shell title="Close Position" ctx={ctx} onClose={onClose} footer={<button className={`${buttonClass.primary} w-full`} disabled={busy || !(num(percent) > 0 && num(percent) <= 100)} onClick={save}>{busy ? "Saving..." : "Save"}</button>}>
        <div className="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-5 text-sm">
          <span>Position</span>
          <button onClick={() => setLookup(true)} className="inline-flex w-fit max-w-full items-center gap-2 rounded-lg border border-dashed border-accent/50 bg-accent/5 px-3 py-1.5 text-accent" title="Open the position lookup">
            <IconLink width={14} height={14} className="shrink-0" />
            <span className="truncate">{`Position (${cfg.underlying}, ${spread})`}</span>
          </button>
          <span>Price</span>
          <button onClick={() => setPricing(true)} className={`${inputClass} flex items-center justify-between text-left`} aria-label="Price">
            <span>{percent}% of bid/ask</span>
            <span className="text-faint">▾</span>
          </button>
          <span>Quantity</span>
          <select className={inputClass} value="100" onChange={() => undefined} aria-label="Quantity">
            <option value="100">100% of position</option>
          </select>
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
      {pricing && (
        <SmartPricingModal
          mode={mode}
          percent={percent}
          onApply={(m, p) => {
            setMode(m);
            setPercent(p);
            setPricing(false);
          }}
          onClose={() => setPricing(false)}
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
