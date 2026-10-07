"use client";

import { useState, type ReactNode } from "react";
import { Drawer, Field, buttonClass, inputClass } from "../bot/primitives";
import type { BotContext } from "../bot/BotDetail";
import type { BotInputs, MonitorKey, StrikeRounding } from "@/lib/automation/types";
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
  const live = ctx.data.counts.activePositions > 0;
  return (
    <Drawer title={title} onClose={onClose} footer={footer}>
      <div className="space-y-5">
        <p className="rounded-lg bg-accent/10 px-3 py-2 text-xs text-accent">Live: these values are this bot&apos;s real settings. Saving applies to the next signal, not to a position that is already open.</p>
        {live && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500">There is an open position. It keeps the values it was opened with.</p>}
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
      <Field label="Current market time is between" hint="New York time. Signals outside this window do nothing.">
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
      <p className="text-xs text-muted">This window is shared by the Bullish and Bearish automations. Weekdays only, and the NYSE holiday and early-close calendar still apply.</p>
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
      <Field label={`Short ${side} strike`} hint={`Points ${put ? "below" : "above"} the underlying price: a signed number, ${put ? "negative" : "positive"} for the out-of-the-money side. Decimals are fine (e.g. ${put ? "-0.01" : "0.01"}).`}>
        <input className={inputClass} inputMode="decimal" value={offset} onChange={(e) => setOffset(e.target.value)} aria-label={`Short ${side} offset`} />
      </Field>
      <Field label="Rounding" hint="How that target lands on a real strike. Out of the money: the put rounds down, the call rounds up. (To verify against Option Alpha.) Shared by both automations.">
        <select className={inputClass} value={rounding} onChange={(e) => setRounding(e.target.value as StrikeRounding)} aria-label="Strike rounding">
          <option value="outward">Out of the money</option>
          <option value="nearest">Nearest strike</option>
        </select>
      </Field>
      <Field label={`Long ${side} strike`} hint={`Points ${put ? "below" : "above"} the short ${side}. Shared by both automations: the spread width.`}>
        <input className={inputClass} inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} aria-label="Spread width" />
      </Field>
      <Field label="Position size" hint="Contracts. Shared by both automations.">
        <input className={inputClass} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} aria-label="Contracts" />
      </Field>
      <Field label="Expected credit" hint="Per spread: the order's limit credit and the risk check. Must be below the width.">
        <input className={inputClass} inputMode="decimal" value={credit} onChange={(e) => setCredit(e.target.value)} aria-label="Expected credit" />
      </Field>
      <Field label="Final price (%)" hint="Where the price ladder ends, as a percent of the way from the mid to the bid/ask (100 = the full bid/ask). With live quotes the order walks there in steps (SmartPricing); the last price waits 2 minutes, then cancels.">
        <input className={inputClass} inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} aria-label="Open price percent" />
      </Field>
    </Shell>
  );
}

/** "Close Position". */
export function CloseEditor({ direction, ctx, onClose }: { direction: Direction; ctx: BotContext; onClose: () => void }) {
  const cfg = ctx.data.config;
  const closing = direction === "bullish" ? "call" : "put";
  const [percent, setPercent] = useState(cfg ? String(cfg.closePricePercent ?? 100) : "100");
  const { busy, save } = useSave(ctx, onClose);
  if (!cfg) return <NeedsInputs ctx={ctx} onClose={onClose} />;

  return (
    <Shell
      title="Close position"
      ctx={ctx}
      onClose={onClose}
      footer={
        <button className={`${buttonClass.primary} w-full`} disabled={busy} onClick={() => save({ closePricePercent: num(percent) })}>
          {busy ? "Saving..." : "Save"}
        </button>
      }
    >
      <div className="space-y-2">
        <Row label="Position" value={`${cfg.underlying}, short ${closing} spread`} />
        <Row label="Quantity" value="100% of position" />
      </div>
      <Field label="Final price (%)" hint="Where the closing ladder ends, as a percent of the way from the mid to the bid/ask. The engine waits for the confirmed fill before opening the other side.">
        <input className={inputClass} inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} aria-label="Close price percent" />
      </Field>
    </Shell>
  );
}

function FixedStep({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return (
    <Drawer title={title} onClose={onClose} footer={<button className={`${buttonClass.secondary} w-full`} onClick={onClose}>Close</button>}>
      <p className="text-sm text-muted">{text}</p>
    </Drawer>
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
      return (
        <FixedStep
          key={step.id}
          title="Position check"
          text="Fixed by the engine: if a spread of the opposite type is held it is closed (and the close confirmed) before anything opens, and the wanted side is only opened when it isn't already held. How many positions the bot may hold is set under Settings > Safeguards."
          onClose={onClose}
        />
      );
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
        <p className="-mt-2 text-xs text-muted">Price and quantity are the bot&apos;s own close settings (Final price, SmartPricing); they aren&apos;t edited here.</p>
        <Field label="Memo" hint="Written on the position this monitor closes.">
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
