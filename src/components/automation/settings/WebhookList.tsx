"use client";

import { useState, type ReactNode } from "react";
import { IconEdit } from "@/components/icons";
import { cn } from "@/lib/format";
import { Drawer, Field, Pill, buttonClass, inputClass } from "../bot/primitives";
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
      <div className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-muted">
        <span className="font-semibold text-fg">Keep your webhooks secret and safe.</span> Each webhook URL is unique and can be used by anyone who has it. Don&apos;t share them online, including via public version control repositories.
      </div>
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
          <button className={`${buttonClass.primary} min-w-44`} disabled={busy || !name.trim()} onClick={() => void create()}>
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </Drawer>
  );
}

/** The pencil: rename a webhook, switch it on or off, or delete it. */
export function EditWebhookDrawer({
  hook,
  onRename,
  onToggle,
  onDelete,
  onClose,
}: {
  hook: WebhookView;
  onRename: (id: string, name: string) => Promise<string | null>;
  onToggle: (id: string, active: boolean) => void;
  onDelete: (id: string) => void;
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
          <button className={`${buttonClass.primary} min-w-44`} disabled={busy || !name.trim()} onClick={() => void save()}>
            Save
          </button>
        </div>
        <div className="space-y-2 border-t border-line pt-4 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">{hook.active ? "On: calls to its URL are accepted." : "Off: calls to its URL get \"not found\"."}</span>
            <button className={buttonClass.secondary} onClick={() => { onToggle(hook.id, !hook.active); onClose(); }}>
              {hook.active ? "Switch off" : "Switch on"}
            </button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">A TradingView alert using its URL stops working.</span>
            <button
              className={buttonClass.secondary}
              onClick={() => {
                if (window.confirm(`Delete the webhook "${hook.name}"? A TradingView alert using its URL will stop working.`)) {
                  onDelete(hook.id);
                  onClose();
                }
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}

/** One webhook, laid out like Option Alpha's list: name, Test Hook, a pencil, "Usages", then the URL. */
export function WebhookRow({
  hook,
  origin,
  testSlot,
  onEdit,
}: {
  hook: WebhookView;
  origin: string;
  /** The test form, shown under the row when "Test Hook" is opened (mock and Tradier sandbox only). */
  testSlot?: ReactNode;
  onEdit: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const usage = hook.attached ? `1 trigger` : "not attached";
  return (
    <li className={cn("space-y-2 border-t border-line py-4", !hook.active && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-base font-semibold">{hook.name}</span>
        {!hook.active && <Pill tone="neutral">off</Pill>}
        {testSlot && (
          <button type="button" className="text-sm text-accent hover:underline" onClick={() => setTesting((t) => !t)} aria-expanded={testing}>
            Test Hook
          </button>
        )}
        <button type="button" onClick={onEdit} aria-label={`Edit ${hook.name}`} title="Rename, switch off or delete" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
          <IconEdit width={15} height={15} />
        </button>
      </div>
      <details className="group text-sm">
        <summary className="inline-flex list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
          <span className="text-muted">Usages:</span>
          <span className="font-medium">{usage}</span>
          <span className="text-faint transition-transform group-open:rotate-180" aria-hidden>
            ⌄
          </span>
        </summary>
        <div className="mt-1.5 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          {hook.attached
            ? `Attached to the ${hook.direction === "bullish" ? "Bullish" : "Bearish"} trigger of ${hook.botName}`
            : "Not attached: attach it from a bot's trigger (the gear icon). Until then a call to its URL is refused."}
          {" · "}
          {hook.triggerCount} call{hook.triggerCount === 1 ? "" : "s"}
          {hook.lastTriggeredAt ? `, last ${new Date(hook.lastTriggeredAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ", never called"}
        </div>
      </details>
      <SecretUrl webhookId={hook.id} maskedPath={hook.path} origin={origin} />
      {testing && testSlot}
    </li>
  );
}
