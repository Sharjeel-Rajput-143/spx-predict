"use client";

import { useEffect, useRef, useState } from "react";
import { CHART_TYPES, TIMEFRAMES, type ChartType, type Timeframe } from "@/lib/config";
import { cn } from "@/lib/format";
import { useGame } from "@/components/GameProvider";
import { IconCandle, IconExpand, IconHelp, IconIndicator, IconMoon, IconRefresh, IconSun, IconVolume, IconVolumeOff } from "../icons";
import { SymbolSearch, type SymbolSearchHandle } from "./SymbolSearch";

const ICON_BUTTON =
  "grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const SHORTCUTS: [string, string][] = [
  ["Arrow Up / Arrow Down", "Predict up / down"],
  ["1-9", "Jump to a timeframe"],
  ["/", "Open symbol search"],
];

function Dropdown({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-expanded={open}
        className={ICON_BUTTON}
      >
        {icon}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1.5 min-w-44 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function TimeframeChip({ tf, active, onClick }: { tf: Timeframe; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "shrink-0 rounded-md px-2 py-1 text-xs font-semibold tabular transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        active ? "bg-accent text-white" : "text-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {tf}
    </button>
  );
}

export function Toolbar({
  symbol,
  onSymbolChange,
  timeframe,
  onTimeframeChange,
  chartType,
  onChartTypeChange,
  onOpenIndicators,
  onReset,
  fullscreen,
  onToggleFullscreen,
  symbolSearchRef,
}: {
  symbol: string;
  onSymbolChange: (s: string) => void;
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  chartType: ChartType;
  onChartTypeChange: (c: ChartType) => void;
  onOpenIndicators: () => void;
  onReset: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  symbolSearchRef?: React.Ref<SymbolSearchHandle>;
}) {
  const { theme, toggleTheme, soundEnabled, toggleSound } = useGame();

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-2">
      <div className="flex items-center gap-2">
        <SymbolSearch ref={symbolSearchRef} value={symbol} onChange={onSymbolChange} />

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Dropdown label="Chart type" icon={<IconCandle width={17} height={17} />}>
            {(close) => (
              <>
                {CHART_TYPES.map((c) => (
                  <button
                    key={c.value}
                    onClick={() => {
                      onChartTypeChange(c.value);
                      close();
                    }}
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-surface-2",
                      c.value === chartType && "text-accent",
                    )}
                  >
                    {c.label}
                  </button>
                ))}
              </>
            )}
          </Dropdown>

          <button onClick={onOpenIndicators} aria-label="Indicators" className={ICON_BUTTON}>
            <IconIndicator width={17} height={17} />
          </button>

          <button
            onClick={toggleSound}
            aria-label={soundEnabled ? "Mute sound" : "Enable sound"}
            aria-pressed={soundEnabled}
            className={ICON_BUTTON}
          >
            {soundEnabled ? <IconVolume width={16} height={16} /> : <IconVolumeOff width={16} height={16} />}
          </button>

          <button
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            className={ICON_BUTTON}
          >
            {theme === "dark" ? <IconSun width={16} height={16} /> : <IconMoon width={16} height={16} />}
          </button>

          <button onClick={onToggleFullscreen} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} className={ICON_BUTTON}>
            <IconExpand width={16} height={16} />
          </button>

          <button onClick={onReset} aria-label="Reset chart" className={ICON_BUTTON}>
            <IconRefresh width={16} height={16} />
          </button>

          <Dropdown label="Keyboard shortcuts" icon={<IconHelp width={16} height={16} />}>
            {() => (
              <div className="px-3 py-2">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Shortcuts</div>
                <dl className="flex flex-col gap-1 text-xs">
                  {SHORTCUTS.map(([key, action]) => (
                    <div key={key} className="flex items-center justify-between gap-4">
                      <dt className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">{key}</dt>
                      <dd className="text-muted">{action}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </Dropdown>
        </div>
      </div>

      <div className="flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {TIMEFRAMES.map((t) => (
          <TimeframeChip key={t.value} tf={t.value} active={t.value === timeframe} onClick={() => onTimeframeChange(t.value)} />
        ))}
      </div>
    </div>
  );
}
