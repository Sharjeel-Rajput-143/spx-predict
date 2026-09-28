"use client";

import { useState } from "react";
import type { RoundResult } from "@/lib/types";
import { IconChevron } from "../icons";
import { RecentRounds } from "./Rounds";

type Tab = "recent" | "history";

export function BottomPanel({ results }: { results: RoundResult[] }) {
  const [tab, setTab] = useState<Tab>("recent");
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="rounded-2xl border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <div className="flex gap-1">
          {(["recent", "history"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                "rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors " +
                (tab === t ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")
              }
            >
              {t === "recent" ? "Recent rounds" : "History"}
            </button>
          ))}
        </div>
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand" : "Collapse"}
          className="grid h-6 w-6 place-items-center text-muted hover:text-fg"
        >
          <IconChevron width={14} height={14} className={collapsed ? "" : "rotate-180"} />
        </button>
      </div>
      {!collapsed && (
        <div className="max-h-72 overflow-y-auto p-4 pt-2">
          <RecentRounds results={results} limit={tab === "recent" ? 7 : 30} showHeader={false} />
        </div>
      )}
    </div>
  );
}
