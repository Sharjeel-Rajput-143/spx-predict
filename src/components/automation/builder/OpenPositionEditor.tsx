"use client";

import { useState, type ReactNode } from "react";
import { Btn, Drawer, inputClass, Modal } from "../bot/primitives";
import type { BotContext } from "../bot/BotDetail";
import type { ClosePricing } from "@/lib/automation/closePricing";
import { validateOpenSettings, type ExitOptions, type LongStrikeMethod, type OpenSettings, type ShortStrikeMethod, type Side, type SizeMethod } from "@/lib/automation/openSettings";
import { NeedsInputs, Shell, SmartPricingModal, num, priceLabel, type Direction } from "./editorParts";

/**
 * "Open Position" on a Bullish/Bearish flow, laid out like Option Alpha's panel. Everything here is saved on the bot for this
 * trigger and read by the engine at the Open step on the next signal; what is left alone is the bot's own inputs. Option Alpha
 * choices that need data this platform does not have (delta, standard deviation, GEX, VIX, IV Rank, earnings) are not offered.
 */

const small = `${inputClass} !w-24`;
const dollars = (n: number) => `$${n.toLocaleString("en-US")}`;

type SizeKind = "contracts" | "risk" | "risk_cap" | "alloc" | "alloc_dollars" | "alloc_contracts";
const SIZE_KINDS: { kind: SizeKind; label: string }[] = [
  { kind: "contracts", label: "contract(s)" },
  { kind: "risk", label: "up to $ risk" },
  { kind: "risk_cap", label: "up to $ risk capped at N contract(s)" },
  { kind: "alloc", label: "% of bot's allocation" },
  { kind: "alloc_dollars", label: "% of allocation up to $ cap" },
  { kind: "alloc_contracts", label: "% of allocation capped at N contract(s)" },
];

const kindOf = (s: SizeMethod | undefined): SizeKind => {
  if (!s || s.method === "contracts") return "contracts";
  if (s.method === "risk") return s.cap !== undefined ? "risk_cap" : "risk";
  return s.capDollars !== undefined ? "alloc_dollars" : s.capContracts !== undefined ? "alloc_contracts" : "alloc";
};

/** A full-width number box with its "$" / "%" / words inside it, so every field in the column lines up. */
function Amount({ value, onChange, label, prefix, suffix, mode = "decimal" }: { value: string; onChange: (v: string) => void; label: string; prefix?: string; suffix?: string; mode?: "decimal" | "numeric" }) {
  return (
    <div className="relative w-full">
      {prefix && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">{prefix}</span>}
      <input
        className={inputClass}
        style={{ paddingLeft: prefix ? `calc(${prefix.length * 0.55}rem + 1.4rem)` : undefined, paddingRight: suffix ? "2rem" : undefined }}
        inputMode={mode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
      {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">{suffix}</span>}
    </div>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="pt-2 text-sm">{label}</span>
      <div className="min-w-0 w-full">{children}</div>
    </>
  );
}

function Toggle({ on, onChange, label, children }: { on: boolean; onChange: (v: boolean) => void; label: string; children?: ReactNode }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} aria-label={label} className="h-4 w-4 accent-[var(--accent)]" />
      {children ?? <span>{label}</span>}
    </label>
  );
}

const exitLabel = (e: ExitOptions) => {
  const parts: string[] = [];
  if (e.profitPercent !== undefined) parts.push(`profit ${e.profitPercent}%`);
  if (e.profitDollars !== undefined) parts.push(`profit ${dollars(e.profitDollars)}`);
  if (e.stopPercent !== undefined) parts.push(`stop loss ${e.stopPercent}%`);
  if (e.stopDollars !== undefined) parts.push(`stop loss ${dollars(e.stopDollars)}`);
  if (e.touchPoints !== undefined) parts.push(`touch ${e.touchPoints} pts`);
  if (e.expirationMinutes !== undefined) parts.push(`${e.expirationMinutes} min before close`);
  return parts.length > 0 ? parts.join(", ") : "None";
};

/** Exit Options: the position is checked every minute from 9:31am to a minute before the close, and closed when any of these is met. */
function ExitModal({ exit, onApply, onClose }: { exit: ExitOptions; onApply: (e: ExitOptions) => void; onClose: () => void }) {
  const [pOn, setPOn] = useState(exit.profitPercent !== undefined);
  const [p, setP] = useState(String(exit.profitPercent ?? 50));
  const [pdOn, setPdOn] = useState(exit.profitDollars !== undefined);
  const [pd, setPd] = useState(String(exit.profitDollars ?? ""));
  const [sOn, setSOn] = useState(exit.stopPercent !== undefined);
  const [s, setS] = useState(String(exit.stopPercent ?? 100));
  const [sdOn, setSdOn] = useState(exit.stopDollars !== undefined);
  const [sd, setSd] = useState(String(exit.stopDollars ?? ""));
  const [tOn, setTOn] = useState(exit.touchPoints !== undefined);
  const [t, setT] = useState(String(exit.touchPoints ?? 10));
  const [eOn, setEOn] = useState(exit.expirationMinutes !== undefined);
  const [e, setE] = useState(String(exit.expirationMinutes ?? 30));

  const draft: ExitOptions = { ...(pOn ? { profitPercent: num(p) } : {}), ...(pdOn ? { profitDollars: num(pd) } : {}), ...(sOn ? { stopPercent: num(s) } : {}), ...(sdOn ? { stopDollars: num(sd) } : {}), ...(tOn ? { touchPoints: num(t) } : {}), ...(eOn ? { expirationMinutes: num(e) } : {}) };
  const checked = validateOpenSettings({ exit: draft });
  return (
    <Modal title="Exit Options" onClose={onClose} footer={<Btn kind="primary" className="px-8"  disabled={!checked.ok} onClick={() => checked.ok && onApply(checked.value.exit ?? {})}>Save</Btn>}>
      <div className="space-y-4">
        <p className="text-sm text-muted">Your bot checks your position every 1 minute from 9:31am to 1 minute before market close and automatically attempts to close it if any of these criteria are met.</p>
        <div className="text-sm font-semibold">Profit Taking</div>
        <Toggle on={pOn} onChange={setPOn} label="Profit taking percent">
          <input className={small} inputMode="decimal" value={p} onChange={(e) => setP(e.target.value)} aria-label="Profit taking percent value" />
          <span>% of the credit received or more</span>
        </Toggle>
        <Toggle on={pdOn} onChange={setPdOn} label="Profit taking dollars">
          <span>$</span>
          <input className={small} inputMode="decimal" value={pd} onChange={(e) => setPd(e.target.value)} aria-label="Profit taking dollars value" />
          <span>or more</span>
        </Toggle>
        <div className="text-sm font-semibold">Stop Loss</div>
        <Toggle on={sOn} onChange={setSOn} label="Stop loss percent">
          <input className={small} inputMode="decimal" value={s} onChange={(e) => setS(e.target.value)} aria-label="Stop loss percent value" />
          <span>% of the credit received or more</span>
        </Toggle>
        <Toggle on={sdOn} onChange={setSdOn} label="Stop loss dollars">
          <span>$</span>
          <input className={small} inputMode="decimal" value={sd} onChange={(e) => setSd(e.target.value)} aria-label="Stop loss dollars value" />
          <span>or more</span>
        </Toggle>
        <div className="text-sm font-semibold">Touch</div>
        <Toggle on={tOn} onChange={setTOn} label="Touch">
          <span>Close if the underlying is</span>
          <input className={small} inputMode="decimal" value={t} onChange={(e) => setT(e.target.value)} aria-label="Touch distance" />
          <span>points from the short strike or less</span>
        </Toggle>
        <div className="text-sm font-semibold">Expiration</div>
        <Toggle on={eOn} onChange={setEOn} label="Expiration exit">
          <span>Close at market</span>
          <input className={small} inputMode="numeric" value={e} onChange={(ev) => setE(ev.target.value)} aria-label="Minutes before the close" />
          <span>minutes before the market closes (the day the position expires)</span>
        </Toggle>
        {eOn && <p className="text-xs text-muted">Needs only the clock, no option prices. A position opened inside that last stretch is closed on the next check. Checked once a minute by a server that stays up; Vercel only runs the end-of-day job, so there it does not act.</p>}
        {!checked.ok && <p className="text-xs text-down">{checked.reason}</p>}
      </div>
    </Modal>
  );
}

export function OpenEditor({ direction, ctx, onClose }: { direction: Direction; ctx: BotContext; onClose: () => void }) {
  const cfg = ctx.data.config;
  const put = direction === "bullish";
  const side = put ? "put" : "call";
  const saved = ctx.data.bot.openSettings?.[direction];

  // The strikes: what this trigger was set to, else what the bot's own offsets and width say.
  const botOffset = cfg ? (put ? cfg.putShortOffset : cfg.callShortOffset) : 0;
  const s0: ShortStrikeMethod = saved?.shortStrike ?? { method: "points", amount: Math.abs(botOffset), side: botOffset < 0 ? "below" : "above" };
  const [sMethod, setSMethod] = useState<ShortStrikeMethod["method"]>(s0.method);
  const [sAmount, setSAmount] = useState(s0.method === "flat" ? "" : String(s0.amount));
  const [sSide, setSSide] = useState<Side>(s0.method === "flat" ? (put ? "below" : "above") : s0.side);
  const [sStrike, setSStrike] = useState(s0.method === "flat" ? String(s0.strike) : "");
  const l0: LongStrikeMethod = saved?.longStrike ?? { method: "points", amount: cfg?.widthPoints ?? 5 };
  const [lMethod, setLMethod] = useState<LongStrikeMethod["method"]>(l0.method);
  const [lAmount, setLAmount] = useState(l0.method === "flat" ? "" : String(l0.amount));
  const [lStrike, setLStrike] = useState(l0.method === "flat" ? String(l0.strike) : "");

  // Size.
  const z0 = saved?.size;
  const [kind, setKind] = useState<SizeKind>(kindOf(z0));
  const [nContracts, setNContracts] = useState(String(z0?.method === "contracts" ? z0.count : (cfg?.quantity ?? 1)));
  const [risk, setRisk] = useState(z0?.method === "risk" ? String(z0.dollars) : "");
  const [riskCap, setRiskCap] = useState(z0?.method === "risk" && z0.cap !== undefined ? String(z0.cap) : "");
  const [percent, setPercent] = useState(z0?.method === "allocation" ? String(z0.percent) : "");
  const [capDollars, setCapDollars] = useState(z0?.method === "allocation" && z0.capDollars !== undefined ? String(z0.capDollars) : "");
  const [capContracts, setCapContracts] = useState(z0?.method === "allocation" && z0.capContracts !== undefined ? String(z0.capContracts) : "");

  const [pricing, setPricingValue] = useState<ClosePricing>(saved?.pricing ?? { speed: cfg?.smartPricing ?? "normal", percent: cfg?.openPricePercent ?? 100 });
  const [exit, setExit] = useState<ExitOptions>(saved?.exit ?? {});
  const [tags, setTags] = useState((saved?.tags ?? []).join(", "));

  const e0 = saved?.entry ?? {};
  const [lessOpenOn, setLessOpenOn] = useState(e0.lessOpen !== undefined);
  const [lessOpen, setLessOpen] = useState(String(e0.lessOpen ?? 1));
  const [lessTodayOn, setLessTodayOn] = useState(e0.lessToday !== undefined);
  const [lessToday, setLessToday] = useState(String(e0.lessToday ?? 1));
  const [lessSymOn, setLessSymOn] = useState(e0.lessForSymbol !== undefined);
  const [lessSym, setLessSym] = useState(String(e0.lessForSymbol ?? 1));

  const c0 = saved?.position ?? {};
  const [bidAskOn, setBidAskOn] = useState(c0.maxBidAskSpread !== undefined);
  const [bidAsk, setBidAsk] = useState(String(c0.maxBidAskSpread ?? ""));
  const [midOn, setMidOn] = useState(c0.midMin !== undefined || c0.midMax !== undefined);
  const [midMin, setMidMin] = useState(String(c0.midMin ?? ""));
  const [midMax, setMidMax] = useState(String(c0.midMax ?? ""));
  const [widthOn, setWidthOn] = useState(c0.widthMin !== undefined || c0.widthMax !== undefined);
  const [widthMin, setWidthMin] = useState(String(c0.widthMin ?? ""));
  const [widthMax, setWidthMax] = useState(String(c0.widthMax ?? ""));
  const [otmOn, setOtmOn] = useState(c0.otmPercentAbove !== undefined);
  const [otm, setOtm] = useState(String(c0.otmPercentAbove ?? ""));

  const [view, setView] = useState<null | "symbol" | "expiration" | "short" | "long" | "size">(null);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!cfg) return <NeedsInputs ctx={ctx} onClose={onClose} />;

  const shortStrike: ShortStrikeMethod = sMethod === "flat" ? { method: "flat", strike: num(sStrike) } : { method: sMethod, amount: num(sAmount), side: sSide };
  const longStrike: LongStrikeMethod = lMethod === "flat" ? { method: "flat", strike: num(lStrike) } : { method: lMethod, amount: num(lAmount) };
  const size: SizeMethod =
    kind === "contracts"
      ? { method: "contracts", count: num(nContracts) }
      : kind === "risk"
        ? { method: "risk", dollars: num(risk) }
        : kind === "risk_cap"
          ? { method: "risk", dollars: num(risk), cap: num(riskCap) }
          : { method: "allocation", percent: num(percent), ...(kind === "alloc_dollars" ? { capDollars: num(capDollars) } : {}), ...(kind === "alloc_contracts" ? { capContracts: num(capContracts) } : {}) };

  const entry = { ...(lessOpenOn ? { lessOpen: num(lessOpen) } : {}), ...(lessTodayOn ? { lessToday: num(lessToday) } : {}), ...(lessSymOn ? { lessForSymbol: num(lessSym) } : {}) };
  const position = {
    ...(bidAskOn ? { maxBidAskSpread: num(bidAsk) } : {}),
    ...(midOn ? { ...(midMin.trim() ? { midMin: num(midMin) } : {}), ...(midMax.trim() ? { midMax: num(midMax) } : {}) } : {}),
    ...(widthOn ? { ...(widthMin.trim() ? { widthMin: num(widthMin) } : {}), ...(widthMax.trim() ? { widthMax: num(widthMax) } : {}) } : {}),
    ...(otmOn ? { otmPercentAbove: num(otm) } : {}),
  };
  const draft: OpenSettings = {
    shortStrike,
    longStrike,
    size,
    pricing,
    tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
    ...(Object.keys(entry).length > 0 ? { entry } : {}),
    ...(Object.keys(position).length > 0 ? { position } : {}),
    ...(Object.keys(exit).length > 0 ? { exit } : {}),
  };
  const checked = validateOpenSettings(draft);

  const save = async (value: OpenSettings | null) => {
    setBusy(true);
    const ok = await ctx.patch({ openSettings: { [direction]: value } }, value ? "Saved to the bot's settings. It applies to the next signal." : "Back to the bot's own inputs.");
    setBusy(false);
    if (ok) onClose();
  };

  const select = (value: string, onChange: (v: string) => void, options: { value: string; label: string }[], label: string) => (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  const legSide = put ? "below" : "above";

  const spreadName = put ? "Short Put Spread" : "Short Call Spread";
  const money = (n: number) => `$${Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "?"}`;
  const shortSummary = sMethod === "flat" ? `flat strike ${sStrike || "?"}` : `${sMethod === "points" ? money(num(sAmount)) : `${sAmount || "?"}%`} ${sSide} underlying price`;
  const longSummary = lMethod === "flat" ? `flat strike ${lStrike || "?"}` : `${lMethod === "points" ? money(num(lAmount)) : `${lAmount || "?"}%`} ${legSide} short ${side} leg`;
  const sizeSummary =
    kind === "contracts"
      ? `${nContracts || "?"} contract${num(nContracts) === 1 ? "" : "s"}`
      : kind === "risk"
        ? `up to ${money(num(risk))} risk`
        : kind === "risk_cap"
          ? `up to ${money(num(risk))} risk, at most ${riskCap || "?"} contracts`
          : kind === "alloc"
            ? `${percent || "?"}% of the allocation`
            : kind === "alloc_dollars"
              ? `${percent || "?"}% of the allocation, up to ${money(num(capDollars))}`
              : `${percent || "?"}% of the allocation, at most ${capContracts || "?"} contracts`;

  /** One row of Option Alpha's Position Details: a label and a single field that shows the choice and opens its editor. */
  const row = (label: string, value: ReactNode, onOpen: (() => void) | null, opts: { muted?: boolean; dropdown?: boolean } = {}) => (
    <>
      <span className="text-sm">{label}</span>
      <button
        type="button"
        onClick={onOpen ?? undefined}
        aria-label={label}
        className={`flex w-full items-center justify-between rounded-md border border-line bg-surface px-3 py-2.5 text-left text-sm hover:border-accent ${opts.muted ? "text-faint" : ""}`}
      >
        <span className="min-w-0 truncate">{value}</span>
        <span className="ml-2 shrink-0 text-faint">{opts.dropdown ? "⌄" : "›"}</span>
      </button>
    </>
  );

  const subDone = <Btn kind="primary" className="mx-auto block w-2/3"  onClick={() => setView(null)}>Save</Btn>;

  return (
    <>
      <Shell
        title={`Open ${spreadName}`}
        ctx={ctx}
        onClose={onClose}
        footer={
          <div className="space-y-2">
            <Btn kind="primary" className="mx-auto block w-2/3"  disabled={busy || !checked.ok} onClick={() => checked.ok && save(checked.value)}>
              {busy ? "Saving..." : "Save"}
            </Btn>
            {saved && (
              <Btn kind="secondary" className="mx-auto block w-2/3"  disabled={busy} onClick={() => save(null)}>
                Back to the bot&apos;s own inputs
              </Btn>
            )}
          </div>
        }
      >
        <h3 className="text-base font-semibold">Position Details</h3>
        <div className="grid grid-cols-[7rem_1fr] items-center gap-x-4 gap-y-5">
          {row("Symbol", <span className="font-semibold text-accent">{cfg.underlying}</span>, () => setView("symbol"))}
          {row("Expiration", "exactly 0 days", () => setView("expiration"))}
          {row(`Long ${put ? "Put" : "Call"}`, longSummary, () => setView("long"))}
          {row(`Short ${put ? "Put" : "Call"}`, shortSummary, () => setView("short"))}
          {row("Position Size", sizeSummary, () => setView("size"))}
          {row("Price", priceLabel(pricing), () => setPricingOpen(true), { dropdown: true })}
          {row("Exit Options", exitLabel(exit), () => setExitOpen(true), { dropdown: true, muted: Object.keys(exit).length === 0 })}
          <span className="text-sm">Tags</span>
          <input className={`${inputClass} !bg-surface`} value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
        </div>

        <details className="-mx-4 border-t border-line px-4 pt-4 [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-3 pb-3 text-base font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-accent/10 text-accent">›</span>
            Entry Criteria
          </summary>
          <div className="space-y-3 pb-3">
            <label className="flex items-center gap-2 text-sm text-faint" title="Always checked: the allocation limit.">
              <input type="checkbox" checked disabled /> Bot has enough available capital
            </label>
            <Toggle on={lessOpenOn} onChange={setLessOpenOn} label="Less than open positions">
              <span>Bot has less than</span>
              <input className={`${inputClass} !w-16`} inputMode="numeric" value={lessOpen} onChange={(e) => setLessOpen(e.target.value)} aria-label="Open positions limit" />
              <span>open position(s)</span>
            </Toggle>
            <Toggle on={lessTodayOn} onChange={setLessTodayOn} label="Less than new positions today">
              <span>Bot opened less than</span>
              <input className={`${inputClass} !w-16`} inputMode="numeric" value={lessToday} onChange={(e) => setLessToday(e.target.value)} aria-label="New positions today limit" />
              <span>new position(s) today</span>
            </Toggle>
            <Toggle on={lessSymOn} onChange={setLessSymOn} label="Less than open positions with symbol">
              <span>Bot has less than</span>
              <input className={`${inputClass} !w-16`} inputMode="numeric" value={lessSym} onChange={(e) => setLessSym(e.target.value)} aria-label="Open positions with symbol limit" />
              <span>open position(s) with symbol</span>
            </Toggle>
            <label className="flex items-center gap-2 text-sm text-faint" title="Always checked: no leg may collide with an existing position.">
              <input type="checkbox" checked disabled /> Bot doesn&apos;t have a position with an identical leg
            </label>
          </div>
        </details>

        <details className="-mx-4 border-t border-line px-4 pt-4 [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-3 pb-3 text-base font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-accent/10 text-accent">›</span>
            Position Criteria
          </summary>
          <div className="space-y-3 pb-3">
            <Toggle on={bidAskOn} onChange={setBidAskOn} label="Bid/ask spread less than">
              <span>Bid/ask spread less than $</span>
              <input className={small} inputMode="decimal" value={bidAsk} onChange={(e) => setBidAsk(e.target.value)} aria-label="Bid/ask spread limit" />
            </Toggle>
            <Toggle on={midOn} onChange={setMidOn} label="Mid price between">
              <span>Mid price between $</span>
              <input className={small} inputMode="decimal" value={midMin} onChange={(e) => setMidMin(e.target.value)} aria-label="Minimum mid price" />
              <span>and $</span>
              <input className={small} inputMode="decimal" value={midMax} onChange={(e) => setMidMax(e.target.value)} aria-label="Maximum mid price" />
            </Toggle>
            <Toggle on={widthOn} onChange={setWidthOn} label="Spread width between">
              <span>Spread width between</span>
              <input className={small} inputMode="decimal" value={widthMin} onChange={(e) => setWidthMin(e.target.value)} aria-label="Minimum width" />
              <span>and</span>
              <input className={small} inputMode="decimal" value={widthMax} onChange={(e) => setWidthMax(e.target.value)} aria-label="Maximum width" />
            </Toggle>
            <Toggle on={otmOn} onChange={setOtmOn} label="OTM percent greater than">
              <span>OTM % greater than</span>
              <input className={small} inputMode="decimal" value={otm} onChange={(e) => setOtm(e.target.value)} aria-label="Out of the money percent" />
              <span>%</span>
            </Toggle>
          </div>
        </details>
        {!checked.ok && <p className="text-xs text-down">{checked.reason}</p>}
      </Shell>

      {view === "symbol" && (
        <Drawer title="Symbol" onClose={() => setView(null)} onBack={() => setView(null)} footer={subDone}>
          <p className="mb-3 text-sm text-muted">This bot trades one symbol.</p>
          <div className="rounded-md border border-accent bg-accent/5 px-3 py-2.5 text-sm font-semibold text-accent">{cfg.underlying}</div>
        </Drawer>
      )}
      {view === "expiration" && (
        <Drawer title="Expiration" onClose={() => setView(null)} onBack={() => setView(null)} footer={subDone}>
          <p className="mb-3 text-sm text-muted">Positions open and expire the same day.</p>
          <div className="rounded-md border border-accent bg-accent/5 px-3 py-2.5 text-sm font-semibold text-accent">exactly 0 days</div>
        </Drawer>
      )}
      {view === "short" && (
        <Drawer title={`Short ${put ? "Put" : "Call"}`} onClose={() => setView(null)} onBack={() => setView(null)} footer={subDone}>
          <div className="space-y-3">
            {select(sMethod, (v) => setSMethod(v as ShortStrikeMethod["method"]), [{ value: "points", label: "$ from the price" }, { value: "percent", label: "% from the price" }, { value: "flat", label: "flat $ strike" }], "Short strike method")}
            {sMethod === "flat" ? (
              <Amount prefix="$" value={sStrike} onChange={setSStrike} label="Short strike price" />
            ) : (
              <>
                <Amount prefix={sMethod === "points" ? "$" : undefined} suffix={sMethod === "percent" ? "%" : undefined} value={sAmount} onChange={setSAmount} label="Short strike amount" />
                {select(sSide, (v) => setSSide(v as Side), [{ value: "above", label: "above underlying price" }, { value: "below", label: "below underlying price" }], "Short strike side")}
              </>
            )}
          </div>
        </Drawer>
      )}
      {view === "long" && (
        <Drawer title={`Long ${put ? "Put" : "Call"}`} onClose={() => setView(null)} onBack={() => setView(null)} footer={subDone}>
          <div className="space-y-3">
            {select(lMethod, (v) => setLMethod(v as LongStrikeMethod["method"]), [{ value: "points", label: `$ ${legSide} the short leg` }, { value: "percent", label: `% ${legSide} the short leg` }, { value: "flat", label: "flat $ strike" }], "Long strike method")}
            {lMethod === "flat" ? (
              <Amount prefix="$" value={lStrike} onChange={setLStrike} label="Long strike price" />
            ) : (
              <Amount prefix={lMethod === "points" ? "$" : undefined} suffix={lMethod === "percent" ? "%" : undefined} value={lAmount} onChange={setLAmount} label="Long strike amount" />
            )}
          </div>
        </Drawer>
      )}
      {view === "size" && (
        <Drawer title="Position Size" onClose={() => setView(null)} onBack={() => setView(null)} footer={subDone}>
          <div className="space-y-3">
            {select(kind, (v) => setKind(v as SizeKind), SIZE_KINDS.map((k) => ({ value: k.kind, label: k.label })), "Position size method")}
            {kind === "contracts" && <Amount mode="numeric" value={nContracts} onChange={setNContracts} label="Contracts" />}
            {(kind === "risk" || kind === "risk_cap") && <Amount prefix="Up to $" value={risk} onChange={setRisk} label="Risk in dollars" />}
            {kind.startsWith("alloc") && <Amount suffix="%" value={percent} onChange={setPercent} label="Percent of allocation" />}
            {kind === "alloc_dollars" && <Amount prefix="Up to $" value={capDollars} onChange={setCapDollars} label="Dollar cap" />}
            {(kind === "risk_cap" || kind === "alloc_contracts") && (
              <Amount mode="numeric" prefix="Capped at" value={kind === "risk_cap" ? riskCap : capContracts} onChange={kind === "risk_cap" ? setRiskCap : setCapContracts} label="Contract cap" />
            )}
          </div>
        </Drawer>
      )}
      {pricingOpen && (
        <SmartPricingModal
          forOpen
          pricing={pricing}
          onApply={(p) => {
            setPricingValue(p);
            setPricingOpen(false);
          }}
          onClose={() => setPricingOpen(false)}
        />
      )}
      {exitOpen && (
        <ExitModal
          exit={exit}
          onApply={(e) => {
            setExit(e);
            setExitOpen(false);
          }}
          onClose={() => setExitOpen(false)}
        />
      )}
    </>
  );
}
