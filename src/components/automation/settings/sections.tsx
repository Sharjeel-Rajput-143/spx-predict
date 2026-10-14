"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Card } from "@/components/ui";
import { cn } from "@/lib/format";
import { Btn, Checkbox, Field, inputClass, KeyValue, Pill } from "../bot/primitives";
import { clock12 } from "../builder/builtin";
import { EditWebhookDrawer, NewWebhookDrawer, WebhookIntro, WebhookRow } from "./WebhookList";

/** Shape of GET /api/automation/settings. */
export interface SettingsData {
  settings: {
    tradingWindow: { start: string; end: string } | null;
    emailAlerts: { enabled: boolean; to: string; onTrade: boolean; onWarningError: boolean; includeTest: boolean };
    notifications: { trades: boolean; warnings: boolean };
    sessionTimeoutMinutes: number;
  };
  window: { start: string; end: string; source: "settings" | "environment"; timezone: string };
  email: { enabled: boolean; to: string | null; senderWired: boolean };
  sessionTimeoutChoices: number[];
  signInRequired: boolean;
  executor: { kind: "mock" | "tradier" | "ibkr" | null; venue: "mock" | "tradier" | "ibkr" | null; error: string | null; baseUrl?: string; sandbox?: boolean; priceSource?: "feed" | "broker"; dryRun: boolean; testMode: boolean };
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
      <Btn kind="primary"
        
        disabled={busy || disabled}
        onClick={async () => {
          setBusy(true);
          const problem = await onSave();
          setBusy(false);
          setState(problem ? { tone: "error", text: problem } : { tone: "ok", text: "Saved." });
        }}
      >
        {busy ? "Saving..." : label}
      </Btn>
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
  const [bell, setBell] = useState(data.settings.notifications);
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
              <Btn kind="secondary"  onClick={() => save({ tradingWindow: null })}>
                Use the environment default
              </Btn>
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
        title="Notifications"
        hint="The bell in the header. Errors always show there; the rest is up to you."
        footer={<SaveBar onSave={() => save({ notifications: bell })} />}
      >
        <div className="space-y-2">
          <Checkbox checked disabled onChange={() => undefined} label="Errors (always on): a failed or rejected close, an open that was rejected or never filled, an unsafe account, a broker mismatch" />
          <Checkbox checked={bell.warnings} onChange={(v) => setBell({ ...bell, warnings: v })} label="Warnings: a safeguard stopped a signal (no live price, price out of range, a limit reached)" />
          <Checkbox checked={bell.trades} onChange={(v) => setBell({ ...bell, trades: v })} label="Trades: a position was opened or closed" />
        </div>
        <p className="text-xs text-muted">The same alert is listed once (a repeat inside an hour is counted, not listed again), and the latest 200 are kept. The red &quot;Needs attention&quot; banner on a bot is separate and stays.</p>
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
  venue: "mock" | "tradier" | "ibkr" | null;
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
            <Btn kind="secondary"  onClick={onRefresh} disabled={!onRefresh}>
              Refresh
            </Btn>
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
          <KeyValue rows={[["Executor", x.venue === "ibkr" ? (x.sandbox ? "Interactive Brokers paper account, through the bridge" : "Interactive Brokers LIVE account, through the bridge") : x.sandbox ? "Tradier sandbox (paper money)" : "Tradier production"], ["Address", <span key="a" className="font-mono text-xs">{x.baseUrl}</span>], ...(x.venue === "ibkr" ? [["Prices", x.priceSource === "broker" ? "From the broker (the bridge)" : "From the public feed"] as [string, string]] : []), ["Mode", x.dryRun ? "Dry run" : "Live orders"]]} />
        )}
        {x.venue === "mock" && <p className="text-xs text-muted">Brokers (Tradier, Interactive Brokers) are built behind this switch but disabled (BROKER=internal). They are not connected to any account.</p>}
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
        <Btn kind="secondary"  disabled title="Brokerage accounts can't be connected yet: the broker decision is still open.">
          Add account
        </Btn>
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
                <Btn kind="secondary"  onClick={() => onRestore(b.id)}>
                  Restore
                </Btn>
                {!b.builtIn && (
                  <Btn kind="secondary"
                    
                    onClick={() => {
                      if (window.confirm(`Delete "${b.name}" and its history? This can't be undone.`)) onDelete(b.id);
                    }}
                  >
                    Delete
                  </Btn>
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
          <Btn kind="primary"  onClick={() => setCreating(true)}>
            New Webhook
          </Btn>
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
      <Btn kind="secondary"
        
        disabled={busy}
        aria-label={`Send a test call for ${hook.name}`}
        onClick={async () => {
          setBusy(true);
          setResult(await onTest(hook.id));
          setBusy(false);
        }}
      >
        {busy ? "Sending…" : "Send a test call"}
      </Btn>
      {result && <p className="text-xs text-muted">{result}</p>}
    </div>
  );
}

function noopHook() {}
