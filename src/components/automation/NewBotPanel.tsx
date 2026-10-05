"use client";

import { useEffect, useState } from "react";
import { AccountIcon, accountLabel } from "@/components/automation/accounts";
import { Drawer, Dropdown, Field, InfoTip, MenuItem, buttonClass, inputClass } from "@/components/automation/bot/primitives";
import { IconAutomation, IconChevronDown, IconChevronRight, IconCopy, IconFolder, IconSad } from "@/components/icons";
import type { BotSummary } from "@/lib/automation/summary";
import type { BotTemplate } from "@/lib/automation/types";

export type NewBotView =
  | { name: "menu" }
  | { name: "clone" }
  | { name: "templates" }
  | { name: "form"; mode: "empty" | "clone" | "template"; sourceId?: string; templateId?: string; initial: { name: string; accountId: string; allocation: string } };

const DEFAULT_ACCOUNT = "paper-1";
const DEFAULT_ALLOCATION = "1000";

/**
 * "New Bot": one slide-over that swaps its own content - a menu, a list of
 * bots to clone, a list of templates, then a short form - with a back arrow
 * to return to wherever you came from.
 */
export function NewBotPanel({
  bots,
  templates,
  accounts,
  start,
  onClose,
  onCreated,
}: {
  bots: BotSummary[];
  templates: BotTemplate[];
  accounts: string[];
  /** Open on a given view, or on a whole stack (so there is somewhere to go back to). */
  start?: NewBotView | NewBotView[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [stack, setStack] = useState<NewBotView[]>(Array.isArray(start) ? start : [start ?? { name: "menu" }]);
  const view = stack[stack.length - 1];
  const push = (v: NewBotView) => setStack((s) => [...s, v]);
  const back = stack.length > 1 ? () => setStack((s) => s.slice(0, -1)) : undefined;

  const liveBots = bots.filter((b) => !b.archived);

  const titles: Record<NewBotView["name"], string> = { menu: "New bot", clone: "Clone a bot", templates: "My templates", form: "New bot" };

  if (view.name === "form") {
    return <BotForm view={view} accounts={accounts} onBack={back} onClose={onClose} onCreated={onCreated} />;
  }

  return (
    <Drawer title={titles[view.name]} onClose={onClose} onBack={back}>
      {view.name === "menu" && (
        <div className="space-y-5">
          <ul className="divide-y divide-line rounded-xl border border-line">
            <MenuRow
              icon={<IconAutomation width={18} height={18} />}
              title="Empty bot"
              description="Start with a blank canvas"
              onClick={() => push({ name: "form", mode: "empty", initial: { name: "", accountId: DEFAULT_ACCOUNT, allocation: DEFAULT_ALLOCATION } })}
            />
            <MenuRow icon={<IconCopy width={18} height={18} />} title="Clone a bot" description="Create a duplicate copy of an existing bot" chevron onClick={() => push({ name: "clone" })} />
          </ul>
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Templates</h3>
            <ul className="rounded-xl border border-line">
              <MenuRow icon={<IconFolder width={18} height={18} />} title="My templates" chevron onClick={() => push({ name: "templates" })} />
            </ul>
          </section>
        </div>
      )}

      {view.name === "clone" && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {liveBots.length === 0 && <li className="px-4 py-6 text-sm text-muted">There are no bots to clone yet.</li>}
          {liveBots.map((b) => (
            <MenuRow
              key={b.id}
              icon={<IconAutomation width={18} height={18} />}
              title={b.name}
              description={b.accountId ? accountLabel(b.accountId) : undefined}
              chevron
              onClick={() =>
                push({ name: "form", mode: "clone", sourceId: b.id, initial: { name: `${b.name} copy`, accountId: b.accountId ?? DEFAULT_ACCOUNT, allocation: String(b.allocation ?? DEFAULT_ALLOCATION) } })
              }
            />
          ))}
        </ul>
      )}

      {view.name === "templates" &&
        (templates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted">
            <IconSad width={44} height={44} className="text-faint" />
            <p className="text-sm">You haven&apos;t saved a template yet.</p>
            <p className="max-w-xs text-xs text-faint">Open a bot&apos;s ... menu and choose Save as template.</p>
          </div>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {templates.map((t) => (
              <MenuRow
                key={t.id}
                icon={<IconFolder width={18} height={18} />}
                title={t.name}
                description={`${t.config.quantity}x · ${t.config.widthPoints}pt wide`}
                chevron
                onClick={() =>
                  push({ name: "form", mode: "template", templateId: t.id, initial: { name: "", accountId: t.config.accountId, allocation: String(t.safeguards?.allocationLimit ?? t.config.allocationLimit) } })
                }
              />
            ))}
          </ul>
        ))}
    </Drawer>
  );
}

function MenuRow({ icon, title, description, chevron, onClick }: { icon: React.ReactNode; title: string; description?: string; chevron?: boolean; onClick: () => void }) {
  return (
    <li>
      <button onClick={onClick} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-surface-2/60">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          {description && <span className="block truncate text-xs text-muted">{description}</span>}
        </span>
        {chevron && <IconChevronRight width={16} height={16} className="shrink-0 text-faint" />}
      </button>
    </li>
  );
}

function BotForm({
  view,
  accounts,
  onBack,
  onClose,
  onCreated,
}: {
  view: Extract<NewBotView, { name: "form" }>;
  accounts: string[];
  onBack?: () => void;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState(view.initial.name);
  const [accountId, setAccountId] = useState(view.initial.accountId);
  const [allocation, setAllocation] = useState(view.initial.allocation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [name, accountId, allocation]);

  const options = [...new Set([...accounts, accountId])];

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/automation/bots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: view.mode, sourceId: view.sourceId, templateId: view.templateId, name, accountId, allocationLimit: Number(allocation) }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(json.error ?? "Could not create the bot.");
    onCreated(json.bot.id);
  };

  return (
    <Drawer
      title="New bot"
      onClose={onClose}
      onBack={onBack}
      footer={
        <button className={`${buttonClass.primary} w-full`} onClick={submit} disabled={busy}>
          {busy ? "Creating..." : "Create bot"}
        </button>
      }
    >
      <div className="space-y-5">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SPX Weekly Bias" autoFocus aria-label="Name" />
        </Field>

        <Field label="Account">
          <Dropdown
            width="w-full"
            trigger={({ toggle }) => (
              <button onClick={toggle} aria-haspopup="listbox" aria-label="Account" className={`${inputClass} flex items-center gap-2 text-left`}>
                <AccountIcon id={accountId} />
                <span className="flex-1">{accountLabel(accountId)}</span>
                <IconChevronDown width={14} height={14} className="text-faint" />
              </button>
            )}
          >
            {(close) =>
              options.map((a) => (
                <MenuItem
                  key={a}
                  onClick={() => {
                    setAccountId(a);
                    close();
                  }}
                >
                  <span className="flex items-center gap-2">
                    <AccountIcon id={a} />
                    {accountLabel(a)}
                    {a !== accountLabel(a) && <span className="text-[11px] text-faint">{/^paper/i.test(a) ? a : ""}</span>}
                  </span>
                </MenuItem>
              ))
            }
          </Dropdown>
        </Field>

        <div>
          <div className="mb-1 text-xs font-medium text-muted">Allocation</div>
          <input className={inputClass} inputMode="decimal" value={allocation} onChange={(e) => setAllocation(e.target.value)} aria-label="Allocation" />
          <p className="mt-1 flex items-center text-[11px] text-faint">
            Max total capital to open positions
            <InfoTip text="The most this bot may have at risk across all open positions. The engine refuses an open that would go over it." />
          </p>
        </div>

        {view.mode === "empty" && (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            Next, open the bot&apos;s Settings tab and enter its trading inputs - quantity, width, the short strike offsets and the expected credit. They have no defaults, and
            the bot can&apos;t be switched on until they&apos;re set.
          </p>
        )}
        {view.mode === "clone" && <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">Copies the inputs, safeguards, tags and group. The copy starts switched off, with no history.</p>}
        {view.mode === "template" && <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">Starts from the template&apos;s inputs and safeguards, switched off.</p>}
        {error && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">{error}</p>}
      </div>
    </Drawer>
  );
}
