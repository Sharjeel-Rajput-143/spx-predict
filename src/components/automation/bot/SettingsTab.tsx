"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { InputFields, pricingFields, toInputs, type BotFormValues } from "@/components/automation/BotForm";
import { IconChevronRight, IconEdit, IconGear, IconLink, IconMore, IconPlus } from "@/components/icons";
import { Card } from "@/components/ui";
import { AddAutomationDrawer } from "../builder/AddAutomationDrawer";
import { AutomationBuilder } from "../builder/AutomationBuilder";
import { builtInFlow } from "../builder/builtin";
import { liveNodeEditor } from "../builder/LiveNodeEditors";
import type { AutomationDraft } from "../builder/model";
import { DEFAULT_FOLDER, blankDraft, detach, loadAttached, loadLibrary, loadSymbolSettings, setAttachmentEnabled, type Attachment, type SymbolSettings } from "../builder/store";
import { SymbolsPanel } from "./SymbolsPanel";
import type { BotAlerts, BotSafeguards } from "@/lib/automation/types";
import type { BotContext } from "./BotDetail";
import { Checkbox, Drawer, Dropdown, Field, InfoTip, KeyValue, MenuItem, Pill, Switch, buttonClass, inputClass } from "./primitives";
import { num, usd, usd2, type BotDetailData } from "./model";

const FLOW: { step: string; detail: string; stop?: string }[] = [
  { step: "Bot switched on?", detail: "The on/off switch is the kill switch.", stop: "Bot off" },
  { step: "Signal's trigger switched on?", detail: "Each direction can be turned off on its own under Triggers.", stop: "Trigger off" },
  { step: "Inside trading hours?", detail: "Weekdays only, within the window below, following the NYSE holiday and early-close calendar.", stop: "Outside hours" },
  { step: "Already handled?", detail: "Same signal for the same bar, or an identical one within the dedupe window.", stop: "Duplicate" },
  { step: "Close the opposite side", detail: "If a spread of the opposite type is open, close it and wait for the fill. A failed close stops everything and flags the bot.", stop: "Close rejected / timed out" },
  { step: "Already holding the wanted side?", detail: "Position limit per type.", stop: "Already in position" },
  { step: "Guards", detail: "Total position limit, daily limit, allocation limit, leg overlap.", stop: "Limit reached" },
  { step: "Strikes valid?", detail: "Short strike from price + offset, long strike from the short strike. Nothing is sent if the checks fail; the bot is flagged.", stop: "Invalid strikes" },
  { step: "Open the wanted side", detail: "Bullish → short put spread. Bearish → short call spread. Position saved, linked to the signal." },
];

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
        <Card className="p-5">
          <CardHeader title="Decision flow" tip="What the engine does, in order, for every signal." />
          <ol className="space-y-0">
            {FLOW.map((f, i) => (
              <li key={f.step} className="relative flex gap-3 pb-4 last:pb-0">
                {i < FLOW.length - 1 && <span className="absolute left-[11px] top-6 h-[calc(100%-1.25rem)] w-px bg-line" />}
                <span className="tabular grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-muted">{i + 1}</span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{f.step}</div>
                  <div className="text-sm text-muted">{f.detail}</div>
                  {f.stop && (
                    <div className="mt-1 text-xs text-faint">
                      If not: stop and log <Pill>{f.stop}</Pill>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <div className="space-y-4">
        <SafeguardsCard ctx={ctx} />
        <TimingCard data={data} />
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
  const [lastSavedId, setLastSavedId] = useState<string | null>(null);

  const reload = () => {
    setAttached(loadAttached(bot.id));
    setLibrary(loadLibrary());
  };
  useEffect(reload, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTrigger = (dir: "bullish" | "bearish", on: boolean) => patch({ triggers: { ...bot.triggers, [dir]: on } });

  const openBuiltIn = (dir: "bullish" | "bearish") =>
    setBuilder({
      readOnly: true,
      builtIn: dir,
      note: "Live: this is what the engine does for this signal. Click a node to edit its values - they save straight to this bot's settings and apply to the next signal. The shape of the flow is the engine's logic, so steps can't be added or removed here. Duplicate protection, the position, daily and allocation limits, the strike checks and the error failsafe also apply and aren't drawn.",
      draft: builtInDraft(dir),
    });

  /** The built-in flow drawn from the bot's current settings (window, offsets, size, prices). */
  const builtInDraft = (dir: "bullish" | "bearish"): AutomationDraft => ({
    id: `builtin-${dir}`,
    name: `${dir === "bullish" ? "Bullish" : "Bearish"} signal`,
    folder: "Built-in",
    steps: builtInFlow(dir, data.config, data.config?.hours ?? data.limits.hours),
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
        {row({ key: "eod", name: "End-of-day expiry sweep", sub: "Daily at 4:05 PM ET · marks every open 0DTE position expired", right: <Switch on onChange={() => undefined} disabled label="End-of-day sweep (always on)" /> })}
        {row({ key: "stale", name: "Stale-position check", sub: "Before every signal · expires positions left over from a prior day", right: <Switch on onChange={() => undefined} disabled label="Stale-position check (always on)" /> })}
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
      <p className="mb-3 mt-1 text-[11px] text-faint">System monitors can&apos;t be switched off.</p>

      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Triggers</div>
      <div className="divide-y divide-line">
        {(["bullish", "bearish"] as const).map((dir) =>
          row({
            key: dir,
            name: `${dir === "bullish" ? "Bullish" : "Bearish"} signal`,
            sub: `Webhook · TradingView · wants a ${dir === "bullish" ? "short put" : "short call"} spread`,
            onName: () => openBuiltIn(dir),
            right: <Switch on={bot.triggers[dir]} onChange={() => setTrigger(dir, !bot.triggers[dir])} label={`${dir} trigger`} />,
            gear: () => setDrawer(dir),
            menu: triggerMenu(dir),
          }),
        )}
      </div>

      {drawer && <TriggerDrawer dir={drawer} ctx={ctx} onClose={() => setDrawer(null)} />}
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
          key={builder.builtIn ? `${builder.draft.id}:${JSON.stringify(data.config)}` : builder.draft.id}
          draft={builder.builtIn ? builtInDraft(builder.builtIn) : builder.draft}
          botId={bot.id}
          botName={bot.name}
          readOnly={builder.readOnly}
          note={builder.note}
          liveEditor={builder.builtIn ? (step, close) => liveNodeEditor({ step, direction: builder.builtIn!, ctx, onClose: close }) : undefined}
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

function TriggerDrawer({ dir, ctx, onClose }: { dir: "bullish" | "bearish"; ctx: BotContext; onClose: () => void }) {
  const { data, patch, notify, openRun } = ctx;
  const [origin, setOrigin] = useState("");
  const [hooks, setHooks] = useState<{ id: string; name: string; path: string; active: boolean }[]>([]);
  useEffect(() => {
    setOrigin(window.location.origin);
    fetch("/api/automation/webhooks")
      .then((r) => (r.ok ? r.json() : { webhooks: [] }))
      .then((j: { webhooks: { id: string; name: string; path: string; active: boolean; botId: string; direction: string }[] }) => setHooks(j.webhooks.filter((w) => w.botId === ctx.data.bot.id && w.direction === dir)))
      .catch(() => undefined);
  }, [ctx.data.bot.id, dir]);
  const received = data.signals.filter((s) => s.signal === dir && s.status === "accepted").length;
  const on = data.bot.triggers[dir];

  return (
    <Drawer title={`${dir === "bullish" ? "Bullish" : "Bearish"} signal trigger`} onClose={onClose}>
      <div className="space-y-5">
        <div className="flex items-center justify-between rounded-lg border border-line px-4 py-3">
          <div>
            <div className="text-sm font-medium">Trigger {on ? "on" : "off"}</div>
            <div className="text-xs text-muted">{on ? "Signals in this direction are acted on." : "Signals in this direction are logged and ignored."}</div>
          </div>
          <Switch on={on} onChange={() => patch({ triggers: { ...data.bot.triggers, [dir]: !on } })} label={`${dir} trigger`} />
        </div>

        <KeyValue
          rows={[
            ["Source", "TradingView webhook"],
            ["Wants", dir === "bullish" ? "Short put spread" : "Short call spread"],
            ["Closes first", dir === "bullish" ? "Short call spread" : "Short put spread"],
            ["Received (recent)", received],
          ]}
        />

        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Webhook</div>
          {hooks.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No webhook for this signal yet. Create one under Settings &gt; Webhooks (it takes a name and this bot).</p>
          ) : (
            <ul className="mt-1 space-y-2">
              {hooks.map((h) => (
                <li key={h.id} className="rounded-lg bg-surface-2 px-3 py-2">
                  <div className="text-sm font-medium">
                    {h.name} {!h.active && <span className="text-xs text-faint">(off)</span>}
                  </div>
                  <code className="block break-all text-xs">{origin}{h.path}</code>
                  <button className="mt-1 text-xs font-medium text-accent hover:underline" onClick={() => navigator.clipboard?.writeText(`${origin}${h.path}`).then(() => notify("ok", "Webhook URL copied."))}>
                    Copy URL
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">Alert message for a named webhook: <code>{`{"price":{{close}},"bar_time":"{{timenow}}","interval":"{{interval}}"}`}</code></p>
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Or one shared URL with a secret</div>
          <code className="mt-1 block break-all rounded-lg bg-surface-2 px-3 py-2 text-sm">POST {origin}/api/webhook/tradingview</code>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">TradingView alert message</div>
            <button className="text-xs font-medium text-accent hover:underline" onClick={() => navigator.clipboard?.writeText(payloadFor(dir, data.bot.id, data.config?.underlying ?? data.bot.draft?.underlying ?? "SPX")).then(() => notify("ok", "Copied."))}>
              Copy
            </button>
          </div>
          <pre className="mt-1 overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs leading-relaxed">{payloadFor(dir, data.bot.id, data.config?.underlying ?? data.bot.draft?.underlying ?? "SPX")}</pre>
          <p className="mt-2 text-xs text-muted">Only the confirmed bullish and bearish alerts should call the webhook. Do not send any other alert, because extra alerts cause duplicate entries.</p>
        </div>

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
        <KeyValue
          rows={[
            ["Underlying", `${config.underlying} · 0DTE`],
            ["Account", config.accountId],
            ["Quantity", config.quantity],
            ["Width", `${config.widthPoints} pts`],
            ["Strike increment", config.strikeIncrement],
            ["Short put offset", signed(config.putShortOffset)],
            ["Short call offset", signed(config.callShortOffset)],
            ["Expected credit", usd2(config.openingCreditEstimate)],
            ["Strike price from", (config.strikePriceSource ?? "alert") === "alert" ? "The alert's price" : "Live quote taken when the Open step runs (do not use until a real time quote source is connected; refuses to open without a fresh one)"],
            ["Strike rounding", (config.strikeRounding ?? "outward") === "outward" ? "Out of the money (put down, call up)" : "Nearest strike"],
            ["Final price", `${config.openPricePercent ?? 100}% of the way from the mid to the bid/ask to open, ${config.closePricePercent ?? 100}% to close`],
            ["SmartPricing", `${(config.smartPricing ?? "normal")[0].toUpperCase()}${(config.smartPricing ?? "normal").slice(1)} - walks from the mid to the final price when live quotes exist; the last price waits 2 minutes, then cancels`],
            ["End-of-day sweep", `${SWEEP_WORDS[config.eodSweepMode ?? "estimate"]} at ${config.eodSweepTime ?? "16:05"} ET`],
          ]}
        />
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
        <button onClick={() => setEditing(true)} className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-line py-6 text-sm text-muted hover:text-fg">
          <IconEdit width={20} height={20} />
          Add notes
        </button>
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
      <KeyValue
        rows={[
          ["Allocation", data.bot.allocation != null ? usd(data.bot.allocation) : "—"],
          [
            "Daily positions",
            <span key="d" className="block">
              {limits.dailyNewPositionLimit} per day
              <span className="block text-xs font-normal text-faint">
                {counts.newPositionsToday} today ·{" "}
                <button onClick={resetDaily} className="text-accent hover:underline">
                  reset
                </button>
              </span>
            </span>,
          ],
          ["Position limit", `${limits.totalPositionLimit} at once`],
          ["Per type", `${limits.maxPositionsPerType} of each`],
          [<>Day trading<InfoTip text="Not allowed: a signal never closes a position opened the same day. 0DTE positions are always same-day, so flips are skipped and the position is held to expiry." /></>, limits.dayTradingAllowed ? "Allowed" : "Not allowed"],
          [<>Error failsafe<InfoTip text="The bot switches itself off after this many errors in a trading day. Set globally by environment." /></>, `${limits.errorFailsafeThreshold} / day`],
        ]}
      />
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
function TimingCard({ data }: { data: BotDetailData }) {
  const { limits } = data;
  return (
    <Card className="p-5">
      <CardHeader title="Timing" tip="Read-only here - set by environment variables. See .env.example." />
      <KeyValue
        rows={[
          ["Triggers", "Instant (webhook)"],
          ["Window", `${limits.hours.start}–${limits.hours.end} ET, weekdays`],
          ["Dedupe window", `${limits.dedupeWindowSeconds}s`],
          ["Flip cooldown", limits.flipCooldownSeconds > 0 ? `${limits.flipCooldownSeconds}s` : "Off"],
          ["Fill timeout", `${limits.orderFillTimeoutSeconds}s`],
          ["Close timeout", `${limits.closeConfirmTimeoutSeconds}s`],
          ["Dry run", limits.dryRun ? "On" : "Off"],
          ["Executor", data.mockPricing ? "Mock (simulated prices)" : "Mock (no broker)"],
        ]}
      />
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
      <CardHeader title="Activity alerts" tip="A notice pops up in the corner while this bot's page is open." />
      <div className="space-y-3">
        {ALERT_LABELS.map(([key, label, hint]) => (
          <div key={key}>
            <Checkbox checked={data.bot.alerts[key]} onChange={(v) => patch({ alerts: { [key]: v } })} label={label} />
            <p className="ml-[26px] text-[11px] text-faint">{hint}</p>
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
      <CardHeader title="Symbols" action={<EditButton onClick={() => setOpen(true)} label="Edit bot symbols" />} />
      <div className="flex flex-wrap gap-1.5">
        <span className="rounded-md bg-accent/10 px-2.5 py-1 text-sm text-accent">{underlying}</span>
        {saved?.watchlist && <span className="rounded-md bg-surface-2 px-2.5 py-1 text-sm text-muted" title="Saved scan settings (preview)">{saved.watchlist}</span>}
        {saved?.excluded.map((x) => (
          <span key={x} className="rounded-md bg-down-soft px-2 py-1 text-xs text-down" title="Excluded (preview)">
            ✕ {x}
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">The signal engine trades {underlying} 0DTE only. Scan settings are a saved preview.</p>
      {open && <SymbolsPanel botId={botId} underlying={underlying} onSaved={setSaved} onClose={() => setOpen(false)} />}
    </Card>
  );
}
