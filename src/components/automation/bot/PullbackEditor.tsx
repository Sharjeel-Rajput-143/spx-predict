"use client";

import { useState, type ReactNode } from "react";
import { Card } from "@/components/ui";
import { Btn, Field, InfoTip, inputClass, Switch } from "./primitives";

/** The settings the editor shows (what pullbackSettings() returns for the bot). */
export interface PullbackValues {
  enabled: boolean;
  fallUsd: number;
  minPeakUsd: number;
  chainEnabled: boolean;
  chainStopUsd: number;
  chainMax: number;
}

function Stat({ label, tip, children }: { label: ReactNode; tip?: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
        {tip && <InfoTip text={tip} />}
      </div>
      <div className="mt-0.5 text-lg font-medium">{children}</div>
    </div>
  );
}

/** What turning the chain ON means for the live bot, asked once in words before it is sent. */
export const LIVE_CHAIN_WARNING =
  "Turn chain mode ON for the LIVE bot?\n\nAfter a trade is closed by the pullback exit, the bot will open the next trade in the opposite direction by itself, with REAL money. Each chain trade has a stop loss at Bybit, counts in the day's 5 trades, and stops at the $2 daily loss limit.";

/** What "Save numbers" sends: the four numbers as typed, as numbers (the server checks them). */
export function numbersBody(v: { fall: string; minPeak: string; chainStop: string; chainMax: string }): Record<string, unknown> {
  return { fallUsd: Number(v.fall), minPeakUsd: Number(v.minPeak), chainStopUsd: Number(v.chainStop), chainMax: Number(v.chainMax) };
}

/** The chain switch: turning it ON for the LIVE bot is asked first (nothing is sent on a "no"); every other change is sent at once. Returns whether something was sent. */
export function toggleChainAction(args: { pb: PullbackValues; live: boolean; confirm: (text: string) => boolean; save: (body: Record<string, unknown>, text: string) => unknown }): boolean {
  const { pb, live, confirm, save } = args;
  if (live && !pb.chainEnabled && !confirm(LIVE_CHAIN_WARNING)) return false;
  save({ chainEnabled: !pb.chainEnabled }, pb.chainEnabled ? "Chain mode off." : "Chain mode on.");
  return true;
}

/**
 * THE PULLBACK EXIT CARD. One card for both Bybit bots (the demo bot's Settings tab, the live bot's Settings tab and the Live page's Settings tab all draw this one): each bot keeps its OWN
 * saved values, so changing one never changes the other. `save` sends one change for THIS bot. On the live bot, turning the chain ON asks first (`confirm`, the browser's by default).
 */
export function PullbackEditor({ pb, chainRunning, live = false, save, confirm = (text: string) => (typeof window === "undefined" ? false : window.confirm(text)) }: { pb: PullbackValues; chainRunning?: { trades: number } | null; live?: boolean; save: (body: Record<string, unknown>, text: string) => unknown; confirm?: (text: string) => boolean }) {
  const [fall, setFall] = useState(String(pb.fallUsd));
  const [minPeak, setMinPeak] = useState(String(pb.minPeakUsd));
  const [chainStop, setChainStop] = useState(String(pb.chainStopUsd));
  const [chainMax, setChainMax] = useState(String(pb.chainMax));
  const saveNumbers = () => save(numbersBody({ fall, minPeak, chainStop, chainMax }), "Pullback settings saved.");
  const toggleChain = () => void toggleChainAction({ pb, live, confirm, save });
  return (
    <div data-testid="pullback-card">
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          Pullback exit
          <InfoTip text={`While a trade is in profit the bot remembers its best profit (the peak, in dollars on Bybit's mark price). When the profit falls this far below the peak, the bot closes the trade at market (reduce only). The stop loss and take profit stay at Bybit until the close fills. ${live ? "This is the LIVE bot's own copy of the rule: it closes real-money trades, and its values are separate from the demo bot's." : "This is the demo bot's own copy of the rule; the live bot has its own values."}`} />
        </h2>
        {live && <span className="rounded-full bg-down-soft px-2.5 py-1 text-xs font-medium text-down" data-testid="pullback-live-chip">LIVE bot, real money</span>}
      </div>
      <div className="space-y-4">
        <Stat label="Pullback exit" tip="On by default, for each Bybit bot on its own.">
          <Switch on={pb.enabled} onChange={() => save({ enabled: !pb.enabled }, pb.enabled ? "Pullback exit off." : "Pullback exit on.")} label="Pullback exit on/off" />
        </Stat>
        <Field label="Fall from the peak ($)" hint="Dollars of profit on the open position (0.001 BTC, so $0.03 is a $30 move of the BTC price).">
          <input className={inputClass} inputMode="decimal" value={fall} onChange={(e) => setFall(e.target.value)} aria-label="Fall from the peak in dollars" />
        </Field>
        <Field label="Minimum peak ($)" hint="The rule may fire only once the peak is at least this. 0 = no minimum. The default is $0.12.">
          <input className={inputClass} inputMode="decimal" value={minPeak} onChange={(e) => setMinPeak(e.target.value)} aria-label="Minimum peak in dollars" />
        </Field>
        <Stat label="Chain mode" tip="OFF by default. When a trade an alert opened is closed by the pullback exit, the bot opens the next trade at once in the opposite direction, each chain trade watched by the same exit and by a tight chain stop kept by the bot (not by Bybit). A real alert, the cap, the kill switch, the daily loss limit or a bot that is off ends the chain.">
          <Switch on={pb.chainEnabled} onChange={toggleChain} label="Chain mode on/off" />
          {chainRunning && <span className="block text-xs font-normal text-faint">A chain is running: {chainRunning.trades} chain trade(s) so far.</span>}
          {live && <span className="block text-xs font-normal text-faint">On the live bot a chain trade counts in the day&apos;s 5 trades and obeys the $2 daily loss limit, like any live trade.</span>}
        </Stat>
        <Field label="Chain stop ($)" hint="A chain trade is closed when its loss reaches this. Kept by the bot, not by Bybit; Bybit's normal stop stays under it.">
          <input className={inputClass} inputMode="decimal" value={chainStop} onChange={(e) => setChainStop(e.target.value)} aria-label="Chain stop in dollars" />
        </Field>
        <Field label="Most chain trades per alert" hint="The chain ends when this many chain trades have been opened for one alert.">
          <input className={inputClass} inputMode="numeric" value={chainMax} onChange={(e) => setChainMax(e.target.value)} aria-label="Most chain trades per alert" />
        </Field>
        <Btn kind="primary" onClick={saveNumbers}>
          Save numbers
        </Btn>
      </div>
    </Card>
    </div>
  );
}
