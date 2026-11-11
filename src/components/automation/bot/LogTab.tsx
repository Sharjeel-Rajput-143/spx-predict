"use client";

import { useMemo, useState } from "react";
import { IconInfo, IconSearch } from "@/components/icons";
import { Card } from "@/components/ui";
import { cn } from "@/lib/format";
import type { Decision, Run, Signal } from "@/lib/automation/types";
import type { BotContext } from "./BotDetail";
import { Btn, DirectionTag, Drawer, KeyValue, Modal, Pill } from "./primitives";
import { ORIGIN_LABEL, originLabel, signalOrigin } from "@/lib/automation/origin";
import { RunTrace } from "./RunTrace";
import { systemEntryLabel } from "./btcWording";
import { etDateTime, etDayKey, etTime, groupByDay, num, outcomeInfo, type Tone } from "./model";

type DateFilter = "all" | "today" | "yesterday" | "7d";
type TimeFilter = "all" | "market" | "outside";
type TypeFilter = "all" | "tradingview" | "test_hook" | "manual" | "system" | "rejected";

/** A row in the log: a signal and what the engine did with it, or a decision
 * with no signal behind it (a position placed or closed by hand). */
interface Entry {
  key: string;
  at: number;
  signal: Signal | null;
  /** In the order the engine logged them (oldest first). */
  decisions: Decision[];
  /** The step-by-step record, when the engine kept one (entries from before that don't have it). */
  run?: Run;
}

const PROCESSING_WINDOW_MS = 3 * 60_000;

/** Why a call was refused, in words (the stored reason is a short code). */
const REJECT_WORDS: Record<string, string> = {
  alert_text_mismatch: "the alert's text doesn't match this webhook's direction",
  alert_text_missing: "the alert's text doesn't say this webhook's direction",
  webhook_rate_limited: "called again within a minute",
  no_price: "no live price",
};
const rejectWords = (code: string | undefined | null) => (code ? (REJECT_WORDS[code] ?? code) : "unknown");

const isManualSignal = (s: Signal) => signalOrigin(s) === "manual";

/** Things the system did on its own, with no signal behind them: named for what they are, not "Manual position". */
const SYSTEM_ENTRY: Record<string, string> = {
  eod_sweep: "End-of-day sweep",
  webhook_attached: "Webhook settings",
  webhook_changed: "Webhook settings",
  webhook_detached: "Webhook settings",
  error_failsafe: "Error failsafe",
  run_interrupted: "Run interrupted",
  monitor_closed: "Close Monitor",
};
/** What an entry with no signal and no person behind it is called: the fixed names above, or how a BTC trade ended (Take profit, Stop loss, Breakeven stop, ...). */
const systemName = (e: Entry): string | null => (e.signal || !e.decisions[0] ? null : (SYSTEM_ENTRY[e.decisions[0].outcome] ?? systemEntryLabel(e.decisions[0])));
const isSystemEntry = (e: Entry): boolean => systemName(e) !== null;

const automationName = (e: Entry): string => {
  if (!e.signal) {
    const system = systemName(e);
    if (system) return system;
    return e.decisions[0]?.outcome === "closed" || e.decisions[0]?.reason.toLowerCase().includes("close") ? "Manual close" : "Manual position";
  }
  const label = e.signal.signal === "bullish" ? "Bullish signal" : e.signal.signal === "bearish" ? "Bearish signal" : e.signal.signal || "Signal";
  return isManualSignal(e.signal) ? `${label} (manual run)` : label;
};

function tonesOf(e: Entry): Set<Tone> {
  const tones = new Set<Tone>(e.decisions.map((d) => outcomeInfo(d.outcome).tone));
  if (e.signal?.status === "rejected") tones.add("error");
  return tones;
}

/** Minutes after midnight in New York. */
function etMinutes(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

export function LogTab({ ctx }: { ctx: BotContext }) {
  const { data, reload, notify, navigate } = ctx;
  const [date, setDate] = useState<DateFilter>("all");
  const [time, setTime] = useState<TimeFilter>("all");
  const [type, setType] = useState<TypeFilter>("all");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [onlyWarnings, setOnlyWarnings] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const cleared = data.bot.logClearedAt;

  const entries = useMemo<Entry[]>(() => {
    const byDecision = new Map<string, Decision[]>();
    const orphans: Decision[] = [];
    // data.decisions is newest-first; reverse so each entry's list reads in logged order.
    for (const d of [...data.decisions].reverse()) {
      if (!d.signalId) orphans.push(d);
      else byDecision.set(d.signalId, [...(byDecision.get(d.signalId) ?? []), d]);
    }
    const runById = new Map(data.runs.map((r) => [r.id, r]));
    const fromSignals: Entry[] = data.signals.map((s) => ({ key: s.id, at: s.receivedAt, signal: s, decisions: byDecision.get(s.id) ?? [], run: runById.get(s.id) }));
    const fromOrphans: Entry[] = orphans.map((d) => ({ key: d.id, at: d.createdAt, signal: null, decisions: [d], run: runById.get(String(d.detail?.runId ?? "")) }));
    return [...fromSignals, ...fromOrphans].filter((e) => e.at > cleared).sort((a, b) => b.at - a.at);
  }, [data.signals, data.decisions, data.runs, cleared]);

  const visible = useMemo(() => {
    const today = etDayKey(data.now);
    const yesterday = etDayKey(data.now - 86_400_000);
    const weekAgo = data.now - 7 * 86_400_000;
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (date === "today" && etDayKey(e.at) !== today) return false;
      if (date === "yesterday" && etDayKey(e.at) !== yesterday) return false;
      if (date === "7d" && e.at < weekAgo) return false;
      if (time !== "all") {
        const m = etMinutes(e.at);
        const inMarket = m >= 9 * 60 + 35 && m <= 15 * 60 + 55;
        if ((time === "market") !== inMarket) return false;
      }
      if (type === "manual" && !(e.signal === null ? !isSystemEntry(e) : isManualSignal(e.signal))) return false;
      if (type === "system" && !isSystemEntry(e)) return false;
      if ((type === "tradingview" || type === "test_hook") && (e.signal === null || signalOrigin(e.signal) !== type)) return false;
      if (type === "rejected" && e.signal?.status !== "rejected") return false;
      const tones = tonesOf(e);
      if (onlyErrors && !tones.has("error")) return false;
      if (onlyWarnings && !tones.has("warn")) return false;
      if (q && !automationName(e).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, date, time, type, onlyErrors, onlyWarnings, query, data.now]);

  const groups = groupByDay(visible, (e) => e.at, data.now);
  const selectedEntry = entries.find((e) => e.key === selected);

  const clearLog = async () => {
    setConfirmClear(false);
    const res = await fetch(`/api/automation/bots/${data.bot.id}/log`, { method: "DELETE" });
    if (res.ok) notify("ok", "Log cleared. The data is kept - export still includes it.");
    else notify("error", "Could not clear the log.");
    reload();
  };

  const deleteEntry = async (key: string) => {
    if (!window.confirm("Delete this log entry from the records? The signal, its decisions and its run are removed for good.")) return;
    const res = await fetch(`/api/automation/bots/${data.bot.id}/log/${encodeURIComponent(key)}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (res.ok) notify("ok", "Log entry deleted.");
    else notify("error", j.error ?? "Could not delete the log entry.");
    reload();
  };

  const select = (value: string, onChange: (v: string) => void, label: string, options: [string, string][]) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-fg">
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
  const chip = (active: boolean, onClick: () => void, label: string) => (
    <button
      aria-pressed={active}
      onClick={onClick}
      className={cn("rounded-lg border px-3 py-2 text-sm transition-colors", active ? "border-accent bg-accent/10 text-accent" : "border-line bg-surface text-muted hover:text-fg")}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {select(date, (v) => setDate(v as DateFilter), "Date", [["all", "Date: all"], ["today", "Today"], ["yesterday", "Yesterday"], ["7d", "Last 7 days"]])}
        {select(time, (v) => setTime(v as TimeFilter), "Time", [["all", "Time: all"], ["market", "Market hours"], ["outside", "Outside market hours"]])}
        {select(type, (v) => setType(v as TypeFilter), "Type", [["all", "Type: all"], ["tradingview", "TradingView"], ["test_hook", "Test Hook"], ["manual", "Manual"], ["system", "System"], ["rejected", "Rejected"]])}
        {chip(onlyErrors, () => setOnlyErrors((v) => !v), "Errors")}
        {chip(onlyWarnings, () => setOnlyWarnings((v) => !v), "Warnings")}
        <div className="relative">
          <IconSearch width={16} height={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Automation name..."
            aria-label="Search by automation name"
            className="w-52 rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm outline-none focus:border-fg"
          />
        </div>
        <Btn kind="secondary" className="ml-auto"  onClick={() => setConfirmClear(true)} disabled={entries.length === 0}>
          Clear log
        </Btn>
      </div>

      <Card className="overflow-hidden">
        <div className="hidden grid-cols-[110px_270px_minmax(0,1fr)] gap-x-4 border-b border-line px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-faint lg:grid">
          <span>Time</span>
          <span>Automation</span>
          <span>Info</span>
        </div>
        {groups.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            {cleared && entries.length === 0 ? "Log cleared." : data.signals.length === 0 && data.decisions.length === 0 ? "No signals received yet." : "Nothing matches these filters."}
          </p>
        ) : (
          groups.map(([label, rows]) => (
            <div key={label}>
              <div className="border-b border-line bg-surface-2/60 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
              {rows.map((e) => (
                <LogRow key={e.key} entry={e} now={data.now} onOpen={() => setSelected(e.key)} onAutomation={() => navigate("settings")} onDelete={() => deleteEntry(e.key)} />
              ))}
            </div>
          ))
        )}
      </Card>
      <p className="text-xs text-faint">Times in New York · newest first</p>

      {selectedEntry?.run ? (
        <RunTrace
          run={selectedEntry.run}
          positionExists={(id) => data.positions.some((p) => p.id === id)}
          onViewPosition={(id) => {
            setSelected(null);
            ctx.viewPosition(id);
          }}
          onAutomation={() => {
            setSelected(null);
            navigate("settings");
          }}
          onClose={() => setSelected(null)}
        />
      ) : (
        selectedEntry && <TraceDrawer entry={selectedEntry} onClose={() => setSelected(null)} />
      )}
      {confirmClear && (
        <Modal
          title="Clear the log?"
          onClose={() => setConfirmClear(false)}
          footer={
            <>
              <Btn kind="secondary"  onClick={() => setConfirmClear(false)}>
                Cancel
              </Btn>
              <Btn kind="primary"  onClick={clearLog}>
                Clear log
              </Btn>
            </>
          }
        >
          <p className="text-sm text-muted">
            This hides everything so far from the Log. Nothing is deleted: the engine still remembers earlier signals for duplicate protection, and
            Export data still includes them.
          </p>
        </Modal>
      )}
    </div>
  );
}

function LogRow({ entry, now, onOpen, onAutomation, onDelete }: { entry: Entry; now: number; onOpen: () => void; onAutomation: () => void; onDelete: () => void }) {
  const { signal, decisions } = entry;
  const opened = decisions.filter((d) => d.outcome === "opened").length;
  const closed = decisions.filter((d) => d.outcome === "closed").length;
  const errors = decisions.filter((d) => outcomeInfo(d.outcome).tone === "error");
  const others = decisions.filter((d) => d.outcome !== "opened" && d.outcome !== "closed" && outcomeInfo(d.outcome).tone !== "error");
  const processing = signal?.status === "accepted" && decisions.length === 0 && now - entry.at < PROCESSING_WINDOW_MS;

  return (
    <div className="grid cursor-pointer grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 lg:grid-cols-[110px_270px_minmax(0,1fr)] lg:gap-x-4 border-b border-line px-4 py-3 last:border-b-0 hover:bg-surface-2/60" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <span className="tabular text-sm text-muted">{etTime(entry.at)}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAutomation();
          }}
          className="font-medium text-accent hover:underline"
          title="Open this automation in Settings"
        >
          {automationName(entry)}
        </button>
        {signal && signal.price > 0 && <span className="tabular text-xs text-faint">@ {num(signal.price)}</span>}
        {/* Where the call came from: a real TradingView alert, or somebody pressing Test Hook. */}
        {signal && (
          <Pill tone={signalOrigin(signal) === "test_hook" ? "info" : "neutral"} >
            <span title={originLabel(signal)}>{originLabel(signal)}</span>
          </Pill>
        )}
      </span>
      <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-1.5 lg:col-span-1">
        {signal?.status === "rejected" && <ErrorPill text={`Rejected: ${rejectWords(signal.rejectReason)}`} />}
        {processing && <Pill tone="info">Processing…</Pill>}
        {signal?.status === "accepted" && decisions.length === 0 && !processing && <Pill>No decision recorded</Pill>}
        {opened > 0 && <Pill tone="ok">{opened} open position{opened === 1 ? "" : "s"}</Pill>}
        {closed > 0 && <Pill tone="error">{closed} close position{closed === 1 ? "" : "s"}</Pill>}
        {decisions.length > 0 && <Pill>{decisions.length} decision{decisions.length === 1 ? "" : "s"}</Pill>}
        {others.map((d) => (
          <Pill key={d.id} tone={outcomeInfo(d.outcome).tone}>
            {outcomeInfo(d.outcome).label}
          </Pill>
        ))}
        {errors.map((d) => (
          <ErrorPill key={d.id} text={d.reason} />
        ))}
        {/* Deletable once the bot has stopped remembering it for duplicate protection. */}
        {now - entry.at >= PROCESSING_WINDOW_MS && (
          <button
            type="button"
            aria-label="Delete log entry"
            title="Delete this entry from the records"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-down"
          >
            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
            </svg>
          </button>
        )}
      </span>
    </div>
  );
}

/** A red pill with an icon and the raw error text. */
function ErrorPill({ text }: { text: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-down-soft px-2 py-0.5 text-[11px] font-medium text-down">
      <IconInfo width={12} height={12} className="shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}

/** Reads top to bottom as what the engine actually did for this one entry. */
function TraceDrawer({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const { signal, decisions } = entry;
  return (
    <Drawer title="Automation log" onClose={onClose}>
      <div className="space-y-5">
        <KeyValue
          rows={[
            ["Automation", automationName(entry)],
            ["Received", etDateTime(entry.at)],
            ...(signal
              ? ([
                  ["Signal", <DirectionTag key="d" direction={signal.signal} />],
                  ["Price", signal.price ? num(signal.price) : "—"],
                  ["Bar time", signal.barTime || "—"],
                  ["Interval", signal.interval || "—"],
                  ["Triggered by", originLabel(signal)],
                ] as [string, React.ReactNode][])
              : ([["Triggered by", isSystemEntry(entry) ? "Automatic: no signal, no one pressed a button" : "Manual action"]] as [string, string][])),
          ]}
        />

        <ol className="relative space-y-3 border-l border-line pl-5">
          <TraceNode tone="info" title={signal ? "Signal received" : isSystemEntry(entry) ? "Automatic" : "Manual action"} body={signal?.status === "rejected" ? `Rejected: ${rejectWords(signal.rejectReason)}` : signal ? "Saved, then queued behind this bot's lock." : undefined} />
          {decisions.map((d) => {
            const info = outcomeInfo(d.outcome);
            return (
              <TraceNode key={d.id} tone={info.tone} title={info.label} time={etTime(d.createdAt)} body={d.reason}>
                {Object.keys(d.detail).length > 0 && (
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-2 text-[11px] leading-relaxed text-muted">{JSON.stringify(d.detail, null, 2)}</pre>
                )}
              </TraceNode>
            );
          })}
          {signal?.status === "accepted" && decisions.length === 0 && (
            <TraceNode tone="skip" title="No decision yet" body="Still processing, or the server restarted before the engine finished." />
          )}
          <TraceNode tone="skip" title="End" />
        </ol>
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">This entry was recorded before the engine kept a step-by-step trace, so only its outcome is shown.</p>
      </div>
    </Drawer>
  );
}

const DOT: Record<Tone | "info", string> = { ok: "bg-up", error: "bg-down", warn: "bg-amber-500", skip: "bg-faint", info: "bg-accent" };

function TraceNode({ tone, title, body, time, children }: { tone: Tone | "info"; title: string; body?: string; time?: string; children?: React.ReactNode }) {
  return (
    <li className="relative">
      <span className={cn("absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-surface", DOT[tone])} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        {time && <span className="tabular text-xs text-faint">{time}</span>}
      </div>
      {body && <p className="mt-0.5 text-sm text-muted">{body}</p>}
      {children}
    </li>
  );
}
