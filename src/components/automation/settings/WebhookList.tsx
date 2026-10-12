"use client";

import { useState, type ReactNode } from "react";
import { IconEdit } from "@/components/icons";
import { cn } from "@/lib/format";
import { Btn, Drawer, Field, inputClass, Pill } from "../bot/primitives";
import { SecretUrl } from "../SecretUrl";
import type { WebhookView } from "./sections";

/** The top of Settings > Webhooks, in the order Option Alpha has it: what a webhook is, the once-a-minute rule in red, the keep-it-secret box. */
export function WebhookIntro() {
  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted">
        Webhooks allow you to trigger automations in your bots from outside this app, for example from a TradingView alert. Each webhook gives you a unique URL which you call to trigger it. Any time a webhook is triggered it runs the bot&apos;s automation immediately, unless the bot is already busy with another run, in which case it waits for its turn.
      </p>
      <p className="font-medium text-down">Each webhook can be triggered a maximum of 1 time per minute. Calls made more than once per minute are ignored.</p>
      <div className="rounded-xl border border-accent/20 bg-accent/5 px-4 py-3 text-muted">
        <span className="font-semibold text-fg">Keep your webhooks secret and safe.</span> Each webhook URL is unique and contains a secret code. Don&apos;t share it online, including via public version control repositories.
      </div>
      <p className="text-muted">Only the confirmed bullish and bearish alerts should call the webhook. Do not send any other alert, because extra alerts cause duplicate entries.</p>
    </div>
  );
}

/** "New Webhook": a slide-over with a Name and Create, as in Option Alpha. The webhook is created without a trigger; it is attached from a bot's Bullish or Bearish trigger. */
export function NewWebhookDrawer({ onCreate, onClose }: { onCreate: (name: string) => Promise<string | null>; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    const problem = await onCreate(name.trim());
    setBusy(false);
    if (problem) setError(problem);
    else onClose();
  };

  return (
    <Drawer title="New Webhook" onClose={onClose}>
      <div className="space-y-6">
        <div className="grid grid-cols-[5rem_1fr] items-start gap-x-4 gap-y-1">
          <label htmlFor="new-webhook-name" className="pt-2.5 text-sm">
            Name
          </label>
          <div className="space-y-1.5">
            <input
              id="new-webhook-name"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void create()}
              autoFocus
              maxLength={60}
              aria-label="Webhook name"
            />
            <p className="text-xs text-muted">You&apos;ll use this name to reference it in your bots.</p>
          </div>
        </div>
        {error && <p className="text-sm text-down">{error}</p>}
        <div className="text-center">
          <Btn kind="primary" className="min-w-44"  disabled={busy || !name.trim()} onClick={() => void create()}>
            {busy ? "Creating..." : "Create"}
          </Btn>
        </div>
      </div>
    </Drawer>
  );
}

/** The pencil: rename a webhook, or switch it on or off. (Deleting is the trash can on its row.) */
export function EditWebhookDrawer({
  hook,
  onRename,
  onToggle,
  onRequireText = () => undefined,
  onClose,
}: {
  hook: WebhookView;
  onRename: (id: string, name: string) => Promise<string | null>;
  onToggle: (id: string, active: boolean) => void;
  /** Whether the alert's text must say this webhook's direction. */
  onRequireText?: (id: string, on: boolean) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(hook.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    const problem = name.trim() === hook.name ? null : await onRename(hook.id, name.trim());
    setBusy(false);
    if (problem) setError(problem);
    else onClose();
  };

  return (
    <Drawer title="Edit Webhook" onClose={onClose}>
      <div className="space-y-6">
        <div className="grid grid-cols-[5rem_1fr] items-start gap-x-4">
          <label htmlFor="edit-webhook-name" className="pt-2.5 text-sm">
            Name
          </label>
          <input id="edit-webhook-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} maxLength={60} aria-label="Webhook name" />
        </div>
        {error && <p className="text-sm text-down">{error}</p>}
        <div className="text-center">
          <Btn kind="primary" className="min-w-44"  disabled={busy || !name.trim()} onClick={() => void save()}>
            Save
          </Btn>
        </div>
        <div className="space-y-2 border-t border-line pt-4 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">{hook.active ? "On: calls to its URL are accepted." : "Off: calls to its URL get \"not found\"."}</span>
            <Btn kind="secondary"  onClick={() => { onToggle(hook.id, !hook.active); onClose(); }}>
              {hook.active ? "Switch off" : "Switch on"}
            </Btn>
          </div>
          {hook.direction && (
            <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <span className="text-muted">
                {hook.requireDirectionText !== false ? `Alert text must say "${hook.direction}": a call without it is refused.` : `Alert text isn't required to say "${hook.direction}". A text that says the other direction is still refused.`}
              </span>
              <Btn kind="secondary"  onClick={() => { onRequireText(hook.id, hook.requireDirectionText === false); onClose(); }}>
                {hook.requireDirectionText !== false ? "Don't require" : "Require"}
              </Btn>
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}

const IconTrash = (p: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </svg>
);

/**
 * One webhook, laid out like Option Alpha's list: the name, "Test Hook" (grey when it can't be used), a pencil, and a trash
 * can; then "Usages: N bots" (opens to show where); then "URL:" with a copy icon.
 */
export function WebhookRow({
  hook,
  origin,
  testSlot,
  onEdit,
  onDelete,
}: {
  hook: WebhookView;
  origin: string;
  /** The test form, shown under the row when "Test Hook" is opened (mock and Tradier sandbox only). */
  testSlot?: ReactNode;
  onEdit: () => void;
  /** The trash can: deleting an attached webhook detaches it from its trigger first (logged). */
  onDelete?: (id: string) => void;
}) {
  const [testing, setTesting] = useState(false);
  const used = hook.attached ? 1 : 0;
  return (
    <li className={cn("space-y-2.5 border-t border-line py-5", !hook.active && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-base font-semibold">{hook.name}</span>
        {!hook.active && <Pill tone="neutral">off</Pill>}
        {testSlot ? (
          <button type="button" className="text-sm hover:text-accent" onClick={() => setTesting((t) => !t)} aria-expanded={testing}>
            Test Hook
          </button>
        ) : (
          <span className="text-sm text-faint" title="A test call needs the webhook switched on and attached to a trigger, on the mock executor or the Tradier sandbox">
            Test Hook
          </span>
        )}
        <button type="button" onClick={onEdit} aria-label={`Edit ${hook.name}`} title="Rename or switch on or off" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
          <IconEdit width={15} height={15} />
        </button>
        {onDelete && (
          <button
            type="button"
            aria-label={`Delete ${hook.name}`}
            title={used === 0 ? "Delete this webhook" : "Delete this webhook (it is detached from its trigger first)"}
            onClick={() => {
              const detail = used === 0 ? "" : ` It is attached to the ${hook.direction === "bullish" ? "Bullish" : "Bearish"} trigger of ${hook.botName}: that trigger will have no webhook until you attach another.`;
              if (window.confirm(`Delete the webhook "${hook.name}"?${detail} A TradingView alert using its URL will stop working.`)) onDelete(hook.id);
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-down"
          >
            <IconTrash width={15} height={15} />
          </button>
        )}
      </div>
      {used === 0 ? (
        <div className="text-sm" title="Attach it from a bot's trigger (the gear icon). Until then a call to its URL is refused.">
          <span className="text-muted">Usages:</span> 0 bots
        </div>
      ) : (
        <details className="group text-sm">
          <summary className="inline-flex list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            <span>Usages:</span>
            <span className="font-medium">1 bot</span>
            <span className="text-faint transition-transform group-open:rotate-180" aria-hidden>
              ⌄
            </span>
          </summary>
          <div className="mt-1.5 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            Attached to the {hook.direction === "bullish" ? "Bullish" : "Bearish"} trigger of {hook.botName} · {hook.triggerCount} call{hook.triggerCount === 1 ? "" : "s"}
            {hook.lastTriggeredAt ? `, last ${new Date(hook.lastTriggeredAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ", never called"}
          </div>
        </details>
      )}
      <SecretUrl inline webhookId={hook.id} maskedPath={hook.path} origin={origin} />
      {testing && testSlot}
    </li>
  );
}
