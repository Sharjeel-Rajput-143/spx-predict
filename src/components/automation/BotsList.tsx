"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AutomationLogin } from "@/components/automation/AutomationLogin";
import { PageHeader, headerButtonClass } from "@/components/automation/PageHeader";
import { NewBotPanel, type NewBotView } from "@/components/automation/NewBotPanel";
import { Btn, Dropdown, InfoTip, MenuDivider, MenuItem, Pill, Switch, Td, Th } from "@/components/automation/bot/primitives";
import { NO_PRICE_TIP, pctText, plClass, plText } from "@/components/automation/bot/model";
import { IconAutomation, IconChevronDown, IconCopy, IconFolder, IconPlus, IconSearch } from "@/components/icons";
import { Card } from "@/components/ui";
import type { BotSummary } from "@/lib/automation/summary";
import type { BotTemplate } from "@/lib/automation/types";
import { cn } from "@/lib/format";
import { usePolling } from "./usePolling";

const POLL_MS = 5000;
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compactUsd = (n: number) => (n >= 1000 && n % 1000 === 0 ? `$${n / 1000}K` : usd(n));

type SortKey = "name" | "closedPL" | "closedPct" | "pos" | "risk" | "allocation";
const sortValue: Record<SortKey, (b: BotSummary) => number | string> = {
  name: (b) => b.name.toLowerCase(),
  closedPL: (b) => b.closedPL ?? Number.NEGATIVE_INFINITY,
  closedPct: (b) => b.closedPct ?? Number.NEGATIVE_INFINITY,
  pos: (b) => b.activePositionCount,
  risk: (b) => b.atRisk,
  allocation: (b) => b.allocation ?? 0,
};

const hasError = (b: BotSummary) => b.needsAttention || !!b.configError || b.errorCountToday > 0;

export function BotsList() {
  const router = useRouter();
  const [bots, setBots] = useState<BotSummary[] | null>(null);
  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [accounts, setAccounts] = useState<string[]>(["paper-1"]);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const [modes, setModes] = useState<Set<"live" | "paper">>(new Set());
  const [status, setStatus] = useState<"on" | "off" | null>(null);
  const [onlyPosition, setOnlyPosition] = useState(false);
  const [onlyError, setOnlyError] = useState(false);
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [newBot, setNewBot] = useState<{ start?: NewBotView | NewBotView[] } | null>(null);

  const load = useCallback(() => {
    return fetch("/api/automation/bots")
      .then((r) => {
        if (r.status === 401) {
          setSignedOut(true);
          return null;
        }
        if (!r.ok) throw new Error("Failed to load.");
        return r.json();
      })
      .then((json: { bots: BotSummary[]; templates: BotTemplate[]; accounts: string[] } | null) => {
        if (!json) return;
        setSignedOut(false);
        setBots(json.bots);
        setTemplates(json.templates);
        setAccounts(json.accounts);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, []);

  usePolling(load, POLL_MS);

  // /automations?newFromTemplate=<id> (from the Templates page) opens New Bot at that template's form.
  const [deepLinked, setDeepLinked] = useState(false);
  useEffect(() => {
    if (deepLinked || !bots) return;
    setDeepLinked(true);
    const id = new URLSearchParams(window.location.search).get("newFromTemplate");
    const t = id ? templates.find((x) => x.id === id) : undefined;
    if (t) {
      setNewBot({
        start: [
          { name: "menu" },
          { name: "templates" },
          { name: "form", mode: "template", templateId: t.id, initial: { name: "", accountId: t.config.accountId, allocation: String(t.safeguards?.allocationLimit ?? t.config.allocationLimit) } },
        ],
      });
      window.history.replaceState(null, "", "/automations");
    }
  }, [bots, templates, deepLinked]);

  const toggle = (id: string) => {
    setPending(id);
    fetch(`/api/automation/bots/${id}/toggle`, { method: "POST" })
      .then(load)
      .finally(() => setPending(null));
  };

  const allTags = useMemo(() => [...new Set((bots ?? []).flatMap((b) => b.tags))].sort(), [bots]);
  const allGroups = useMemo(() => [...new Set((bots ?? []).map((b) => b.group).filter((g): g is string => !!g))].sort(), [bots]);

  const visible = useMemo(() => {
    if (!bots) return [];
    const q = query.trim().toLowerCase();
    return bots
      .filter((b) => (showArchived ? b.archived : !b.archived))
      .filter((b) => modes.size === 0 || modes.has(b.mode))
      .filter((b) => status === null || (status === "on" ? b.enabled : !b.enabled))
      .filter((b) => !onlyPosition || b.activePositionCount > 0)
      .filter((b) => !onlyError || hasError(b))
      .filter((b) => tags.size === 0 || [...tags].every((t) => b.tags.includes(t)))
      .filter((b) => group === null || b.group === group)
      .filter((b) => !q || b.name.toLowerCase().includes(q) || b.id.toLowerCase().includes(q))
      .sort((a, b) => {
        const av = sortValue[sort.key](a);
        const bv = sortValue[sort.key](b);
        return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
      });
  }, [bots, query, modes, status, onlyPosition, onlyError, tags, group, showArchived, sort]);

  if (error) return <Card className="p-4 text-sm text-down">{error}</Card>;

  const ready = !!bots && !signedOut;
  const sum = (f: (b: BotSummary) => number) => visible.reduce((n, b) => n + f(b), 0);
  const pricedBots = visible.filter((b) => b.closedPL != null);
  const totalPL = pricedBots.length ? pricedBots.reduce((n, b) => n + (b.closedPL ?? 0), 0) : null;
  const pricedAllocation = pricedBots.reduce((n, b) => n + (b.allocation ?? 0), 0);
  const totalPct = totalPL != null && pricedAllocation > 0 ? totalPL / pricedAllocation : null;

  const show = (node: React.ReactNode) => (ready ? node : "--");
  const tiles: { label: string; value: React.ReactNode; tip?: string }[] = [
    { label: "Closed P/L", value: show(<span className={plClass(totalPL)}>{plText(totalPL)}</span>), tip: NO_PRICE_TIP },
    { label: "Closed %", value: show(<span className={plClass(totalPct)}>{pctText(totalPct)}</span>), tip: "Closed P/L as a share of the allocation of the bots that have priced closes." },
    { label: "Change", value: show("—"), tip: "Unrealized change needs live option prices, which Phase 1 doesn't have." },
    { label: "Change %", value: show("—"), tip: "Unrealized change needs live option prices, which Phase 1 doesn't have." },
    { label: "Risk", value: show(usd(sum((b) => b.atRisk))), tip: "Maximum loss on open positions: (width - credit) x 100 x quantity." },
    { label: "Allocation", value: show(usd(sum((b) => b.allocation ?? 0))) },
  ];

  const archivedCount = (bots ?? []).filter((b) => b.archived).length;
  const activeCount = (bots ?? []).filter((b) => !b.archived).length;

  const toggleIn = <T,>(set: Set<T>, v: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    apply(next);
  };
  const setSortKey = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "name" ? 1 : -1 }));

  const SortTh = ({ k, label, right }: { k: SortKey; label: string; right?: boolean }) => (
    <Th right={right}>
      <button onClick={() => setSortKey(k)} className="uppercase tracking-wide hover:text-fg">
        {label} {sort.key === k && <span className="text-accent">{sort.dir === 1 ? "▲" : "▼"}</span>}
      </button>
    </Th>
  );

  const chip = (active: boolean, onClick: () => void, label: string, extra?: string) => (
    <button
      aria-pressed={active}
      onClick={onClick}
      title={extra}
      className={cn("px-3.5 py-2 text-sm transition-colors", active ? "bg-accent/10 text-accent" : "bg-surface text-muted hover:text-fg")}
    >
      {label}
    </button>
  );
  const single = (active: boolean, onClick: () => void, label: string) => (
    <div className="inline-flex overflow-hidden rounded-lg border border-line">{chip(active, onClick, label)}</div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Automation"
        actions={
          <>
            <Link href="/automation/status" className={headerButtonClass}>
              Testing
            </Link>
            {/* The older indicator-rule feature (/automations/rules) is left in the code and still opens at its URL, but the
                NDX system's pages only show the webhook-driven bullish and bearish bot, so it isn't linked from here. */}
            <LibraryMenu />
            <Btn kind="primary" className="flex items-center gap-1.5"  onClick={() => setNewBot({})}>
              <IconPlus width={14} height={14} /> New Bot
            </Btn>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex divide-x divide-line overflow-hidden rounded-lg border border-line">
          {chip(modes.has("live"), () => toggleIn(modes, "live", setModes), "Live", "No live broker is connected - Phase 1 uses a mock executor")}
          {chip(modes.has("paper"), () => toggleIn(modes, "paper", setModes), "Paper")}
        </div>
        <div className="inline-flex divide-x divide-line overflow-hidden rounded-lg border border-line">
          {chip(status === "on", () => setStatus(status === "on" ? null : "on"), "On")}
          {chip(status === "off", () => setStatus(status === "off" ? null : "off"), "Off")}
        </div>
        {single(onlyPosition, () => setOnlyPosition((v) => !v), "Position")}
        {single(onlyError, () => setOnlyError((v) => !v), "Error")}

        <Dropdown
          trigger={({ toggle: t }) => (
            <button onClick={t} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm text-muted hover:text-fg">
              Tags <IconChevronDown width={14} height={14} />
            </button>
          )}
        >
          {() =>
            allTags.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted">No tags yet. Add some on a bot&apos;s dashboard.</p>
            ) : (
              allTags.map((t) => (
                <label key={t} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-2">
                  <input type="checkbox" checked={tags.has(t)} onChange={() => toggleIn(tags, t, setTags)} className="accent-[var(--accent)]" />
                  {t}
                </label>
              ))
            )
          }
        </Dropdown>

        {[...tags].map((t) => (
          <FilterChip key={`t-${t}`} label={`Tag: ${t}`} onRemove={() => toggleIn(tags, t, setTags)} />
        ))}
        {group && <FilterChip label={`Group: ${group}`} onRemove={() => setGroup(null)} />}
        {showArchived && <FilterChip label="Archived" onRemove={() => setShowArchived(false)} />}

        <Dropdown
          trigger={({ toggle: t }) => (
            <button onClick={t} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm text-muted hover:text-fg">
              Bot Group <IconChevronDown width={14} height={14} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem onClick={() => { setGroup(null); close(); }}>All groups</MenuItem>
              {allGroups.map((g) => (
                <MenuItem key={g} onClick={() => { setGroup(g); close(); }}>
                  {g}
                </MenuItem>
              ))}
              <MenuDivider />
              <MenuItem onClick={() => { setShowArchived((v) => !v); close(); }}>{showArchived ? "Hide archived bots" : `Show archived bots (${archivedCount})`}</MenuItem>
            </>
          )}
        </Dropdown>

        <div className="relative ml-auto w-full sm:w-60">
          <IconSearch width={16} height={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Bot name..."
            aria-label="Search bots"
            className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm outline-none focus:border-fg"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-line bg-surface px-5 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
              {t.label}
              {t.tip && <InfoTip text={t.tip} />}
            </div>
            <div className="tabular mt-1.5 text-xl font-semibold">{t.value}</div>
          </div>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line">
                <Th>Icon</Th>
                <SortTh k="name" label="Bot" />
                <SortTh k="closedPL" label="Closed P/L" right />
                <SortTh k="closedPct" label="Closed %" right />
                <Th right>Change</Th>
                <Th right>Change %</Th>
                <SortTh k="pos" label="Pos" right />
                <SortTh k="risk" label="Risk" right />
                <SortTh k="allocation" label="Allocation" right />
                <Th right>Autos</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((b) => (
                <tr
                  key={b.id}
                  onClick={() => router.push(`/automation/bots/${b.id}`)}
                  className="cursor-pointer border-b border-line last:border-b-0 hover:bg-surface-2/60"
                >
                  <Td>
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent/10 text-accent">
                      <IconAutomation width={18} height={18} />
                    </span>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <Link href={`/automation/bots/${b.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:text-accent">
                        {b.name}
                      </Link>
                      {b.needsAttention && <Pill tone="error">Needs attention</Pill>}
                      {!b.needsAttention && b.configError && <Pill tone="warn">Setup needed</Pill>}
                      {b.archived && <Pill>Archived</Pill>}
                    </div>
                    {(b.group || b.tags.length > 0) && (
                      <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-faint">
                        {b.group && <span>{b.group}</span>}
                        {b.tags.map((t) => (
                          <span key={t}>#{t}</span>
                        ))}
                      </div>
                    )}
                  </Td>
                  <Td right className={plClass(b.closedPL)}>{b.closedPL != null ? plText(b.closedPL) : "--"}</Td>
                  <Td right className={plClass(b.closedPct)}>{b.closedPct != null ? pctText(b.closedPct) : "--"}</Td>
                  <Td right className="text-faint">--</Td>
                  <Td right className="text-faint">--</Td>
                  <Td right>
                    {b.activePositionCount > 0 ? <span className="rounded-md bg-accent/15 px-2 py-0.5 text-accent">{b.activePositionCount}</span> : "--"}
                  </Td>
                  <Td right>{b.atRisk > 0 ? usd(b.atRisk) : "--"}</Td>
                  <Td right>{b.allocation != null ? compactUsd(b.allocation) : "--"}</Td>
                  <Td right>
                    <Switch on={b.enabled} onChange={() => toggle(b.id)} disabled={pending === b.id} label={`${b.name} on/off`} />
                  </Td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-sm text-muted">
                    {!bots ? "Loading..." : signedOut ? "Sign in to see your bots." : "No bots match these filters."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-center text-sm text-muted">
        {ready
          ? `Showing ${visible.length} of ${showArchived ? archivedCount : activeCount} ${showArchived ? "archived" : "active"} bots${!showArchived && archivedCount > 0 ? ` • ${archivedCount} archived` : ""} • orders go to a mock executor in Phase 1`
          : "Orders go to a mock executor in Phase 1"}
      </p>

      {signedOut && (
        <div className="fixed inset-0 z-40 grid place-items-center p-4" role="dialog" aria-modal aria-label="Sign in">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
          <Card className="relative w-full max-w-sm p-6 shadow-2xl">
            <AutomationLogin next="/automations" compact error={new URLSearchParams(window.location.search).has("error")} />
          </Card>
        </div>
      )}

      {newBot && (
        <NewBotPanel
          bots={bots ?? []}
          templates={templates}
          accounts={accounts}
          start={newBot.start}
          onClose={() => setNewBot(null)}
          onCreated={(id) => router.push(`/automation/bots/${id}?tab=settings`)}
        />
      )}
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent">
      {label}
      <button onClick={onRemove} aria-label={`Remove ${label}`} className="hover:opacity-70">
        ×
      </button>
    </span>
  );
}

/** Two plain entries - each is a list page. */
function LibraryMenu() {
  const router = useRouter();
  return (
    <Dropdown
      align="right"
      width="min-w-48"
      trigger={({ toggle }) => (
        <button onClick={toggle} className={cn(headerButtonClass, "flex items-center gap-1.5")}>
          Library <IconChevronDown width={14} height={14} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem onClick={() => { close(); router.push("/automations/templates"); }}>
            <span className="flex items-center gap-2.5">
              <IconCopy width={16} height={16} className="text-muted" /> Templates
            </span>
          </MenuItem>
          <MenuItem onClick={() => { close(); router.push("/automations/library"); }}>
            <span className="flex items-center gap-2.5">
              <IconFolder width={16} height={16} className="text-muted" /> Automations
            </span>
          </MenuItem>
        </>
      )}
    </Dropdown>
  );
}
