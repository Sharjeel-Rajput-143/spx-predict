"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Card } from "@/components/ui";
import { cn } from "@/lib/format";
import { Checkbox, Field, KeyValue, Pill, buttonClass, inputClass } from "../bot/primitives";
import { clock12 } from "../builder/builtin";
import { EditWebhookDrawer, NewWebhookDrawer, WebhookIntro, WebhookRow } from "./WebhookList";

/** Shape of GET /api/automation/settings. */
export interface SettingsData {
  settings: {
    tradingWindow: { start: string; end: string } | null;
    emailAlerts: { enabled: boolean; to: string; onTrade: boolean; onWarningError: boolean; includeTest: boolean };
    sessionTimeoutMinutes: number;
  };
  window: { start: string; end: string; source: "settings" | "environment"; timezone: string };
  email: { enabled: boolean; to: string | null; senderWired: boolean };
  sessionTimeoutChoices: number[];
  signInRequired: boolean;
  executor: { kind: "mock" | "tradier" | null; venue: "mock" | "tradier" | null; error: string | null; baseUrl?: string; sandbox?: boolean; dryRun: boolean; testMode: boolean };
  accounts: { id: string; bots: string[] }[];
  webhook: { path: string; secretSet: boolean; bots: { id: string; name: string; underlying: string | null }[] };
}

export type SavePatch = Record<string, unknown>;
type Save = (patch: SavePatch) => Promise<string | null>;

export const TEXT_SIZES = { small: 14, normal: 16, large: 18 } as const;
export type TextSize = keyof typeof TEXT_SIZES;
export const TEXT_SIZE_KEY = "automation:text-size";

/** Every 5 minutes from 9:30am to 4:00pm - how Option Alpha lists its times. */
const MARKS: string[] = [];
for (let m = 9 * 60 + 30; m <= 16 * 60; m += 5) MARKS.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
const withCurrent = (options: string[], current: string) => (options.includes(current) ? options : [...options, current].sort());

const minutesLabel = (m: number) => (m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`);

function Section({ title, hint, children, footer }: { title: string; hint?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
      {footer && <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">{footer}</div>}
    </Card>
  );
}

/** A Save button that reports what happened next to it. */
function SaveBar({ onSave, disabled, label = "Save" }: { onSave: () => Promise<string | null>; disabled?: boolean; label?: string }) {
  const [state, setState] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        className={buttonClass.primary}
        disabled={busy || disabled}
        onClick={async () => {
          setBusy(true);
          const problem = await onSave();
          setBusy(false);
          setState(problem ? { tone: "error", text: problem } : { tone: "ok", text: "Saved." });
        }}
      >
        {busy ? "Saving..." : label}
      </button>
      {state && <span className={cn("text-sm", state.tone === "ok" ? "text-up" : "text-down")}>{state.text}</span>}
    </>
  );
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

export function GeneralSection({ data, save }: { data: SettingsData; save: Save }) {
  const [from, setFrom] = useState(data.window.start);
  const [to, setTo] = useState(data.window.end);
  const e = data.settings.emailAlerts;
  const [email, setEmail] = useState(e);
  const [timeout, setTimeoutMinutes] = useState(data.settings.sessionTimeoutMinutes);
  const [size, setSize] = useState<TextSize>("normal");
  useEffect(() => {
    try {
      const stored = localStorage.getItem(TEXT_SIZE_KEY) as TextSize | null;
      if (stored && stored in TEXT_SIZES) setSize(stored);
    } catch {
      /* storage unavailable: stay on Normal */
    }
  }, []);
  const chooseSize = (s: TextSize) => {
    setSize(s);
    try {
      localStorage.setItem(TEXT_SIZE_KEY, s);
    } catch {
      /* ignore */
    }
    document.documentElement.style.fontSize = `${TEXT_SIZES[s]}px`;
  };

  return (
    <div className="space-y-4">
      <Section
        title="Bot schedule"
        hint={`When signals are acted on, in ${data.window.timezone === "America/New_York" ? "New York" : data.window.timezone} time. Weekdays only; the NYSE holiday and early-close calendar always applies.`}
        footer={
          <>
            <SaveBar onSave={() => save({ tradingWindow: { start: from, end: to } })} disabled={from >= to} />
            {data.window.source === "settings" && (
              <button className={buttonClass.secondary} onClick={() => save({ tradingWindow: null })}>
                Use the environment default
              </button>
            )}
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Automations run from">
            <select className={inputClass} value={from} onChange={(ev) => setFrom(ev.target.value)} aria-label="Window start">
              {withCurrent(MARKS, from).map((m) => (
                <option key={m} value={m}>
                  {clock12(m)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="to">
            <select className={inputClass} value={to} onChange={(ev) => setTo(ev.target.value)} aria-label="Window end">
              {withCurrent(MARKS, to).map((m) => (
                <option key={m} value={m}>
                  {clock12(m)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {from >= to && <p className="text-sm text-down">The start has to be before the end.</p>}
        <p className="text-xs text-muted">
          This is the default for every bot. A bot can have its own window on its Bullish/Bearish canvas, which wins over this. Currently {data.window.source === "settings" ? "saved here" : "the environment's"}: {clock12(data.window.start)} - {clock12(data.window.end)}.
        </p>
        <KeyValue rows={[["Exit options", "Set per bot, on the Open Position step of a trigger; positions without them are held until the opposite signal or the end of the day"]]} />
      </Section>

      <Section title="Positions at expiry" hint="What happens to a position that is still open when the day ends.">
        <KeyValue
          rows={[
            ["Auto-close", "Never - the engine sends no closing order at expiry"],
            ["End-of-day sweep", "Marks every active position expired, at each bot's own sweep time (default 4:05pm ET)"],
            ["Estimated P/L", "Only from prices an executor reports; blank otherwise (nothing is estimated)"],
          ]}
        />
      </Section>

      <Section
        title="Email notifications"
        hint="Activity alerts (opened, closed, warning, error) always show on the status page. Email is optional and off by default."
        footer={<SaveBar onSave={() => save({ emailAlerts: email })} />}
      >
        <Checkbox checked={email.enabled} onChange={(v) => setEmail({ ...email, enabled: v })} label="Send alerts by email" />
        <Field label="Send to">
          <input className={inputClass} type="email" value={email.to} onChange={(ev) => setEmail({ ...email, to: ev.target.value })} placeholder="name@example.com" aria-label="Email address" />
        </Field>
        <div className="space-y-2">
          <Checkbox checked={email.onTrade} onChange={(v) => setEmail({ ...email, onTrade: v })} label="When a position is opened or closed" />
          <Checkbox checked={email.onWarningError} onChange={(v) => setEmail({ ...email, onWarningError: v })} label="Warnings and errors" />
          <Checkbox checked={email.includeTest} onChange={(v) => setEmail({ ...email, includeTest: v })} label="Include test trades (the mock executor's)" />
        </div>
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          No mail sender is connected yet, so switching this on only queues each alert - nothing is sent. Choosing a provider is the owner&apos;s call. Each bot also has its own four alert switches under Settings &gt; Alerts.
        </p>
      </Section>

      <Section
        title="Session timeout"
        hint={data.signInRequired ? "How long a sign-in lasts." : "Sign-in isn't required in this setup (no password is set), so this has no effect yet."}
        footer={<SaveBar onSave={() => save({ sessionTimeoutMinutes: timeout })} />}
      >
        <Field label="Sign out after">
          <select className={inputClass} value={timeout} onChange={(ev) => setTimeoutMinutes(Number(ev.target.value))} aria-label="Session timeout">
            {data.sessionTimeoutChoices.map((m) => (
              <option key={m} value={m}>
                {minutesLabel(m)}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Text size" hint="Saved in this browser.">
        <div className="inline-flex divide-x divide-line overflow-hidden rounded-lg border border-line" role="radiogroup" aria-label="Text size">
          {(Object.keys(TEXT_SIZES) as TextSize[]).map((s) => (
            <button key={s} role="radio" aria-checked={size === s} onClick={() => chooseSize(s)} className={cn("px-4 py-2 text-sm capitalize transition-colors", size === s ? "bg-accent/10 font-medium text-accent" : "text-muted hover:text-fg")}>
              {s}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Sign-in &amp; two-step authentication">
        <KeyValue
          rows={[
            ["Sign-in", data.signInRequired ? "Required - one shared password" : "Not required (local development)"],
            ["Two-step authentication", <Pill key="2fa">Not available yet</Pill>],
          ]}
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trading accounts
// ---------------------------------------------------------------------------

export interface BrokerView {
  venue: "mock" | "tradier" | null;
  sandbox: boolean | null;
  error: string | null;
  balances: { accountId: string; totalEquity: number | null; optionBuyingPower: number | null; cash: number | null } | null;
}

const money = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

export function AccountsSection({ data, broker, onRefresh }: { data: SettingsData; broker?: BrokerView | null; onRefresh?: () => void }) {
  const x = data.executor;
  return (
    <div className="space-y-4">
      {x.venue === "tradier" && !x.error && (
        <Section
          title="Broker account"
          hint={x.sandbox ? "Tradier's sandbox: a paper account with a test balance. No real money." : "Tradier PRODUCTION: a real account."}
          footer={
            <button className={buttonClass.secondary} onClick={onRefresh} disabled={!onRefresh}>
              Refresh
            </button>
          }
        >
          {!broker ? (
            <p className="text-sm text-muted">Loading...</p>
          ) : broker.error ? (
            <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">Couldn&apos;t read the account: {broker.error}</p>
          ) : broker.balances ? (
            <KeyValue
              rows={[
                ["Account", broker.balances.accountId],
                ["Total equity", money(broker.balances.totalEquity)],
                ["Option buying power", money(broker.balances.optionBuyingPower)],
                ["Cash", money(broker.balances.cash)],
              ]}
            />
          ) : (
            <p className="text-sm text-muted">No balances reported.</p>
          )}
        </Section>
      )}
      <Section title="Executor" hint="Who places the orders.">
        {x.error ? (
          <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">Not usable: {x.error}</p>
        ) : x.venue === "mock" ? (
          <KeyValue rows={[["Executor", "Mock - test trades only, nothing reaches a broker"], ["Mode", x.dryRun ? "Dry run: decisions only, no orders" : "Orders go to the mock"], ["Testing mode", x.testMode ? "On: test alerts ignore trading hours" : "Off"]]} />
        ) : (
          <KeyValue rows={[["Executor", x.sandbox ? "Tradier sandbox (paper money)" : "Tradier production"], ["Address", <span key="a" className="font-mono text-xs">{x.baseUrl}</span>], ["Mode", x.dryRun ? "Dry run" : "Live orders"]]} />
        )}
        <p className="text-xs text-muted">Tradier is built behind this switch but disabled (EXECUTOR=mock). It is not connected to any account.</p>
      </Section>

      <Section title="Accounts" hint="The accounts your bots trade on.">
        <ul className="divide-y divide-line">
          {data.accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div>
                <div className="text-sm font-medium">{a.id}</div>
                <div className="text-xs text-muted">{a.bots.length > 0 ? a.bots.join(", ") : "No bots use it yet"}</div>
              </div>
              <Pill tone="warn">Paper · mock executor</Pill>
            </li>
          ))}
        </ul>
        <button className={buttonClass.secondary} disabled title="Brokerage accounts can't be connected yet: the broker decision is still open.">
          Add account
        </button>
        <p className="text-xs text-muted">Connecting a brokerage account waits on the broker decision. A bot&apos;s account is set in its own settings.</p>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bot archive
// ---------------------------------------------------------------------------

export interface ArchivedBot {
  id: string;
  name: string;
  builtIn: boolean;
  group: string | null;
}

export function ArchiveSection({ bots, onRestore, onDelete }: { bots: ArchivedBot[]; onRestore: (id: string) => void; onDelete: (id: string) => void }) {
  return (
    <Section title="Bot archive" hint="Archived bots are switched off and hidden from the Automation list. Their history is kept.">
      {bots.length === 0 ? (
        <p className="text-sm text-muted">No bots archived yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {bots.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div>
                <div className="text-sm font-medium">{b.name}</div>
                <div className="text-xs text-muted">
                  {b.id}
                  {b.group ? ` · ${b.group}` : ""}
                </div>
              </div>
              <div className="flex gap-2">
                <button className={buttonClass.secondary} onClick={() => onRestore(b.id)}>
                  Restore
                </button>
                {!b.builtIn && (
                  <button
                    className={buttonClass.secondary}
                    onClick={() => {
                      if (window.confirm(`Delete "${b.name}" and its history? This can't be undone.`)) onDelete(b.id);
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface WebhookView {
  id: string;
  name: string;
  /** The URL path with its secret masked. The full one is fetched on demand (Reveal / Copy). */
  path: string;
  attached: boolean;
  botId: string | null;
  botName: string | null;
  underlying: string | null;
  direction: "bullish" | "bearish" | null;
  active: boolean;
  createdAt: number;
  lastTriggeredAt: number | null;
  triggerCount: number;
  /** The alert's text must say the webhook's direction. */
  requireDirectionText?: boolean;
}

export function WebhooksSection({
  data,
  origin,
  hooks = [],
  onCreate = async () => null,
  onToggle = noopHook,
  onRequireText = noopHook,
  onDelete = noopHook,
  onRename = async () => null,
  onTest,
  canTest = false,
}: {
  data: SettingsData;
  origin: string;
  hooks?: WebhookView[];
  onCreate?: (name: string) => Promise<string | null>;
  onToggle?: (id: string, active: boolean) => void;
  onRequireText?: (id: string, on: boolean) => void;
  onDelete?: (id: string) => void;
  /** Renames a webhook; resolves to a problem to show, or null. */
  onRename?: (id: string, name: string) => Promise<string | null>;
  /** Sends this webhook's signal through the real path with a price. Offered on the mock and the Tradier sandbox only. */
  onTest?: (id: string) => Promise<string>;
  canTest?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const editingHook = hooks.find((h) => h.id === editing);
  return (
    <div className="space-y-4">
      <Section title="Webhooks">
        <WebhookIntro />
        <div>
          <button className={buttonClass.primary} onClick={() => setCreating(true)}>
            New Webhook
          </button>
        </div>
        {hooks.length > 0 && (
          <ul>
            {hooks.map((h) => (
              <WebhookRow key={h.id} hook={h} origin={origin} onEdit={() => setEditing(h.id)} onDelete={onDelete} testSlot={canTest && onTest && h.active && h.attached ? <TestCall hook={h} onTest={onTest} /> : undefined} />
            ))}
          </ul>
        )}
        {creating && <NewWebhookDrawer onCreate={onCreate} onClose={() => setCreating(false)} />}
        {editingHook && <EditWebhookDrawer key={editingHook.id} hook={editingHook} onRename={onRename} onToggle={onToggle} onRequireText={onRequireText} onClose={() => setEditing(null)} />}
      </Section>

    </div>
  );
}

/** A test call: the same path as TradingView's, on the live quote (no price to type, as a real call has none). */
function TestCall({ hook, onTest }: { hook: WebhookView; onTest: (id: string) => Promise<string> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="space-y-1.5 border-t border-line pt-2">
      <button
        className={buttonClass.secondary}
        disabled={busy}
        aria-label={`Send a test call for ${hook.name}`}
        onClick={async () => {
          setBusy(true);
          setResult(await onTest(hook.id));
          setBusy(false);
        }}
      >
        {busy ? "Sending…" : "Send a test call"}
      </button>
      {result && <p className="text-xs text-muted">{result}</p>}
    </div>
  );
}

function noopHook() {}
