"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { InputFields, pricingFields, toInputs, type BotFormValues } from "@/components/automation/BotForm";
import { IconChevronRight, IconEdit, IconGear, IconLink, IconMore, IconPlus } from "@/components/icons";
import { Card } from "@/components/ui";
import { AddAutomationDrawer } from "../builder/AddAutomationDrawer";
import { AutomationBuilder } from "../builder/AutomationBuilder";
import { builtInFlow, monitorFlow } from "../builder/builtin";
import { liveNodeEditor, monitorNodeEditor } from "../builder/LiveNodeEditors";
import type { AutomationDraft } from "../builder/model";
import { DEFAULT_FOLDER, blankDraft, detach, loadAttached, loadLibrary, loadSymbolSettings, setAttachmentEnabled, type Attachment, type SymbolSettings } from "../builder/store";
import { clock12 } from "../builder/builtin";
import { SymbolsPanel } from "./SymbolsPanel";
import { TriggerWebhook } from "./TriggerWebhook";
import type { BotAlerts, BotSafeguards, MonitorKey } from "@/lib/automation/types";
import type { BotContext } from "./BotDetail";
import { Checkbox, Drawer, Dropdown, Field, InfoTip, KeyValue, MenuItem, Pill, Switch, buttonClass, inputClass } from "./primitives";
import { num, usd, usd2, type BotDetailData } from "./model";


const MONITOR_ROWS: Record<MonitorKey, { name: string; direction: "bullish" | "bearish"; wrong: string }> = {
  bullishClose: { name: "Bullish Close Monitor", direction: "bullish", wrong: "short call spread" },
  bearishClose: { name: "Bearish Close Monitor", direction: "bearish", wrong: "short put spread" },
};

const signed = (n: number) => `${n > 0 ? "+" : ""}${num(n)} pts`;

function EditButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label} className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted hover:text-fg">
      <IconEdit width={15} height={15} />
    </button>
  );
}

function CardHeader({ title, tip, action }: { title: string; tip?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-base font-semibold">
        {title}
        {tip && <InfoTip text={tip} />}
      </h2>
      {action}
    </div>
  );
}

/** Option Alpha's stacked stat: a small uppercase label (with a help icon), the value under it, no row dividers. */
function Stat({ label, tip, children, muted }: { label: React.ReactNode; tip?: string; children: React.ReactNode; muted?: boolean }) {
  return (
    <div className={muted ? "opacity-60" : undefined}>
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
        {tip && <InfoTip text={tip} />}
      </div>
      <div className="mt-0.5 text-lg font-medium">{children}</div>
    </div>
  );
}

const SWEEP_WORDS = {
  estimate: "Expires the position and estimates its P/L from the underlying's price",
  market: "Closes the position at market",
  manual: "Expires the position and waits for you to enter its P/L",
} as const;

export function SettingsTab({ ctx }: { ctx: BotContext }) {
  const { data } = ctx;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <AutomationsCard ctx={ctx} />
        <InputsCard ctx={ctx} />
        <NotesCard ctx={ctx} />
      </div>

      <div className="space-y-4">
        <SafeguardsCard ctx={ctx} />
        <ScanSpeedsCard />
        <SymbolsCard botId={data.bot.id} underlying={data.config?.underlying ?? data.bot.draft?.underlying ?? "SPX"} />
        <AlertsCard ctx={ctx} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Automations: monitors and triggers
// ---------------------------------------------------------------------------

interface BuilderState {
  draft: AutomationDraft;
  readOnly?: boolean;
  /** A built-in flow: its steps are redrawn from the bot's real settings each time they change. */
  builtIn?: "bullish" | "bearish";
  /** A Close Monitor's flow (built in, live: Memo and Tags are real). */
  monitor?: MonitorKey;
  note?: string;
  /** Opened from the Add Automation panel: reopen it with the new flow selected afterwards. */
  fromAdd?: boolean;
}

function AutomationsCard({ ctx }: { ctx: BotContext }) {
  const { data, patch, notify, openRun } = ctx;
  const { bot } = data;
  const [drawer, setDrawer] = useState<"bullish" | "bearish" | null>(null);
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [library, setLibrary] = useState<AutomationDraft[]>([]);
  const [adding, setAdding] = useState<{ preselectId?: string } | null>(null);
  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const [monitorDrawer, setMonitorDrawer] = useState<MonitorKey | null>(null);
  const [lastSavedId, setLastSavedId] = useState<string | null>(null);

  /** Which webhook sits on each trigger, for the row's subtitle (as Option Alpha shows the webhook's name). */
  const [hookNames, setHookNames] = useState<{ bullish?: string; bearish?: string }>({});
  const loadHooks = () =>
    fetch("/api/automation/webhooks")
      .then((r) => (r.ok ? r.json() : { webhooks: [] }))
      .then((j: { webhooks: { name: string; botId: string | null; direction: "bullish" | "bearish" | null }[] }) => {
        const next: { bullish?: string; bearish?: string } = {};
        for (const w of j.webhooks) if (w.botId === bot.id && w.direction) next[w.direction] = w.name;
        setHookNames(next);
      })
      .catch(() => undefined);
  useEffect(() => {
    void loadHooks();
  }, [bot.id, drawer]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = () => {
    setAttached(loadAttached(bot.id));
    setLibrary(loadLibrary());
  };
  useEffect(reload, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const windowText = (() => {
    const w = data.config?.hours ?? data.limits.hours;
    return `${clock12(w.start)} - ${clock12(w.end)}`;
  })();

  const setTrigger = (dir: "bullish" | "bearish", on: boolean) => patch({ triggers: { ...bot.triggers, [dir]: on } });

  const openBuiltIn = (dir: "bullish" | "bearish") =>
    setBuilder({
      readOnly: true,
      builtIn: dir,
      note: "Live: this is what the engine does for this signal. Click a node to edit its values - they save straight to this bot's settings and apply to the next signal. The shape of the flow is the engine's logic, so steps can't be added or removed here. Duplicate protection, the position, daily and allocation limits, the strike checks and the error failsafe also apply and aren't drawn.",
      draft: builtInDraft(dir),
    });

  const openMonitor = (monitor: MonitorKey) =>
    setBuilder({
      readOnly: true,
      monitor,
      note: "Live: this is what the Close Monitor does each minute inside the trading window while it is switched on. It is off for now (the bot's flip already closes the opposite side; monitors get attached to the triggers later). The first check is Option Alpha's; the second is added so it can never close the side the latest signal wants. Click Close Position to set its memo and tags.",
      draft: monitorDraft(monitor),
    });

  const monitorDraft = (monitor: MonitorKey): AutomationDraft => ({
    id: `monitor-${monitor}`,
    name: MONITOR_ROWS[monitor].name,
    folder: "Built-in",
    steps: monitorFlow(MONITOR_ROWS[monitor].direction, data.config),
    inputs: [],
    updatedAt: 0,
  });

  /** The built-in flow drawn from the bot's current settings (window, offsets, size, prices). */
  const builtInDraft = (dir: "bullish" | "bearish"): AutomationDraft => ({
    id: `builtin-${dir}`,
    name: `${dir === "bullish" ? "Bullish" : "Bearish"} signal`,
    folder: "Built-in",
    steps: builtInFlow(dir, data.config, data.config?.hours ?? data.limits.hours, data.limits.maxPositionsPerType),
    inputs: [],
    updatedAt: 0,
  });

  const row = (opts: { key: string; name: string; sub: string; right: React.ReactNode; onName?: () => void; gear?: () => void; menu?: React.ReactNode; badge?: string }) => (
    <div key={opts.key} className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {opts.onName ? (
            <button onClick={opts.onName} className="inline-flex items-center gap-1.5 text-accent hover:underline" title="Open this automation's flow">
              {opts.name}
              <IconLink width={13} height={13} />
            </button>
          ) : (
            opts.name
          )}
          {opts.badge && <Pill tone="warn">{opts.badge}</Pill>}
        </div>
        <div className="text-xs text-muted">{opts.sub}</div>
      </div>
      {opts.right}
      <button
        onClick={opts.gear}
        disabled={!opts.gear}
        aria-label={`${opts.name} settings`}
        className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <IconGear width={16} height={16} />
      </button>
      {opts.menu}
    </div>
  );

  const triggerMenu = (dir: "bullish" | "bearish") => (
    <Dropdown
      align="right"
      trigger={({ toggle }) => (
        <button onClick={toggle} aria-label={`${dir} actions`} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
          <IconMore width={16} height={16} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem onClick={() => { close(); openBuiltIn(dir); }}>View flow</MenuItem>
          <MenuItem onClick={() => { close(); openRun(dir); }}>Run now...</MenuItem>
          <MenuItem onClick={() => { close(); navigator.clipboard?.writeText(payloadFor(dir, bot.id, data.config?.underlying ?? data.bot.draft?.underlying ?? "SPX")).then(() => notify("ok", "Webhook message copied.")); }}>Copy webhook message</MenuItem>
          <MenuItem onClick={() => { close(); setDrawer(dir); }}>Details</MenuItem>
        </>
      )}
    </Dropdown>
  );

  const attachedRows = attached
    .map((a) => ({ a, d: library.find((x) => x.id === a.draftId) }))
    .filter((x): x is { a: Attachment; d: AutomationDraft } => !!x.d);

  return (
    <Card className="p-5">
      <CardHeader
        title="Automations"
        action={
          <div className="flex items-center gap-2">
            <button className={`${buttonClass.secondary} flex items-center gap-1.5 !py-1.5`} onClick={() => setAdding({})}>
              <IconPlus width={14} height={14} /> Add automation
            </button>
            <button className={`${buttonClass.secondary} !py-1.5`} onClick={() => openRun()}>
              Run
            </button>
          </div>
        }
      />

      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Monitors</div>
      <div className="divide-y divide-line">
        {(["bullishClose", "bearishClose"] as const).map((key) =>
          row({
            key: `monitor-${key}`,
            name: MONITOR_ROWS[key].name,
            sub: windowText,
            onName: () => openMonitor(key),
            // Off for now: the bot's own flip already closes the opposite side, and a monitor is attached to the triggers later.
            // The switch is locked off (not clickable) until then; the engine side is built and tested.
            right: <Switch on={!!bot.monitors?.[key]?.enabled} onChange={() => undefined} disabled label={`${MONITOR_ROWS[key].name} on/off (off for now)`} />,
            gear: () => setMonitorDrawer(key),
          }),
        )}
        {attachedRows.map(({ a, d }) =>
          row({
            key: d.id,
            name: d.name,
            badge: "Preview",
            sub: `${a.schedule} · ${d.steps.length} step${d.steps.length === 1 ? "" : "s"} · saved in this browser, doesn't run yet`,
            onName: () => setBuilder({ draft: d }),
            right: <Switch on={a.enabled} onChange={() => setAttached(setAttachmentEnabled(bot.id, d.id, !a.enabled))} label={`${d.name} on/off`} />,
            gear: () => setBuilder({ draft: d }),
            menu: (
              <Dropdown
                align="right"
                trigger={({ toggle }) => (
                  <button onClick={toggle} aria-label={`${d.name} actions`} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
                    <IconMore width={16} height={16} />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem onClick={() => { close(); setBuilder({ draft: d }); }}>Edit flow</MenuItem>
                    <MenuItem onClick={() => { close(); setAttached(detach(bot.id, d.id)); notify("ok", "Removed from this bot. It stays in your library."); }}>Remove from bot</MenuItem>
                  </>
                )}
              </Dropdown>
            ),
          }),
        )}
      </div>
      <div className="mb-3" />

      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Triggers</div>
      <div className="divide-y divide-line">
        {(["bullish", "bearish"] as const).map((dir) =>
          row({
            key: dir,
            name: `${dir === "bullish" ? "Bullish" : "Bearish"} signal`,
            sub: hookNames[dir] ?? "No webhook attached",
            onName: () => openBuiltIn(dir),
            right: <Switch on={bot.triggers[dir]} onChange={() => setTrigger(dir, !bot.triggers[dir])} label={`${dir} trigger`} />,
            gear: () => setDrawer(dir),
            menu: triggerMenu(dir),
          }),
        )}
      </div>

      {drawer && <TriggerDrawer dir={drawer} ctx={ctx} onClose={() => setDrawer(null)} />}
      {monitorDrawer && <MonitorDrawer monitor={monitorDrawer} windowText={windowText} ctx={ctx} onClose={() => setMonitorDrawer(null)} />}
      {adding && (
        <AddAutomationDrawer
          botId={bot.id}
          builtIns={["Bullish signal", "Bearish signal"]}
          preselectId={adding.preselectId}
          onNew={() => {
            setAdding(null);
            setBuilder({ draft: blankDraft(), fromAdd: true });
          }}
          onAttached={(next) => {
            setAttached(next);
            setLibrary(loadLibrary());
            notify("ok", "Attached. It's a preview - it doesn't run yet.");
          }}
          onClose={() => setAdding(null)}
        />
      )}
      {builder && (
        <AutomationBuilder
          // A built-in flow is redrawn whenever the settings behind it change (after a live save).
          key={builder.builtIn || builder.monitor ? `${builder.draft.id}:${JSON.stringify(data.config)}:${JSON.stringify(data.bot.monitors)}` : builder.draft.id}
          draft={builder.builtIn ? builtInDraft(builder.builtIn) : builder.monitor ? monitorDraft(builder.monitor) : builder.draft}
          botId={bot.id}
          botName={bot.name}
          readOnly={builder.readOnly}
          note={builder.note}
          liveEditor={builder.builtIn ? (step, close) => liveNodeEditor({ step, direction: builder.builtIn!, ctx, onClose: close }) : builder.monitor ? (step, close) => monitorNodeEditor({ step, monitor: builder.monitor!, ctx, onClose: close }) : undefined}
          onSaved={(d) => {
            setLibrary(loadLibrary());
            setLastSavedId(d.id);
          }}
          onClose={() => {
            const reopen = builder.fromAdd && lastSavedId === builder.draft.id;
            setBuilder(null);
            reload();
            if (reopen) setAdding({ preselectId: builder.draft.id });
          }}
        />
      )}
    </Card>
  );
}

export const payloadFor = (dir: "bullish" | "bearish", botId: string, symbol: string) =>
  JSON.stringify({ secret: "<WEBHOOK_SECRET>", bot: botId, signal: dir, symbol, price: "{{close}}", bar_time: "{{timenow}}", interval: "{{interval}}" }, null, 2).replace('"{{close}}"', "{{close}}");

/** The gear behind a Close Monitor, laid out like Option Alpha's Edit Settings: which automation, and its schedule (Monitor). The
 * on/off switch is on the row; what it does is fixed by the engine. */
function MonitorDrawer({ monitor, windowText, ctx, onClose }: { monitor: MonitorKey; windowText: string; ctx: BotContext; onClose: () => void }) {
  const on = !!ctx.data.bot.monitors?.[monitor]?.enabled;
  const box = "rounded-lg border border-line bg-bg px-3 py-2.5 text-sm";
  return (
    <Drawer title="Edit Settings" onClose={onClose} footer={<button className={`${buttonClass.secondary} w-full`} onClick={onClose}>Close</button>}>
      <div className="space-y-5">
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Automation</h3>
          <div className={box}>{MONITOR_ROWS[monitor].name}</div>
        </section>
        <section className="space-y-2 border-t border-line pt-4">
          <h3 className="text-sm font-semibold">Schedule</h3>
          <div className={box}>Monitor <span className="ml-2 text-xs text-muted">Every scan to monitor open positions</span></div>
          <div className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 pt-2 text-sm">
            <span className="text-muted">Status</span>
            <span className="font-medium">{on ? "On" : "Off"}</span>
            <span className="text-muted">Window</span>
            <span>{windowText} (the bot&apos;s trading window)</span>
            <span className="text-muted">Scan</span>
            <span>Every 1m</span>
          </div>
        </section>
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          While it is on, each minute inside the window it closes a <span className="font-medium text-fg">{MONITOR_ROWS[monitor].wrong}</span> the bot opened, but only when the latest confirmed signal is <span className="font-medium text-fg">{MONITOR_ROWS[monitor].direction}</span>, the bot is on and the kill switch is off. It never touches a position that is already closing, or one placed by hand, and a failed close is an error that stops there. <span className="font-medium text-fg">It is off for now</span>: the bot already closes the opposite side on every signal, and the monitor will be attached to the triggers later.
        </p>
      </div>
    </Drawer>
  );
}

function TriggerDrawer({ dir, ctx, onClose }: { dir: "bullish" | "bearish"; ctx: BotContext; onClose: () => void }) {
  const { data, patch, notify, openRun } = ctx;

  return (
    <Drawer title="Edit Settings" onClose={onClose}>
      <div className="space-y-5">
        <TriggerWebhook
          botId={data.bot.id}
          dir={dir}
          triggerName={`${dir === "bullish" ? "Bullish" : "Bearish"} trigger`}
          canTest
          notify={notify}
          alwaysOn={data.bot.alwaysOn?.[dir] !== false}
          saveAlwaysOn={(on) => patch({ alwaysOn: { ...(data.bot.alwaysOn ?? { bullish: true, bearish: true }), [dir]: on } }, "Always On saved.")}
        />

        <button className={`${buttonClass.secondary} w-full`} onClick={() => { onClose(); openRun(dir); }}>
          Run this trigger now...
        </button>
        <Link href="/settings" className="block text-center text-xs text-muted hover:text-fg">
          Webhook settings <IconChevronRight width={11} height={11} className="inline" />
        </Link>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Bot inputs
// ---------------------------------------------------------------------------

function InputsCard({ ctx }: { ctx: BotContext }) {
  const { data } = ctx;
  const { config } = data;
  const [editing, setEditing] = useState(false);

  return (
    <Card className="p-5">
      <CardHeader
        title="Bot inputs"
        tip="The values every signal uses to build its spread. The offsets and expected credit have no defaults."
        action={config && <EditButton onClick={() => setEditing(true)} label="Edit bot inputs" />}
      />
      {config ? (
        <p className="mx-auto max-w-3xl px-4 py-10 text-center text-sm text-muted">
          Bot inputs are variables shared by your bot&apos;s automations. Any automation input can be upgraded to a bot input by clicking the <IconLink width={13} height={13} className="inline align-text-bottom" /> button next to the input on an automation&apos;s settings screen.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">{data.bot.configError ?? "Required settings are missing."}</div>
          <button className={buttonClass.primary} onClick={() => setEditing(true)}>
            Set the inputs
          </button>
        </div>
      )}
      {editing && <InputsDrawer ctx={ctx} onClose={() => setEditing(false)} />}
    </Card>
  );
}

export function InputsDrawer({ ctx, onClose }: { ctx: BotContext; onClose: () => void }) {
  const { data } = ctx;
  const c = data.config;
  // An empty bot keeps the name, account and allocation it was created with.
  const draft = data.bot.draft;
  const [f, setF] = useState<BotFormValues>({
    name: data.bot.name,
    accountId: c?.accountId ?? draft?.accountId ?? "paper-1",
    quantity: c ? String(c.quantity) : "3",
    widthPoints: c ? String(c.widthPoints) : "5",
    strikeIncrement: c ? String(c.strikeIncrement) : "5",
    putShortOffset: c ? String(c.putShortOffset) : "",
    callShortOffset: c ? String(c.callShortOffset) : "",
    allocationLimit: c ? String(c.allocationLimit) : String(draft?.allocationLimit ?? data.bot.allocation ?? "20000"),
    openingCreditEstimate: c ? String(c.openingCreditEstimate) : "",
    ...pricingFields(c),
    group: "",
    tags: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof BotFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [key]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/automation/bots/${data.bot.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: toInputs(f, c) }) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(json.error ?? "Could not save.");
    ctx.notify("ok", "Inputs saved.");
    ctx.reload();
    onClose();
  };

  return (
    <Drawer
      title="Bot inputs"
      onClose={onClose}
      wide
      footer={
        <button className={`${buttonClass.primary} w-full`} onClick={save} disabled={busy}>
          {busy ? "Saving..." : "Save"}
        </button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">Values every signal uses to build its spread. The offsets and expected credit have no defaults.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className={inputClass} value={f.name} onChange={set("name")} />
          </Field>
          <Field label="Account">
            <input className={inputClass} value={f.accountId} onChange={set("accountId")} />
          </Field>
        </div>
        <InputFields f={f} set={set} columns={2} />
        {data.bot.builtIn && (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            This bot normally reads its inputs from environment variables. Saving here stores them with the bot and overrides those values.
          </p>
        )}
        {data.counts.activePositions > 0 && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500">There is an open position. Changes apply to new positions only.</p>}
        {error && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">{error}</p>}
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function NotesCard({ ctx }: { ctx: BotContext }) {
  const { data, patch } = ctx;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.bot.notes);

  return (
    <Card className="p-5">
      <CardHeader
        title="Notes"
        action={
          !editing && (
            <button
              className={`${buttonClass.secondary} !py-1.5`}
              onClick={() => {
                setDraft(data.bot.notes);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )
        }
      />
      {editing ? (
        <div className="space-y-2">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} className={inputClass} placeholder="Why this bot exists, what to watch for..." autoFocus />
          <div className="flex justify-end gap-2">
            <button className={buttonClass.secondary} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              className={buttonClass.primary}
              onClick={async () => {
                if (await patch({ notes: draft }, "Notes saved.")) setEditing(false);
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : data.bot.notes ? (
        <p className="whitespace-pre-wrap text-sm">{data.bot.notes}</p>
      ) : (
        <div className="flex flex-col items-center gap-2 py-8 text-muted">
          <IconEdit width={28} height={28} />
          <button onClick={() => setEditing(true)} className="text-sm text-accent hover:underline">
            Add Notes
          </button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Safeguards, timing, alerts
// ---------------------------------------------------------------------------

function SafeguardsCard({ ctx }: { ctx: BotContext }) {
  const { data, notify, reload } = ctx;
  const { limits, config, counts } = data;
  const [editing, setEditing] = useState(false);

  const resetDaily = async () => {
    const res = await fetch(`/api/automation/bots/${data.bot.id}/daily-reset`, { method: "POST" });
    res.ok ? notify("ok", "Today's position count reset.") : notify("error", "Could not reset.");
    reload();
  };

  return (
    <Card className="p-5">
      <CardHeader title="Safeguards" tip="Limits the engine enforces before it opens anything. Closing is never blocked." action={<EditButton onClick={() => setEditing(true)} label="Edit safeguards" />} />
      <div className="space-y-4">
        <Stat label="Allocation" tip="The most the bot may have at risk at once.">{data.bot.allocation != null ? usd(data.bot.allocation) : "—"}</Stat>
        <Stat label="Daily positions" tip="New positions the bot may open per trading day.">
          {limits.dailyNewPositionLimit} per day
          <span className="block text-xs font-normal text-faint">
            {counts.newPositionsToday} today ·{" "}
            <button onClick={resetDaily} className="text-accent hover:underline">
              reset
            </button>
          </span>
        </Stat>
        <Stat label="Position limit" tip="Positions the bot may hold at once, closing ones included.">{limits.totalPositionLimit} at once</Stat>
        <Stat label="Day trading" tip="Not allowed: a signal never closes a position opened the same day. 0DTE positions are always same-day, so flips are skipped and the position is held to expiry.">
          {limits.dayTradingAllowed ? "Allowed" : "Not allowed"}
        </Stat>
      </div>
      {editing && <SafeguardsDrawer ctx={ctx} onClose={() => setEditing(false)} />}
    </Card>
  );
}

/** Whole-number choices for a dropdown, always including the current value. */
function choices(base: number[], current: number): number[] {
  return [...new Set([...base, current])].sort((a, b) => a - b);
}

export function SafeguardsDrawer({ ctx, onClose }: { ctx: BotContext; onClose: () => void }) {
  const { data, patch } = ctx;
  const { limits, config } = data;
  const [allocation, setAllocation] = useState(String(config?.allocationLimit ?? data.bot.allocation ?? ""));
  const [daily, setDaily] = useState(limits.dailyNewPositionLimit);
  const [total, setTotal] = useState(limits.totalPositionLimit);
  const [perType, setPerType] = useState(limits.maxPositionsPerType);
  const [dayTrading, setDayTrading] = useState(limits.dayTradingAllowed);

  const save = async (reset: boolean) => {
    const body: BotSafeguards = reset ? {} : { allocationLimit: Number(allocation), dailyNewPositionLimit: daily, totalPositionLimit: total, maxPositionsPerType: perType, dayTrading };
    if (await patch({ safeguards: body }, reset ? "Safeguards reset to defaults." : "Safeguards saved.")) onClose();
  };

  const select = (value: number, onChange: (n: number) => void, base: number[], unit: (n: number) => string) => (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} className={inputClass}>
      {choices(base, value).map((n) => (
        <option key={n} value={n}>
          {unit(n)}
        </option>
      ))}
    </select>
  );

  return (
    <Drawer
      title="Bot safeguards"
      onClose={onClose}
      footer={
        <button className={`${buttonClass.primary} w-full`} onClick={() => save(false)}>
          Save
        </button>
      }
    >
      <div className="space-y-5">
        <Field label="Allocation" hint="Total capital to open positions.">
          <input className={inputClass} inputMode="decimal" value={allocation} onChange={(e) => setAllocation(e.target.value)} />
        </Field>
        <Field label="Daily positions" hint="Max positions opened in one day.">
          {select(daily, setDaily, [1, 2, 3, 4, 5, 10, 15, 20, 25, 50, 100], (n) => `${n} per day`)}
        </Field>
        <Field label="Position limit" hint="Max open positions at one time.">
          {select(total, setTotal, [1, 2, 3, 4, 5, 10], (n) => `${n} position${n === 1 ? "" : "s"}`)}
        </Field>
        <Field label="Per type" hint="Max puts, and max calls, open at one time.">
          {select(perType, setPerType, [1, 2, 3, 4, 5], (n) => `${n} of each`)}
        </Field>
        <Field label="Day trading" hint="Not allowed: a signal never closes a position opened today, so flips are skipped and it is held to expiry. Manual closes still work.">
          <select value={dayTrading ? "yes" : "no"} onChange={(e) => setDayTrading(e.target.value === "yes")} className={inputClass}>
            <option value="yes">Allowed</option>
            <option value="no">Not allowed</option>
          </select>
        </Field>
        <button onClick={() => save(true)} className="text-xs font-medium text-accent hover:underline">
          Reset all to defaults
        </button>
      </div>
    </Drawer>
  );
}

/** Replaces the "scan speeds" idea: these bots don't poll, signals arrive by webhook. */
/** Option Alpha's "Scan Speeds": these bots don't scan, they run the instant a webhook is called. */
function ScanSpeedsCard() {
  return (
    <Card className="p-5">
      <CardHeader title="Scan Speeds" tip="These bots don't scan or poll: each automation runs the moment its webhook is called." />
      <div className="space-y-4">
        <Stat label="Automations">Instant (webhook)</Stat>
        <Stat label="Monitors" tip="A Close Monitor that is switched on looks once a minute, inside the trading window.">Every 1m</Stat>
        <Stat
          label={
            <>
              Exit options <Pill>off</Pill>
            </>
          }
          muted
          tip="Profit targets and stop losses aren't built: a position is held until the opposite signal or the end-of-day sweep."
        >
          Not built
        </Stat>
      </div>
    </Card>
  );
}

const ALERT_LABELS: [keyof BotAlerts, string, string][] = [
  ["open", "Open position", "When a position opens."],
  ["close", "Close position", "When a position closes."],
  ["warning", "Automation warning", "Limits reached, strikes overlapping."],
  ["error", "Automation error", "Rejected orders, invalid strikes, executor errors."],
];

function AlertsCard({ ctx }: { ctx: BotContext }) {
  const { data, patch } = ctx;
  return (
    <Card className="p-5">
      <CardHeader title="Activity Alerts" tip="A notice pops up in the corner while this bot's page is open. Hover an item for what raises it." />
      <div className="space-y-3">
        {ALERT_LABELS.map(([key, label, hint]) => (
          <div key={key} title={hint}>
            <Checkbox checked={data.bot.alerts[key]} onChange={(v) => patch({ alerts: { [key]: v } })} label={label} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function SymbolsCard({ botId, underlying }: { botId: string; underlying: string }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<SymbolSettings | null>(null);
  useEffect(() => setSaved(loadSymbolSettings(botId)), [botId]);

  return (
    <Card className="p-5">
      <CardHeader title="Symbols" tip={`The signal engine trades ${underlying} 0DTE only. Scan settings are a saved preview.`} action={<EditButton onClick={() => setOpen(true)} label="Edit bot symbols" />} />
      <div className="flex flex-wrap gap-1.5">
        <span className="rounded-md bg-accent/10 px-2.5 py-1 text-sm text-accent">{underlying}</span>
        {saved?.watchlist && <span className="rounded-md bg-surface-2 px-2.5 py-1 text-sm text-muted" title="Saved scan settings (preview)">{saved.watchlist}</span>}
        {saved?.excluded.map((x) => (
          <span key={x} className="rounded-md bg-down-soft px-2 py-1 text-xs text-down" title="Excluded (preview)">
            ✕ {x}
          </span>
        ))}
      </div>
      {open && <SymbolsPanel botId={botId} underlying={underlying} onSaved={setSaved} onClose={() => setOpen(false)} />}
    </Card>
  );
}
