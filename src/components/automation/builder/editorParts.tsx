"use client";

import { useState, type ReactNode } from "react";
import { Drawer, InfoTip, Modal, buttonClass, inputClass } from "../bot/primitives";
import { TRADE_OPS, describeFinals, validateClosePricing, type CloseSpeed, type ClosePricing, type TradeOp } from "@/lib/automation/closePricing";
import type { BotContext } from "../bot/BotDetail";
import type { BotInputs } from "@/lib/automation/types";

/** Pieces shared by the editors behind a built-in flow's nodes (see LiveNodeEditors.tsx and OpenPositionEditor.tsx). */

type Direction = "bullish" | "bearish";
export type { Direction };

/** The bot's saved inputs with some values replaced; `hours: null` returns it to the default window. */
export function inputsWith(config: NonNullable<BotContext["data"]["config"]>, changes: Omit<Partial<BotInputs>, "hours"> & { hours?: { start: string; end: string } | null }): Record<string, unknown> {
  const { id: _id, ...base } = config;
  const next: Record<string, unknown> = { ...base, ...changes };
  if (changes.hours === null) delete next.hours;
  return next;
}

export const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

export function Shell({ title, ctx, onClose, footer, children }: { title: string; ctx: BotContext; onClose: () => void; footer?: ReactNode; children: ReactNode }) {
  return (
    <Drawer title={title} onClose={onClose} footer={footer}>
      <div className="space-y-5">
        {children}
      </div>
    </Drawer>
  );
}

export function NeedsInputs({ ctx, onClose }: { ctx: BotContext; onClose: () => void }) {
  return (
    <Drawer title="Not set up yet" onClose={onClose} footer={<button className={`${buttonClass.secondary} w-full`} onClick={onClose}>Close</button>}>
      <p className="text-sm text-muted">{ctx.data.bot.configError ?? "This bot has no trading inputs yet."} Set them first under Settings &gt; Bot inputs; then this step can be edited here.</p>
    </Drawer>
  );
}

export const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-2/60 px-3 py-2 text-sm">
    <span className="text-muted">{label}</span>
    <span className="font-medium">{value}</span>
  </div>
);

const SPEEDS: { speed: CloseSpeed; label: string }[] = [
  { speed: "normal", label: "Normal - up to 4 prices, 10 seconds each" },
  { speed: "fast", label: "Fast - up to 3 prices, 5 seconds each" },
  { speed: "patient", label: "Patient - up to 5 prices, 20 seconds each" },
  { speed: "off", label: "Off - 1 limit price" },
  { speed: "market", label: "Market - send a market order" },
];

/** Option Alpha's SmartPricing dialog for a close: the speed, and the final price(s) - the worst price the bot will pay. Tick several and the best is used. */
export function SmartPricingModal({ pricing, onApply, onClose, forOpen }: { pricing: ClosePricing; onApply: (p: ClosePricing) => void; onClose: () => void; /** An opening order: always a limit price (no Market), and there is no position trade price yet. */ forOpen?: boolean }) {
  const [speed, setSpeed] = useState<CloseSpeed>(pricing.speed);
  const [percentOn, setPercentOn] = useState(pricing.percent !== undefined);
  const [percent, setPercent] = useState(String(pricing.percent ?? 100));
  const [slipOn, setSlipOn] = useState(pricing.slippage !== undefined);
  const [slip, setSlip] = useState(String(pricing.slippage ?? 0.05));
  const [flatOn, setFlatOn] = useState(pricing.flat !== undefined);
  const [flat, setFlat] = useState(pricing.flat !== undefined ? String(pricing.flat) : "");
  const [tradeOn, setTradeOn] = useState(pricing.tradePrice !== undefined);
  const [op, setOp] = useState<TradeOp>(pricing.tradePrice?.op ?? "×");
  const [opValue, setOpValue] = useState(String(pricing.tradePrice?.value ?? 0.5));

  const draft: ClosePricing = {
    speed,
    ...(percentOn ? { percent: num(percent) } : {}),
    ...(slipOn ? { slippage: num(slip) } : {}),
    ...(flatOn ? { flat: num(flat) } : {}),
    ...(tradeOn && !forOpen ? { tradePrice: { op, value: num(opValue) } } : {}),
  };
  const checked = validateClosePricing(draft);
  const market = speed === "market" && !forOpen;

  const row = (on: boolean, setOn: (v: boolean) => void, label: string, tip: string, body: ReactNode) => (
    <div className="flex items-center gap-3 text-sm">
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} aria-label={label} className="h-4 w-4 accent-[var(--accent)]" />
      <div className="flex flex-1 flex-wrap items-center gap-2">{body}</div>
      <InfoTip text={tip} />
    </div>
  );
  const small = `${inputClass} !w-24`;

  return (
    <Modal title="SmartPricing" onClose={onClose} footer={<button className={`${buttonClass.primary} px-8`} disabled={!market && !checked.ok} onClick={() => onApply(market && !checked.ok ? { speed: "market" } : (checked as { ok: true; pricing: ClosePricing }).pricing)}>Save</button>}>
      <div className="space-y-5">
        <p className="text-sm text-muted">The bot places timed, limit orders traversing the bid/ask spread to the final price set below.</p>
        <select className={inputClass} value={speed} onChange={(e) => setSpeed(e.target.value as CloseSpeed)} aria-label="SmartPricing">
          {SPEEDS.filter((o) => !forOpen || o.speed !== "market").map((o) => (
            <option key={o.speed} value={o.speed}>
              {o.label}
            </option>
          ))}
        </select>
        {!market && (
          <div className="space-y-3">
            <div className="text-sm font-semibold">Final Price</div>
            <p className="text-sm text-muted">The price for the final order placed by your bot. {forOpen ? "Your minimum price when selling." : "Your max price when buying."} If more than 1 final price option is selected below the best price is used as the final price.</p>
            {row(percentOn, setPercentOn, "% of bid/ask spread", "100% pays the full ask. With a mid of 1.00 and an ask of 1.20, 100% is 1.20 and 50% is 1.10.", (
              <>
                <input className={small} inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} aria-label="Percent of bid/ask" />
                <span>% of bid/ask spread</span>
              </>
            ))}
            {row(slipOn, setSlipOn, "Slippage from mid", "The most the order may move away from the mid price. With a mid of 1.00 and $0.05, the final price is 1.05 (never beyond the ask).", (
              <>
                <span>Up to $</span>
                <input className={small} inputMode="decimal" value={slip} onChange={(e) => setSlip(e.target.value)} aria-label="Slippage from mid" />
                <span>slippage from the mid price</span>
              </>
            ))}
            {row(flatOn, setFlatOn, "Price", "A fixed final price per spread, for example $1.50.", (
              <>
                <span>$</span>
                <input className={small} inputMode="decimal" placeholder="1.50" value={flat} onChange={(e) => setFlat(e.target.value)} aria-label="Price" />
              </>
            ))}
            {!forOpen && row(tradeOn, setTradeOn, "Position trade price", "Worked out from the credit the position was opened for. With a $2.00 credit, × .5 is a final price of $1.00.", (
              <>
                <span>Position trade price</span>
                <select className={`${inputClass} !w-16`} value={op} onChange={(e) => setOp(e.target.value as TradeOp)} aria-label="Operation">
                  {TRADE_OPS.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
                <input className={small} inputMode="decimal" value={opValue} onChange={(e) => setOpValue(e.target.value)} aria-label="Trade price value" />
              </>
            ))}
            {!checked.ok && <p className="text-xs text-down">{checked.reason}</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}

export const priceLabel = (p: ClosePricing) => (p.speed === "market" ? "Market order" : p.percent !== undefined && p.slippage === undefined && p.flat === undefined && !p.tradePrice ? `${p.percent}% of bid/ask` : describeFinals(p));

