"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccountIcon, accountLabel } from "@/components/automation/accounts";
import { IconAutomation, IconChevronDown, IconMore } from "@/components/icons";
import { Card } from "@/components/ui";
import { cn } from "@/lib/format";
import { DashboardTab } from "./DashboardTab";
import { LogTab } from "./LogTab";
import { PositionsTab } from "./PositionsTab";
import { RunModal } from "./RunModal";
import { SettingsTab } from "./SettingsTab";
import { Btn, Dropdown, MenuDivider, MenuItem, Modal, OnOffSwitch, Pill, TextPromptModal, Toasts, type ToastItem } from "./primitives";
import { attentionDetail, outcomeInfo, TYPE_LABEL, type BotDetailData } from "./model";
import { usePolling } from "../usePolling";
import { EXIT_OPTIONS_NOTE, botExitTriggers } from "@/lib/automation/exitOptionsText";

const TABS = ["dashboard", "positions", "log", "settings"] as const;
export type Tab = (typeof TABS)[number];
const POLL_MS = 4000;

export interface BotContext {
  data: BotDetailData;
  reload: () => void;
  notify: (tone: ToastItem["tone"], text: string) => void;
  patch: (body: Record<string, unknown>, okText?: string) => Promise<boolean>;
  navigate: (tab: Tab) => void;
  openRun: (signal?: "bullish" | "bearish") => void;
  /** Jump to the Positions tab with this position's details open. */
  viewPosition: (positionId: string) => void;
  /** The position a "View position" asked for, until the Positions tab has opened it. */
  focusPositionId: string | null;
  clearFocusPosition: () => void;
}

export function BotDetail({ botId, initialTab }: { botId: string; initialTab: string | undefined }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(TABS.includes(initialTab as Tab) ? (initialTab as Tab) : "dashboard");
  const [data, setData] = useState<BotDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [run, setRun] = useState<{ signal?: "bullish" | "bearish" } | null>(null);
  const [prompt, setPrompt] = useState<null | "account" | "group" | "template">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [focusPositionId, setFocusPositionId] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const toastId = useRef(0);

  const notify = useCallback((tone: ToastItem["tone"], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const load = useCallback(() => {
    return fetch(`/api/automation/bots/${botId}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 401 ? "Session expired - refresh the page to sign in again." : r.status === 404 ? "This bot no longer exists." : "Failed to load.");
        return r.json();
      })
      .then((json: BotDetailData) => {
        setData(json);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [botId]);

  usePolling(load, POLL_MS);

  // In-app alerts: when a decision lands that this bot's Activity Alerts cover, toast it.
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.decisions.map((d) => d.id));
    if (seen.current === null) {
      seen.current = ids; // first load: everything already there is old news
      return;
    }
    const positions = new Map(data.positions.map((p) => [p.id, p]));
    for (const d of [...data.decisions].reverse()) {
      if (seen.current.has(d.id)) continue;
      const { tone, label } = outcomeInfo(d.outcome);
      const kind = d.outcome === "opened" ? "open" : d.outcome === "closed" ? "close" : tone === "error" ? "error" : tone === "warn" ? "warning" : null;
      if (!kind || !data.bot.alerts[kind]) continue;
      const posId = d.detail?.positionId as string | undefined;
      const pos = posId ? positions.get(posId) : undefined;
      const what = pos ? ` - ${TYPE_LABEL[pos.type]} ${pos.shortStrike}/${pos.longStrike}` : "";
      notify(tone === "ok" ? "ok" : tone === "error" ? "error" : "warn", `${label}${what}`);
    }
    seen.current = ids;
  }, [data, notify]);

  const navigate = (next: Tab) => {
    setTab(next);
    window.history.replaceState(null, "", `?tab=${next}`);
  };

  const patch = useCallback(
    async (body: Record<string, unknown>, okText?: string) => {
      const res = await fetch(`/api/automation/bots/${botId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        notify("error", json.error ?? "Could not save.");
        return false;
      }
      if (okText) notify("ok", okText);
      load();
      return true;
    },
    [botId, load, notify],
  );

  const toggle = () => {
    setPending(true);
    fetch(`/api/automation/bots/${botId}/toggle`, { method: "POST" })
      .then(load)
      .finally(() => setPending(false));
  };

  const kill = () => {
    setPending(true);
    fetch(`/api/automation/bots/${botId}/kill`, { method: "POST" })
      .then(load)
      .finally(() => setPending(false));
  };

  const post = async (path: string, body?: unknown) => {
    const res = await fetch(`/api/automation/bots/${botId}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: res.ok, json: await res.json().catch(() => ({})) };
  };

  if (error) return <Card className="p-4 text-sm text-down">{error}</Card>;
  if (!data) return <Card className="p-4 text-sm text-muted">Loading...</Card>;

  const { bot } = data;
  const exitTriggers = botExitTriggers(bot.openSettings);
  const ctx: BotContext = {
    data,
    reload: load,
    notify,
    patch,
    navigate,
    openRun: (signal) => setRun({ signal }),
    viewPosition: (id) => {
      setFocusPositionId(id);
      navigate("positions");
    },
    focusPositionId,
    clearFocusPosition: () => setFocusPositionId(null),
  };
  const tabLabel = (t: Tab) =>
    t === "positions" && data.counts.activePositions > 0 ? (
      <>
        Positions <span className="ml-1.5 rounded-md bg-accent/15 px-1.5 text-[11px] text-accent">{data.counts.activePositions}</span>
      </>
    ) : (
      <span className="capitalize">{t}</span>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent">
            <IconAutomation width={20} height={20} />
          </span>
          <BotSwitcher current={bot} />
          {bot.archived && <Pill>Archived</Pill>}
          {data.limits.dryRun && <Pill tone="warn">Dry run</Pill>}
        </div>

        <div className="grid w-full grid-cols-2 gap-x-2 gap-y-4 sm:flex sm:w-auto sm:items-stretch sm:gap-0 sm:divide-x sm:divide-line">
          <HeaderBox label="Account">
            <Dropdown
              width="min-w-48"
              trigger={({ toggle: t }) => (
                <button onClick={t} className="flex items-center gap-1.5 text-sm font-medium">
                  {bot.accountId && <AccountIcon id={bot.accountId} className="h-5 w-5" />}
                  {bot.accountId ? accountLabel(bot.accountId) : "—"} <IconChevronDown width={14} height={14} className="text-faint" />
                </button>
              )}
            >
              {(close) => (
                <>
                  {data.options.accounts.map((a) => (
                    <MenuItem key={a} onClick={() => { close(); if (a !== bot.accountId) patch({ accountId: a }, `Account set to ${accountLabel(a)}`); }}>
                      <span className="flex items-center gap-2">
                        <AccountIcon id={a} className="h-5 w-5" />
                        {accountLabel(a)} {a === bot.accountId && <span className="text-accent">✓</span>}
                      </span>
                    </MenuItem>
                  ))}
                  <MenuDivider />
                  <MenuItem onClick={() => { close(); setPrompt("account"); }}>New account...</MenuItem>
                </>
              )}
            </Dropdown>
          </HeaderBox>
          <HeaderBox label="Bot group">
            <Dropdown
              width="min-w-48"
              trigger={({ toggle: t }) => (
                <button onClick={t} className="flex items-center gap-1.5 text-sm font-medium">
                  {bot.group ?? "None"} <IconChevronDown width={14} height={14} className="text-faint" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem onClick={() => { close(); patch({ group: null }); }}>None</MenuItem>
                  {data.options.groups.map((g) => (
                    <MenuItem key={g} onClick={() => { close(); patch({ group: g }); }}>
                      {g} {g === bot.group && <span className="text-accent">✓</span>}
                    </MenuItem>
                  ))}
                  <MenuDivider />
                  <MenuItem onClick={() => { close(); setPrompt("group"); }}>New group...</MenuItem>
                </>
              )}
            </Dropdown>
          </HeaderBox>
          <HeaderBox label="Automations">
            <OnOffSwitch on={bot.enabled} onChange={toggle} disabled={pending} label="Bot on/off" />
          </HeaderBox>
          <HeaderBox label="Exit options">
            <span title={exitTriggers.length > 0 ? `On for the ${exitTriggers.join(" and ")} trigger. ${EXIT_OPTIONS_NOTE}` : `Off: no trigger has exit options. ${EXIT_OPTIONS_NOTE}`}>
              <OnOffSwitch on={exitTriggers.length > 0} onChange={() => undefined} disabled label={exitTriggers.length > 0 ? `Exit options on (${exitTriggers.join(", ")})` : "Exit options off"} />
            </span>
          </HeaderBox>
          <HeaderBox label="Kill switch">
            <OnOffSwitch on={!!bot.killSwitch} onChange={kill} disabled={pending} label="Kill switch (blocks every webhook run, closes included)" />
          </HeaderBox>
          <div className="flex items-center sm:pl-4">
            <Dropdown
              align="right"
              width="min-w-60"
              trigger={({ toggle: t }) => (
                <button onClick={t} aria-label="More" className="grid h-9 w-9 place-items-center rounded-lg border border-line text-muted hover:text-fg">
                  <IconMore width={18} height={18} />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem onClick={() => { close(); setRun({}); }}>Run automation</MenuItem>
                  <MenuItem onClick={async () => { close(); const r = await post("/clone"); if (r.ok) { notify("ok", "Cloned - the copy is switched off."); router.push(`/automation/bots/${r.json.bot.id}?tab=settings`); } else notify("error", r.json.error ?? "Could not clone."); }}>
                    Clone bot
                  </MenuItem>
                  <MenuItem onClick={() => { close(); setPrompt("template"); }}>Save as template</MenuItem>
                  <MenuDivider />
                  <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Export data</div>
                  {[
                    ["Everything (JSON)", "kind=all&format=json"],
                    ["Positions (CSV)", "kind=positions&format=csv"],
                    ["Decisions (CSV)", "kind=decisions&format=csv"],
                    ["Signals (CSV)", "kind=signals&format=csv"],
                  ].map(([label, qs]) => (
                    <a key={qs} href={`/api/automation/bots/${botId}/export?${qs}`} onClick={close} className="block rounded-lg px-3 py-2 text-sm hover:bg-surface-2">
                      {label}
                    </a>
                  ))}
                  <MenuDivider />
                  <MenuItem onClick={() => { close(); patch({ archived: !bot.archived }, bot.archived ? "Bot restored." : "Bot archived and switched off."); }}>
                    {bot.archived ? "Unarchive" : "Archive"}
                  </MenuItem>
                  <MenuItem danger disabled={bot.builtIn} onClick={() => { close(); setConfirmDelete(true); }}>
                    Delete{bot.builtIn ? " (built-in)" : ""}
                  </MenuItem>
                  <MenuDivider />
                  <Link href="/settings" onClick={close} className="block rounded-lg px-3 py-2 text-sm hover:bg-surface-2">
                    Webhook setup
                  </Link>
                  <Link href="/automation/status" onClick={close} className="block rounded-lg px-3 py-2 text-sm hover:bg-surface-2">
                    Plain status view
                  </Link>
                </>
              )}
            </Dropdown>
          </div>
        </div>
      </div>

      {bot.needsAttention && (
        <div className="rounded-xl bg-down-soft px-4 py-3 text-sm text-down">
          <span className="font-semibold">Needs attention</span>
          {attentionDetail(bot.needsAttentionReason)}
        </div>
      )}
      {bot.configError && !bot.needsAttention && <SetupBanner error={bot.configError} missing={bot.missingSettings} />}
      {data.mockPricing && (
        <div className="rounded-xl bg-amber-500/10 px-4 py-2.5 text-sm text-amber-500">
          Simulated pricing is on: the mock executor is making up close prices, so every P/L figure here is fictional.
        </div>
      )}

      <div className="flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none] sm:gap-2" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => navigate(t)}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors sm:px-4",
              tab === t ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {tabLabel(t)}
          </button>
        ))}
      </div>

      {tab === "dashboard" && <DashboardTab ctx={ctx} />}
      {tab === "positions" && <PositionsTab ctx={ctx} />}
      {tab === "log" && <LogTab ctx={ctx} />}
      {tab === "settings" && <SettingsTab ctx={ctx} />}

      {run && (
        <RunModal
          botId={botId}
          underlying={data.config?.underlying}
          initialSignal={run.signal}
          lastPrice={data.signals.find((s) => s.status === "accepted")?.price}
          onClose={() => setRun(null)}
          onDone={load}
        />
      )}
      {prompt === "account" && (
        <TextPromptModal title="New account" label="Account name" onClose={() => setPrompt(null)} onSubmit={(v) => { setPrompt(null); patch({ accountId: v }, `Account set to ${v}`); }} />
      )}
      {prompt === "group" && (
        <TextPromptModal title="New bot group" label="Group name" onClose={() => setPrompt(null)} onSubmit={(v) => { setPrompt(null); patch({ group: v }, `Moved to ${v}`); }} />
      )}
      {prompt === "template" && (
        <TextPromptModal
          title="Save as template"
          label="Template name"
          initial={`${bot.name} template`}
          confirmLabel="Save template"
          onClose={() => setPrompt(null)}
          onSubmit={async (v) => {
            setPrompt(null);
            const r = await post("/template", { name: v });
            r.ok ? notify("ok", "Saved to the Library.") : notify("error", r.json.error ?? "Could not save the template.");
          }}
        />
      )}
      {confirmDelete && (
        <Modal
          title="Delete this bot?"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Btn kind="secondary"  onClick={() => setConfirmDelete(false)}>
                Cancel
              </Btn>
              <Btn kind="danger"
                
                onClick={async () => {
                  const res = await fetch(`/api/automation/bots/${botId}`, { method: "DELETE" });
                  const json = await res.json().catch(() => ({}));
                  if (res.ok) router.push("/automations");
                  else {
                    setConfirmDelete(false);
                    notify("error", json.error ?? "Could not delete.");
                  }
                }}
              >
                Delete bot
              </Btn>
            </>
          }
        >
          <p className="text-sm text-muted">
            This permanently removes <span className="font-medium text-fg">{bot.name}</span> and all of its positions, signals and decisions. Archive it instead if you
            only want it out of the way.
          </p>
        </Modal>
      )}

      <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

function HeaderBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1 sm:px-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      {children}
    </div>
  );
}

/** Name with a dropdown to jump to a sibling bot. */
function BotSwitcher({ current }: { current: BotDetailData["bot"] }) {
  const router = useRouter();
  const [bots, setBots] = useState<{ id: string; name: string; archived: boolean }[]>([{ id: current.id, name: current.name, archived: false }]);

  const refresh = () =>
    fetch("/api/automation/bots")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => json && setBots(json.bots));

  return (
    <Dropdown
      width="min-w-60"
      trigger={({ toggle, open }) => (
        <button
          onClick={() => {
            if (!open) refresh();
            toggle();
          }}
          className="flex items-center gap-2 text-left"
          aria-haspopup="menu"
        >
          <span className="text-lg font-semibold">{current.name}</span>
          <IconChevronDown width={16} height={16} className="text-faint" />
        </button>
      )}
    >
      {(close) => (
        <>
          {bots.filter((b) => !b.archived || b.id === current.id).map((b) => (
            <MenuItem
              key={b.id}
              onClick={() => {
                close();
                if (b.id !== current.id) router.push(`/automation/bots/${b.id}`);
              }}
            >
              <span className={b.id === current.id ? "text-accent" : undefined}>{b.name}</span>
            </MenuItem>
          ))}
          <MenuDivider />
          <Link href="/automations" onClick={close} className="block rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-fg">
            All bots
          </Link>
        </>
      )}
    </Dropdown>
  );
}

/** A bot that can't trade yet: a checklist of what's missing, not an alarm. */
function SetupBanner({ error, missing }: { error: string; missing: { key: string; why: string }[] | null }) {
  return (
    <div className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-500">
      <div className="font-semibold">Setup needed — this bot can&apos;t trade yet</div>
      {missing && missing.length > 0 ? (
        <>
          <p className="mt-1 opacity-90">
            Set {missing.length === 1 ? "this value" : `these ${missing.length} values`} in <span className="font-mono">.env.local</span> and restart. They have no defaults on purpose, so nothing is guessed.
          </p>
          <ul className="mt-2 space-y-1">
            {missing.map((m) => (
              <li key={m.key}>
                <span className="font-mono text-xs">{m.key.replace(/^BOT_[A-Z]+_EMA_BIAS_/, "")}</span> <span className="opacity-80">— {m.why}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-1 opacity-90">{error}</p>
      )}
    </div>
  );
}
