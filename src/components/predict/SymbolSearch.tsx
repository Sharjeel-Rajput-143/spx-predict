"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { TICKERS, getTicker } from "@/lib/config";
import { cn } from "@/lib/format";
import { IconChevron } from "../icons";

export interface SymbolSearchHandle {
  open: () => void;
}

export const SymbolSearch = forwardRef<SymbolSearchHandle, { value: string; onChange: (symbol: string) => void }>(
  function SymbolSearch({ value, onChange }, ref) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const rootRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const ticker = getTicker(value);

    useImperativeHandle(ref, () => ({ open: () => setOpen(true) }));

    useEffect(() => {
      if (!open) return;
      const onDoc = (e: MouseEvent) => {
        if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
      };
      document.addEventListener("mousedown", onDoc);
      return () => document.removeEventListener("mousedown", onDoc);
    }, [open]);

    useEffect(() => {
      if (open) {
        setQuery("");
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }, [open]);

    const filtered = TICKERS.filter((t) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q);
    });

    return (
      <div ref={rootRef} className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm font-semibold transition-colors hover:border-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {ticker.symbol}
          <IconChevron width={14} height={14} className="text-muted" />
        </button>

        {open && (
          <div className="absolute left-0 top-full z-40 mt-1.5 w-72 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search symbol..."
              className="w-full border-b border-line bg-transparent px-3 py-2 text-sm outline-none placeholder:text-faint"
            />
            <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
              {filtered.length === 0 && <li className="px-3 py-4 text-center text-sm text-faint">No matches</li>}
              {filtered.map((t) => (
                <li key={t.symbol}>
                  <button
                    role="option"
                    aria-selected={t.symbol === value}
                    onClick={() => {
                      onChange(t.symbol);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2",
                      t.symbol === value && "bg-surface-2",
                    )}
                  >
                    <span>
                      <span className="font-semibold">{t.symbol}</span>
                      <span className="ml-2 text-muted">{t.name}</span>
                    </span>
                    <span className="text-xs text-faint">{t.exchange}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  },
);
