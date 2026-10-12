"use client";

import { useEffect, useState } from "react";
import { IconChevronDown } from "@/components/icons";
import { Btn, Checkbox, Drawer, Dropdown, Field, InfoTip, inputClass, MenuItem, Pill } from "./primitives";
import { DEFAULT_SYMBOL_SETTINGS, loadRecentSymbols, loadSymbolSettings, saveSymbolSettings, type SymbolSettings } from "../builder/store";

const watchlists = (underlying: string) => [`${underlying} only`, "Index options (SPX, XSP, NDX)", "Mega-cap tech", "My watchlist"];
const SORTS = ["None", "Alphabetical", "Price: high to low", "Price: low to high", "Volume: high to low", "IV rank: high to low"];
const LIMITS = ["5 symbols", "10 symbols", "25 symbols", "50 symbols", "100 symbols"];
const POSITION_OPS = ["1 or more", "none", "exactly 1"];
const EARNINGS_WINDOWS = ["7 days", "14 days", "30 days", "45 days"];
const MAX_EXCLUDED = 50;

/** "Bot Symbols": how a scanning bot would build its symbol list. These bots
 * trade their one underlying from webhook signals and don't scan, so the settings are saved
 * with the design (this browser) and the panel says so. */
export function SymbolsPanel({ botId, underlying = "SPX", onSaved, onClose }: { botId: string; underlying?: string; onSaved: (s: SymbolSettings) => void; onClose: () => void }) {
  const [s, setS] = useState<SymbolSettings>(DEFAULT_SYMBOL_SETTINGS);
  const [draftExcluded, setDraftExcluded] = useState("");
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    setS(loadSymbolSettings(botId));
    setRecents(loadRecentSymbols());
  }, [botId]);

  const set = <K extends keyof SymbolSettings>(key: K, value: SymbolSettings[K]) => setS((p) => ({ ...p, [key]: value }));

  const addExcluded = (raw: string) => {
    const incoming = raw
      .toUpperCase()
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (incoming.length === 0) return;
    set("excluded", [...new Set([...s.excluded, ...incoming])].slice(0, MAX_EXCLUDED));
    setDraftExcluded("");
  };

  const save = () => {
    saveSymbolSettings(botId, s);
    onSaved(s);
    onClose();
  };

  const select = (value: string, onChange: (v: string) => void, options: string[], label: string, compact?: boolean) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={compact ? "rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent" : inputClass}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );

  return (
    <Drawer
      title="Bot symbols"
      onClose={onClose}
      wide
      footer={
        <Btn kind="primary" className="w-full"  onClick={save}>
          Save
        </Btn>
      }
    >
      <div className="space-y-6">
        <p className="text-sm text-muted">Your bot will sort and filter the selected watchlist before every scan to produce a list of symbols.</p>
        <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          <Pill tone="warn">Preview</Pill>
          <span>Saved in this browser. The signal engine trades {underlying} from webhook signals and doesn&apos;t scan, so it doesn&apos;t read these yet.</span>
        </div>

        <Field label="Watchlist">
          <select className={inputClass} value={s.watchlist} onChange={(e) => set("watchlist", e.target.value)} aria-label="Watchlist">
            <option value="">Select a watchlist...</option>
            {watchlists(underlying).map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Sort">{select(s.sort, (v) => set("sort", v), SORTS, "Sort")}</Field>

        <div>
          <div className="mb-2 flex items-center text-xs font-medium text-muted">
            Filters <InfoTip text="Each filter removes symbols from the list before the bot looks at them." />
          </div>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Checkbox checked={s.positionsFilter.enabled} onChange={(v) => set("positionsFilter", { ...s.positionsFilter, enabled: v })} label="Bot has" />
              {s.positionsFilter.enabled && select(s.positionsFilter.op, (v) => set("positionsFilter", { ...s.positionsFilter, op: v }), POSITION_OPS, "Position count", true)}
              <span className={s.positionsFilter.enabled ? "" : "text-faint"}>positions with symbol</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Checkbox checked={s.earningsFilter.enabled} onChange={(v) => set("earningsFilter", { ...s.earningsFilter, enabled: v })} label="Earnings or ex-div in the next" />
              {s.earningsFilter.enabled && select(s.earningsFilter.window, (v) => set("earningsFilter", { ...s.earningsFilter, window: v }), EARNINGS_WINDOWS, "Earnings window", true)}
            </div>
          </div>
        </div>

        <Field label="Limit">{select(s.limit, (v) => set("limit", v), LIMITS, "Limit")}</Field>

        <div>
          <div className="mb-1 text-xs font-medium text-muted">Excluded symbols</div>
          <div className="rounded-lg border border-line bg-bg">
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {s.excluded.map((sym) => (
                  <span key={sym} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-xs">
                    {sym}
                    <button onClick={() => set("excluded", s.excluded.filter((x) => x !== sym))} aria-label={`Remove ${sym}`} className="text-faint hover:text-down">
                      ×
                    </button>
                  </span>
                ))}
                <input
                  value={draftExcluded}
                  onChange={(e) => setDraftExcluded(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " " || e.key === ",") {
                      e.preventDefault();
                      addExcluded(draftExcluded);
                    }
                  }}
                  onBlur={() => addExcluded(draftExcluded)}
                  placeholder={s.excluded.length === 0 ? `Enter up to ${MAX_EXCLUDED} symbols separated by space` : ""}
                  aria-label="Excluded symbols"
                  className="min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
                />
              </div>
              <Dropdown
                align="right"
                trigger={({ toggle }) => (
                  <button onClick={toggle} className="flex shrink-0 items-center gap-1 text-xs text-muted hover:text-fg">
                    Recents <IconChevronDown width={12} height={12} />
                  </button>
                )}
              >
                {(close) =>
                  recents.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-muted">No recent symbols yet.</p>
                  ) : (
                    recents.map((r) => (
                      <MenuItem
                        key={r}
                        onClick={() => {
                          close();
                          addExcluded(r);
                        }}
                      >
                        {r}
                      </MenuItem>
                    ))
                  )
                }
              </Dropdown>
            </div>
            <textarea
              value={s.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="(optional)"
              aria-label="Excluded symbols notes"
              rows={3}
              className="w-full resize-y bg-transparent px-3 py-2 text-sm outline-none placeholder:text-faint"
            />
          </div>
          <p className="mt-1 text-[11px] text-faint">
            {s.excluded.length}/{MAX_EXCLUDED} symbols
          </p>
        </div>
      </div>
    </Drawer>
  );
}
