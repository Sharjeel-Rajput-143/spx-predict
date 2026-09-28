"use client";

import { useEffect, useState } from "react";
import { IconArrowUp, IconCandle, IconX } from "../icons";

const STORAGE_KEY = "spx-predict:onboarded:v1";

const STEPS = [
  {
    icon: IconCandle,
    title: "This is the chart",
    body: "Candles show SPX price action. Switch symbol, timeframe and chart type from the toolbar above it.",
  },
  {
    icon: null,
    title: "Watch the countdown",
    body: "The dashed OPEN line and highlighted band mark the current 5-minute prediction candle - it's fixed, even if you change the chart's view timeframe.",
  },
  {
    icon: IconArrowUp,
    title: "One tap to predict",
    body: "Call whether this candle closes above or below its open. Guesses lock a few seconds before it closes.",
  },
];

export function OnboardingTip() {
  const [step, setStep] = useState<number | null>(null);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setStep(0);
    } catch {
      /* storage unavailable, skip onboarding */
    }
  }, []);

  const finish = () => {
    setStep(null);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  if (step == null) return null;
  const s = STEPS[step];
  const Icon = s.icon;

  return (
    <div className="fixed inset-x-0 bottom-24 z-40 flex justify-center px-4 xl:bottom-8">
      <div className="animate-pop-in w-full max-w-sm rounded-2xl border border-line bg-surface p-4 shadow-lg">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            {Icon && (
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
                <Icon width={15} height={15} />
              </span>
            )}
            <h3 className="text-sm font-semibold">{s.title}</h3>
          </div>
          <button onClick={finish} aria-label="Skip onboarding" className="text-muted hover:text-fg">
            <IconX width={14} height={14} />
          </button>
        </div>
        <p className="mt-2 text-sm text-muted">{s.body}</p>
        <div className="mt-3 flex items-center justify-between">
          <div className="flex gap-1">
            {STEPS.map((_, i) => (
              <span key={i} className={`h-1.5 w-1.5 rounded-full ${i === step ? "bg-accent" : "bg-surface-2"}`} />
            ))}
          </div>
          <button
            onClick={() => (step < STEPS.length - 1 ? setStep(step + 1) : finish())}
            className="rounded-lg bg-fg px-3 py-1.5 text-xs font-semibold text-bg hover:brightness-110"
          >
            {step < STEPS.length - 1 ? "Next" : "Got it"}
          </button>
        </div>
      </div>
    </div>
  );
}
