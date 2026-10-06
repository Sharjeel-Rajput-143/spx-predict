"use client";

import { Field, inputClass } from "@/components/automation/bot/primitives";
import type { SmartPricingMode } from "@/lib/automation/smartPricing";
import type { BotInputs, BotStaticConfig, BotTemplate, EodSweepMode, StrikePriceSource, StrikeRounding } from "@/lib/automation/types";

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
  strikeRounding: StrikeRounding;
  strikePriceSource: StrikePriceSource;
  openPricePercent: string;
  closePricePercent: string;
  smartPricing: SmartPricingMode;
  eodSweepMode: EodSweepMode;
  /** "HH:MM" New York time; blank = the default (4:05pm). */
  eodSweepTime: string;
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
  strikeRounding: "outward",
  strikePriceSource: "alert",
  openPricePercent: "100",
  closePricePercent: "100",
  smartPricing: "normal",
  eodSweepMode: "estimate",
  eodSweepTime: "",
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
    ...pricingFields(c),
    group: "",
    tags: "",
  };
}

/** Rounding and order-price fields from a saved config (blank = the defaults). */
export function pricingFields(c: Partial<BotStaticConfig> | null | undefined): Pick<BotFormValues, "strikeRounding" | "strikePriceSource" | "openPricePercent" | "closePricePercent" | "smartPricing" | "eodSweepMode" | "eodSweepTime"> {
  return { strikePriceSource: c?.strikePriceSource ?? "alert", eodSweepMode: c?.eodSweepMode ?? "estimate", eodSweepTime: c?.eodSweepTime ?? "", smartPricing: c?.smartPricing ?? "normal", strikeRounding: c?.strikeRounding ?? "outward", openPricePercent: String(c?.openPricePercent ?? 100), closePricePercent: String(c?.closePricePercent ?? 100) };
}

/** Parses a numeric field; empty stays undefined so the server reports it as missing. */
const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

/** The inputs the form edits, laid over `base` so settings the form doesn't show
 * (the option root, price range, sweep time, hours, the underlying) survive an edit. */
export function toInputs(f: BotFormValues, base?: Partial<BotInputs> | null): BotInputs {
  const { id: _id, ...rest } = (base ?? {}) as Partial<BotStaticConfig>;
  return {
    ...rest,
    name: f.name,
    accountId: f.accountId,
    underlying: rest.underlying ?? "SPX",
    quantity: num(f.quantity),
    widthPoints: num(f.widthPoints),
    strikeIncrement: num(f.strikeIncrement),
    putShortOffset: num(f.putShortOffset),
    callShortOffset: num(f.callShortOffset),
    allocationLimit: num(f.allocationLimit),
    openingCreditEstimate: num(f.openingCreditEstimate),
    strikeRounding: f.strikeRounding,
    strikePriceSource: f.strikePriceSource,
    openPricePercent: num(f.openPricePercent),
    closePricePercent: num(f.closePricePercent),
    smartPricing: f.smartPricing,
    eodSweepMode: f.eodSweepMode,
    // Blank = the default sweep time; an empty string is never saved.
    ...(f.eodSweepTime.trim() ? { eodSweepTime: f.eodSweepTime.trim() } : { eodSweepTime: undefined }),
  } as BotInputs;
}

/** The strike/size inputs, shared by "New bot" and the Bot Inputs editor. */
export function InputFields({ f, set, columns = 3 }: { f: BotFormValues; set: (key: keyof BotFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void; columns?: 2 | 3 }) {
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
            <Field label="Short put offset" hint="Required. Signed points from the signal price; decimals are fine (e.g. -0.01).">
              <input className={inputClass} inputMode="decimal" value={f.putShortOffset} onChange={set("putShortOffset")} placeholder="required" />
            </Field>
            <Field label="Short call offset" hint="Required. Signed points from the signal price; decimals are fine (e.g. -0.01).">
              <input className={inputClass} inputMode="decimal" value={f.callShortOffset} onChange={set("callShortOffset")} placeholder="required" />
            </Field>
            <Field label="Expected credit" hint="Required. Per spread; used for the order limit and risk checks.">
              <input className={inputClass} inputMode="decimal" value={f.openingCreditEstimate} onChange={set("openingCreditEstimate")} placeholder="required" />
            </Field>
            <Field label="Strike rounding" hint="Out of the money: the put rounds down, the call rounds up. (To verify against Option Alpha.)">
              <select className={inputClass} value={f.strikeRounding} onChange={set("strikeRounding")}>
                <option value="outward">Out of the money</option>
                <option value="nearest">Nearest strike</option>
              </select>
            </Field>
            <Field label="Strike price from" hint="Which price the strikes are built from. Alert price (default): the price TradingView sent. Live quote: a quote taken when the Open step runs - use it only once a real-time quote source is connected (the Tradier sandbox's quotes are about 15 minutes delayed). With no fresh quote the bot refuses to open. The log always says which was used, the price and its age.">
              <select className={inputClass} value={f.strikePriceSource} onChange={set("strikePriceSource")}>
                <option value="alert">Alert price</option>
                <option value="live">Live quote: do not use until a real time quote source is connected</option>
              </select>
            </Field>
            <Field label="Final price to open (%)" hint="How far across the bid/ask the last price of the ladder reaches: 0% is the mid, 100% is the full bid/ask. Each earlier price steps toward it.">
              <input className={inputClass} inputMode="decimal" value={f.openPricePercent} onChange={set("openPricePercent")} />
            </Field>
            <Field label="Final price to close (%)" hint="The same for closing: where the ladder ends, as a percent of the way from the mid to the bid/ask.">
              <input className={inputClass} inputMode="decimal" value={f.closePricePercent} onChange={set("closePricePercent")} />
            </Field>
            <Field label="SmartPricing" hint="Normal: up to 4 prices, 10s each, from the mid toward the final price. Fast: 3 x 5s. Patient: 5 x 20s. Off: one limit order at the final price. Needs live quotes - the mock has none.">
              <select className={inputClass} value={f.smartPricing} onChange={set("smartPricing")}>
                <option value="normal">Normal</option>
                <option value="fast">Fast</option>
                <option value="patient">Patient</option>
                <option value="off">Off</option>
              </select>
            </Field>
            <Field label="End-of-day sweep" hint="What happens to a position still held at the sweep time. Estimate: it expires and its P/L is worked out from the underlying's price. Market: a market close order is sent. Manual: it expires and you enter the P/L.">
              <select className={inputClass} value={f.eodSweepMode} onChange={set("eodSweepMode")}>
                <option value="estimate">Estimate P/L from the underlying</option>
                <option value="market">Close at market</option>
                <option value="manual">Enter the P/L by hand</option>
              </select>
            </Field>
            <Field label="Sweep time (ET)" hint="HH:MM New York time, about ten minutes before the series closes (NDX options stop at 4:15pm, so 16:05). Blank = 16:05.">
              <input className={inputClass} value={f.eodSweepTime} onChange={set("eodSweepTime")} placeholder="16:05" />
            </Field>
            <Field label="Allocation ($)">
              <input className={inputClass} inputMode="decimal" value={f.allocationLimit} onChange={set("allocationLimit")} />
            </Field>
          </div>
        </div>
  );
}
