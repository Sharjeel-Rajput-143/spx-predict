"use client";

import { useState, type ReactNode } from "react";
import { IconAutomation, IconChevronDown, IconCopy, IconPlus } from "@/components/icons";
import type { TriggerOption } from "@/lib/automation/types";
import { Dropdown, Pill, Switch, buttonClass, inputClass } from "./primitives";

export interface AttachedWebhook {
  id: string;
  name: string;
  active: boolean;
}

/** "BullishNDX - on" / "BearishNDX - off - unavailable: already attached to the Bearish trigger of NDX Bias Bot (one webhook, one trigger)" */
export function optionLabel(o: TriggerOption): string {
  const status = o.active ? "on" : "off";
  return o.available ? `${o.name} - ${status}` : `${o.name} - ${status} - unavailable: ${o.reason ?? "attached elsewhere"}`;
}

/** The webhook rows of the dropdown: name, status, and a copy icon for each. One attached to the other trigger is listed but can't be picked, and says why. */
export function WebhookOptionList({ options, selected, onPick, onCopy }: { options: TriggerOption[]; selected: string; onPick: (id: string) => void; onCopy: (id: string) => void }) {
  if (options.length === 0) return <p className="px-3 py-2 text-sm text-muted">No webhooks yet. Use + to create one.</p>;
  return (
    <ul>
      {options.map((o) => (
        <li key={o.id} className={`flex items-center gap-2 rounded-lg px-3 py-2 ${o.id === selected ? "bg-surface-2" : ""}`}>
          <button type="button" role="option" aria-selected={o.id === selected} aria-disabled={!o.available} disabled={!o.available} onClick={() => onPick(o.id)} className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-50">
            <span className="block truncate text-sm font-medium">
              {o.name} <span className="text-xs font-normal text-faint">{o.active ? "on" : "off"}</span>
            </span>
            {!o.available && <span className="block text-xs text-muted">Unavailable: {o.reason}</span>}
          </button>
          <button type="button" aria-label={`Copy URL of ${o.name}`} title="Copy the webhook URL for TradingView" onClick={() => onCopy(o.id)} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
            <IconCopy width={15} height={15} />
          </button>
        </li>
      ))}
    </ul>
  );
}

const SCHEDULES: { group: string; items: { name: string; note: string; enabled?: boolean }[] }[] = [
  { group: "Continuously", items: [{ name: "Scanner", note: "Every scan to find new positions" }, { name: "Monitor", note: "Every scan to monitor open positions" }] },
  {
    group: "Triggers",
    items: [
      { name: "Date", note: "At a specific date and time" },
      { name: "Repeating", note: "On a recurring schedule" },
      { name: "Market open", note: "At scheduled time" },
      { name: "Market close", note: "At scheduled time" },
      { name: "Position opened", note: "After the bot opens a position" },
      { name: "Position closed", note: "After the bot closes a position" },
      { name: "Webhook", note: "When a webhook is called", enabled: true },
    ],
  },
  { group: "Manual", items: [{ name: "Button", note: "Add a button to bot dashboard" }] },
];

const field = "flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-bg px-3 py-2.5 text-left text-sm hover:border-accent";

/**
 * The panel behind a trigger's gear icon, laid out like Option Alpha's "Edit Settings":
 *  Automation (the flow this trigger runs) / Schedule (Webhook) / Webhook (a dropdown of every webhook with a copy icon
 *  each, and + to create one) / Always On / Save. Below it: the URL (masked, Reveal / Copy), Detach and Test hook.
 * It only draws; the container does the fetching and saving.
 */
export function WebhookAttachPanel({
  triggerName,
  automationName,
  otherAutomationName,
  current,
  options,
  selected,
  onSelect,
  alwaysOn,
  onAlwaysOn,
  onSave,
  saveDisabled,
  onDetach,
  onCreate,
  onCopy,
  busy,
  error,
  urlSlot,
  testSlot,
}: {
  triggerName: string;
  automationName: string;
  otherAutomationName: string;
  current: AttachedWebhook | null;
  options: TriggerOption[];
  selected: string;
  onSelect: (id: string) => void;
  alwaysOn: boolean;
  onAlwaysOn: (on: boolean) => void;
  onSave: () => void;
  saveDisabled: boolean;
  onDetach: () => void;
  onCreate: (name: string) => Promise<string | null>;
  onCopy: (id: string) => void;
  busy: boolean;
  error?: string | null;
  urlSlot?: ReactNode;
  testSlot?: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const chosen = options.find((o) => o.id === selected);

  return (
    <div className="space-y-5" aria-label={`${triggerName} settings`}>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Automation</h3>
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Dropdown width="w-full" trigger={({ toggle }) => (
              <button type="button" onClick={toggle} className={field}>
                <span className="flex items-center gap-2 truncate">
                  <IconAutomation width={16} height={16} className="text-muted" />
                  {automationName}
                </span>
                <IconChevronDown width={14} height={14} className="text-faint" />
              </button>
            )}>
              {(close) => (
                <div>
                  <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">This bot</div>
                  <button type="button" className="block w-full rounded-lg bg-surface-2 px-3 py-2 text-left text-sm" onClick={close}>
                    {automationName}
                  </button>
                  <button type="button" disabled className="block w-full cursor-not-allowed rounded-lg px-3 py-2 text-left text-sm opacity-50" title={`${otherAutomationName} belongs to the other trigger`}>
                    {otherAutomationName}
                  </button>
                  <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">My library</div>
                  <button type="button" disabled className="block w-full cursor-not-allowed rounded-lg px-3 py-2 text-left text-sm opacity-50" title="Designs from the library are previews: they don't run">
                    My Automations (previews only)
                  </button>
                </div>
              )}
            </Dropdown>
          </div>
          <button type="button" disabled title="This trigger runs the engine's own automation; new ones can't be added" className={`${buttonClass.secondary} shrink-0`}>
            New
          </button>
        </div>
        <p className="text-xs text-muted">The trigger runs this bot&apos;s own {automationName.toLowerCase()} flow: it can&apos;t be swapped.</p>
      </section>

      <section className="space-y-2 border-t border-line pt-4">
        <h3 className="text-sm font-semibold">Schedule</h3>
        <Dropdown width="w-full" trigger={({ toggle }) => (
          <button type="button" onClick={toggle} className={field}>
            <span>Webhook</span>
            <IconChevronDown width={14} height={14} className="text-faint" />
          </button>
        )}>
          {(close) => (
            <div className="max-h-80 overflow-y-auto">
              {SCHEDULES.map((g) => (
                <div key={g.group}>
                  <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{g.group}</div>
                  {g.items.map((i) => (
                    <button key={i.name} type="button" disabled={!i.enabled} onClick={close} title={i.enabled ? undefined : "Not used here: this bot runs only when its TradingView webhook is called"} className={`flex w-full items-baseline gap-2 rounded-lg px-3 py-2 text-left text-sm ${i.enabled ? "bg-surface-2" : "cursor-not-allowed opacity-45"}`}>
                      <span className="font-medium">{i.name}</span>
                      <span className="text-xs text-muted">{i.note}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Dropdown>

        <div className="grid grid-cols-[6.5rem_1fr] items-start gap-x-3 gap-y-1 pt-2">
          <span className="pt-2.5 text-sm">Webhook</span>
          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <Dropdown width="w-full" trigger={({ toggle }) => (
                  <button type="button" onClick={toggle} className={field} aria-label={`Webhook for ${triggerName}`} disabled={busy}>
                    <span className="truncate">{chosen ? chosen.name : "Choose a webhook..."}</span>
                    <IconChevronDown width={14} height={14} className="text-faint" />
                  </button>
                )}>
                  {(close) => <WebhookOptionList options={options} selected={selected} onPick={(id) => { onSelect(id); close(); }} onCopy={onCopy} />}
                </Dropdown>
              </div>
              <button type="button" aria-label="Create a webhook" title="Create a new webhook" onClick={() => setCreating((c) => !c)} className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-lg border border-line hover:border-accent">
                <IconPlus width={16} height={16} />
              </button>
            </div>
            {creating && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
                <input className={`${inputClass} min-w-0 flex-1`} value={name} onChange={(e) => setName(e.target.value)} placeholder={triggerName.startsWith("Bullish") ? "e.g. BullishNDX" : "e.g. BearishNDX"} aria-label="New webhook name" />
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={busy || !name.trim()}
                  onClick={async () => {
                    setCreateError(null);
                    const problem = await onCreate(name.trim());
                    if (problem) setCreateError(problem);
                    else {
                      setName("");
                      setCreating(false);
                    }
                  }}
                >
                  Create
                </button>
                {createError && <span className="w-full text-xs text-down">{createError}</span>}
              </div>
            )}
            <div className="text-sm">
              {current ? (
                <>
                  Attached: <span className="font-medium">{current.name}</span> <Pill tone={current.active ? "ok" : "neutral"}>{current.active ? "on" : "off"}</Pill>
                  {!current.active && <span className="ml-2 text-xs text-muted">Calls are refused while it is switched off (Settings &gt; Webhooks).</span>}
                </>
              ) : (
                <span className="text-muted">No webhook attached: this trigger can&apos;t be called until you attach one.</span>
              )}
            </div>
            <p className="text-xs text-muted">One webhook, one trigger. Copy the URL with the icon, and paste it into the TradingView alert.</p>
          </div>

          <span className="pt-1.5 text-sm">Always On</span>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Switch on={alwaysOn} onChange={() => onAlwaysOn(!alwaysOn)} label="Always On" />
              <span className="text-sm">{alwaysOn ? "On" : "Off"}</span>
            </div>
            <p className="text-xs text-muted">
              Run even if automations are turned off. Here that applies to <span className="font-medium text-fg">closes only</span>: with the bot off this trigger can still close the opposite position, and it never opens one. Off: with the bot off it does nothing.
            </p>
          </div>
        </div>
      </section>

      {error && <p className="text-sm text-down">{error}</p>}
      <div className="flex flex-wrap items-center justify-center gap-3 border-t border-line pt-4">
        <button className={`${buttonClass.primary} min-w-40`} onClick={onSave} disabled={busy || saveDisabled}>
          Save
        </button>
        <button className={buttonClass.secondary} onClick={onDetach} disabled={busy || !current}>
          Detach webhook
        </button>
      </div>

      {current && urlSlot}
      {current && testSlot}
    </div>
  );
}
