"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Card } from "@/components/ui";
import { cn } from "@/lib/format";
import { Checkbox, Field, KeyValue, Pill, buttonClass, inputClass } from "../bot/primitives";
import { clock12 } from "../builder/builtin";

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
        <KeyValue rows={[["Exit options", "Not used - positions are held to expiry"]]} />
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

/** The alert message TradingView sends for one bot and direction. The secret is a placeholder - the real one is never shown. */
export function alertBody(bot: { id: string; underlying: string | null }, signal: "bullish" | "bearish"): string {
  const symbol = bot.underlying ? `"symbol":"${bot.underlying}",` : "";
  return `{"secret":"<SECRET>","bot":"${bot.id}","signal":"${signal}",${symbol}"price":{{close}},"bar_time":"{{timenow}}","interval":"{{interval}}"}`;
}

function CopyBox({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted">{label}</span>
        <button
          className="text-xs text-accent hover:underline"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-line bg-bg px-3 py-2 font-mono text-xs">{text}</pre>
    </div>
  );
}

export interface WebhookView {
  id: string;
  name: string;
  token: string;
  path: string;
  botId: string;
  botName: string;
  underlying: string | null;
  direction: "bullish" | "bearish";
  active: boolean;
  createdAt: number;
  lastTriggeredAt: number | null;
  triggerCount: number;
}

/** What each TradingView alert sends to a named webhook: the URL already says which bot and signal, so only the price (and bar time) are needed. */
export const HOOK_MESSAGE = '{"price":{{close}},"bar_time":"{{timenow}}","interval":"{{interval}}"}';

function NewWebhookForm({ bots, onCreate }: { bots: SettingsData["webhook"]["bots"]; onCreate: (name: string, botId: string, direction: "bullish" | "bearish") => Promise<string | null> }) {
  const [name, setName] = useState("");
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [direction, setDirection] = useState<"bullish" | "bearish">("bullish");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bot = bots.find((b) => b.id === botId);
  const suggested = bot ? `${direction === "bullish" ? "Bullish" : "Bearish"}${bot.underlying ?? bot.name}` : "";

  return (
    <div className="space-y-3 rounded-xl border border-line p-3">
      <div className="text-sm font-medium">New webhook</div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested || "e.g. BullishNDX"} aria-label="Webhook name" />
        </Field>
        <Field label="Bot">
          <select className={inputClass} value={botId} onChange={(e) => setBotId(e.target.value)} aria-label="Webhook bot">
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="A call means">
          <select className={inputClass} value={direction} onChange={(e) => setDirection(e.target.value as "bullish" | "bearish")} aria-label="Webhook signal">
            <option value="bullish">Bullish → short put spread</option>
            <option value="bearish">Bearish → short call spread</option>
          </select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className={buttonClass.primary}
          disabled={busy || !botId}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const problem = await onCreate(name.trim() || suggested, botId, direction);
            setBusy(false);
            if (problem) setError(problem);
            else setName("");
          }}
        >
          {busy ? "Creating..." : "Create webhook"}
        </button>
        {error && <span className="text-sm text-down">{error}</span>}
      </div>
    </div>
  );
}

export function WebhooksSection({
  data,
  origin,
  outbound,
  hooks = [],
  onCreate = async () => null,
  onToggle = noopHook,
  onDelete = noopHook,
  onTest,
  canTest = false,
}: {
  data: SettingsData;
  origin: string;
  outbound: ReactNode;
  hooks?: WebhookView[];
  onCreate?: (name: string, botId: string, direction: "bullish" | "bearish") => Promise<string | null>;
  onToggle?: (id: string, active: boolean) => void;
  onDelete?: (id: string) => void;
  /** Sends this webhook's signal through the real path with a price. Offered on the mock and the Tradier sandbox only. */
  onTest?: (id: string, price: number) => Promise<string>;
  canTest?: boolean;
}) {
  return (
    <div className="space-y-4">
      <Section title="Your webhooks" hint="One secret URL per bot and signal, like Option Alpha's. A call to the URL means that signal for that bot - paste it into a TradingView alert. Each webhook can only be triggered once a minute; extra calls are ignored.">
        {hooks.length === 0 ? (
          <p className="text-sm text-muted">No webhooks yet. Create one below, for example a Bullish and a Bearish one for each bot.</p>
        ) : (
          <ul className="space-y-3">
            {hooks.map((h) => (
              <li key={h.id} className={cn("space-y-2 rounded-xl border border-line p-3", !h.active && "opacity-60")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">
                      {h.name} <Pill tone={h.direction === "bullish" ? "ok" : "error"}>{h.direction}</Pill>
                    </div>
                    <div className="text-xs text-muted">
                      {h.botName} · {h.direction === "bullish" ? "opens a short put spread" : "opens a short call spread"} · {h.triggerCount} call{h.triggerCount === 1 ? "" : "s"}
                      {h.lastTriggeredAt ? `, last ${new Date(h.lastTriggeredAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ", never called"}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button className={buttonClass.secondary} onClick={() => onToggle(h.id, !h.active)}>
                      {h.active ? "Switch off" : "Switch on"}
                    </button>
                    <button
                      className={buttonClass.secondary}
                      onClick={() => {
                        if (window.confirm(`Delete the webhook "${h.name}"? A TradingView alert using its URL will stop working.`)) onDelete(h.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <CopyBox label="Webhook URL (keep it secret)" text={`${origin}${h.path}`} />
                {canTest && onTest && h.active && <TestCall hook={h} onTest={onTest} />}
              </li>
            ))}
          </ul>
        )}
        <NewWebhookForm bots={data.webhook.bots} onCreate={onCreate} />
      </Section>

      <Section title="Use it in a TradingView alert">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>On the chart for the bot&apos;s index (SPX or NDX), create an alert on the <span className="text-fg">confirmed</span> bullish or bearish signal - never the raw EMA cross.</li>
          <li>Under <span className="text-fg">Notifications</span>, tick <span className="text-fg">Webhook URL</span> and paste the matching webhook&apos;s URL. (TradingView only allows webhook alerts on accounts with two-factor authentication on.)</li>
          <li>Under <span className="text-fg">Message</span>, paste the message below. The URL already says which bot and signal it is, so it only needs the price.</li>
          <li>Bullish alert → the Bullish webhook, Bearish alert → the Bearish one. Save, and watch the Automation status page for the first call.</li>
        </ol>
        <CopyBox label="Alert message" text={HOOK_MESSAGE} />
        <p className="text-xs text-muted">If the message has no price, the bot uses its underlying&apos;s live quote when it is fresh (under 5 minutes old), and refuses the call otherwise.</p>
      </Section>

      <Section title="One shared URL with a secret (advanced)" hint="The older way: a single URL, with the secret and the bot in the message body. Use it if you'd rather not manage one URL per signal.">
        <CopyBox label="Webhook URL" text={`${origin}${data.webhook.path}`} />
        <KeyValue rows={[["Secret", data.webhook.secretSet ? <Pill key="s" tone="ok">Set</Pill> : <Pill key="s" tone="error">Not set - alerts are refused until WEBHOOK_SECRET is set</Pill>], ["Repeats", "An identical alert within 2 minutes is ignored (duplicate protection)"]]} />
        <p className="text-xs text-muted">Replace &lt;SECRET&gt; with your WEBHOOK_SECRET in TradingView - it is never shown here.</p>
        {data.webhook.bots.map((b) => (
          <div key={b.id} className="space-y-2 rounded-xl border border-line p-3">
            <div className="text-sm font-medium">
              {b.name} <span className="text-xs text-faint">{b.id}</span>
            </div>
            <CopyBox label="Bullish alert message" text={alertBody(b, "bullish")} />
            <CopyBox label="Bearish alert message" text={alertBody(b, "bearish")} />
          </div>
        ))}
      </Section>
      {outbound}
    </div>
  );
}

/** A test call: the same path as TradingView's, with a price you type. */
function TestCall({ hook, onTest }: { hook: WebhookView; onTest: (id: string, price: number) => Promise<string> }) {
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const n = Number(price.replace(/,/g, ""));
  const ok = price.trim() !== "" && Number.isFinite(n) && n > 0;
  return (
    <div className="space-y-1.5 border-t border-line pt-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted">
          Test call at {hook.underlying ?? "price"}
          <input className="ml-2 w-28 rounded-lg border border-line bg-bg px-2 py-1 text-right text-sm text-fg outline-none focus:border-accent" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="price" aria-label={`Test price for ${hook.name}`} />
        </label>
        <button
          className={buttonClass.secondary}
          disabled={busy || !ok}
          onClick={async () => {
            setBusy(true);
            setResult(await onTest(hook.id, n));
            setBusy(false);
          }}
        >
          {busy ? "Sending…" : "Send a test call"}
        </button>
      </div>
      {result && <p className="text-xs text-muted">{result}</p>}
    </div>
  );
}

function noopHook() {}

/** The old outbound feature (rules that call Option Alpha webhooks) stays behind a button, so opening Settings never loads it. */
export function OutboundGate({ shown, onShow, children }: { shown: boolean; onShow: () => void; children: ReactNode }) {
  return (
    <Section title="Option Alpha connections (outbound)" hint="The separate Rules feature: webhooks this app calls, not the alerts it receives. It loads only when you open it.">
      {shown ? children : <button className={buttonClass.secondary} onClick={onShow}>Show connections</button>}
    </Section>
  );
}
