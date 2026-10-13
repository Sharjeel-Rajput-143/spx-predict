"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cn, formatTime } from "@/lib/format";
import { Card, SectionTitle, Stat } from "@/components/ui";
import { Pill } from "./bot/primitives";
import { usePolling } from "./usePolling";

export interface StatusBot {
  id: string;
  name: string;
  underlying: string | null;
  enabled: boolean;
  killSwitch?: boolean;
  needsAttention: boolean;
  needsAttentionReason: string | null;
  configError: string | null;
  missingSettings: { key: string; why: string }[] | null;
  errorCountToday: number;
  errorFailsafeThreshold: number;
  newPositionsToday: number;
  dailyNewPositionLimit: number;
  activePositionCount: number;
  closedPositionCount: number;
  totalPositionLimit: number;
  suggestedPrice: number | null;
  allocation: number | null;
  atRisk: number;
  available: number | null;
  settings: {
    quantity: number;
    widthPoints: number;
    strikeIncrement: number;
    putShortOffset: number;
    callShortOffset: number;
    strikeRounding: "outward" | "nearest";
    openPricePercent: number;
    closePricePercent: number;
    smartPricing: "normal" | "fast" | "patient" | "off";
    window: string;
    alerts: { open: boolean; close: boolean; warning: boolean; error: boolean };
  } | null;
}

export interface StatusAlert {
  id: string;
  botId: string;
  kind: "open" | "close" | "warning" | "error";
  outcome: string;
  message: string;
  createdAt: number;
  email: "off" | "queued";
}

export interface StatusPosition {
  id: string;
  botId: string;
  underlying: string;
  type: "short_put_spread" | "short_call_spread";
  status: string;
  shortStrike: number;
  longStrike: number;
  requestedQuantity: number;
  filledQuantity: number;
  expiry: string;
  credit: number | null;
  closePrice?: number | null;
  openedAt: number | null;
  closedAt: number | null;
  venue?: "mock" | "tradier" | "ibkr";
  test?: boolean;
  /** How an expired position's result was settled (estimated from the underlying, or typed in). */
  settlement?: { kind: "estimated" | "manual"; pl: number; underlyingPrice?: number };
}

export interface StatusOrder {
  id: string;
  botId: string | null;
  kind: "open" | "close";
  status: string;
  limitPrice: number;
  filledQuantity: number;
  rejectReason?: string;
  createdAt: number;
  positionType: StatusPosition["type"] | null;
  shortStrike: number | null;
  longStrike: number | null;
  underlying: string | null;
  venue: "mock" | "tradier" | "ibkr";
}

export interface StatusSignal {
  id: string;
  botId: string;
  signal: string;
  price: number;
  status: string;
  rejectReason: string | null;
  receivedAt: number;
  test: boolean;
  symbol: unknown;
  decisions: { id: string; outcome: string; reason: string; createdAt: number; strikePlan?: string | null }[];
}

export interface StatusExecutor {
  kind: "mock" | "tradier" | "ibkr" | null;
  venue: "mock" | "tradier" | "ibkr" | null;
  error: string | null;
  baseUrl?: string;
  sandbox?: boolean;
  priceSource?: "feed" | "broker";
  dryRun: boolean;
  testMode: boolean;
}

export interface ReconcileView {
  checkedAt: number;
  ok: boolean;
  expectedLegs: number;
  brokerLegs: number;
  problems: { kind: string; symbol: string; text: string }[];
}

export interface StatusResponse {
  now: number;
  executor: StatusExecutor;
  /** Set when this host can't keep the bots' records (a serverless host). */
  storageProblem?: string | null;
  bots: StatusBot[];
  positions: StatusPosition[];
  orders: StatusOrder[];
  signals: StatusSignal[];
  alerts: StatusAlert[];
  alertEmail: { enabled: boolean; to: string | null };
}

const POLL_MS = 3000;
const ACTIVE = ["opening", "open", "closing"];
const fmtNum = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const signedUsd = (n: number) => `${n < 0 ? "-" : n > 0 ? "+" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A finished position's result and where it came from; null when it has none (yet). */
function resultOf(p: StatusPosition): { pl: number; how: "fill" | "estimated" | "manual" } | null {
  if (p.status === "expired") return p.settlement ? { pl: p.settlement.pl, how: p.settlement.kind } : null;
  if (p.status === "closed" && p.closePrice != null && p.credit != null) return { pl: (p.credit - p.closePrice) * 100 * (p.filledQuantity || p.requestedQuantity), how: "fill" };
  return null;
}

const typeName = (t: string) => (t === "short_put_spread" ? "Short put spread" : t === "short_call_spread" ? "Short call spread" : t);

/** "-20,975 put / +20,965 put" - the short leg sold, the long leg bought. */
export function legsText(p: { type: string | null; shortStrike: number | null; longStrike: number | null }): string {
  if (p.shortStrike == null || p.longStrike == null) return "—";
  const right = p.type === "short_call_spread" ? "call" : "put";
  return `-${fmtNum(p.shortStrike)} ${right} / +${fmtNum(p.longStrike)} ${right}`;
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const signedPts = (n: number) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
const ALERT_LABEL: Record<StatusAlert["kind"], string> = { open: "Opened", close: "Closed", warning: "Warning", error: "Error" };
const ALERT_TONE: Record<StatusAlert["kind"], "ok" | "info" | "warn" | "error"> = { open: "ok", close: "info", warning: "warn", error: "error" };

const isTest = (venue?: string, test?: boolean) => test === true || (venue ?? "mock") === "mock";

/** Marks a trade that never reached a broker. */
export function TestTag() {
  return <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-amber-500">TEST</span>;
}

const OUTCOME_TONE: Record<string, "ok" | "warn" | "error" | "skip"> = {
  opened: "ok",
  closed: "ok",
  dry_run: "skip",
};
const outcomeTone = (o: string) => OUTCOME_TONE[o] ?? (/rejected|error|invalid|mismatch|out_of_range|timeout|partial/.test(o) ? "error" : "warn");

const STATUS_TONE: Record<string, "ok" | "warn" | "error" | "skip" | "info"> = {
  open: "ok",
  filled: "ok",
  opening: "info",
  closing: "info",
  working: "info",
  partially_filled: "warn",
  closed: "skip",
  expired: "skip",
  canceled: "skip",
  rejected: "error",
  accepted: "ok",
};

function Table({ headers, rows, empty }: { headers: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-faint">
            {headers.map((h) => (
              <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-line">
              {row.map((cell, j) => (
                <td key={j} className="whitespace-nowrap px-2 py-1.5 text-fg">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultCell({ p }: { p: StatusPosition }) {
  const r = resultOf(p);
  if (!r) return <span className="text-faint">{p.status === "expired" ? "to enter" : "—"}</span>;
  return (
    <span className={cn("tabular", r.pl > 0 && "text-up", r.pl < 0 && "text-down")} title={r.how === "estimated" ? "Estimated from the underlying's price at the end-of-day sweep" : r.how === "manual" ? "Entered by hand" : "From the close order's fill"}>
      {signedUsd(r.pl)}
      {r.how !== "fill" && <span className="ml-1 text-[10px] font-medium text-faint">{r.how === "estimated" ? "est." : "by hand"}</span>}
    </span>
  );
}

/** Positions that expired with no result: the sweep was set to manual, or had no price to estimate from. */
function AwaitingResult({ positions, botName, onEnter }: { positions: StatusPosition[]; botName: (id: string | null) => string; onEnter?: (id: string, pl: number) => Promise<string | null> }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (positions.length === 0) return null;
  const save = async (id: string) => {
    const pl = Number((drafts[id] ?? "").replace(/[$,\s]/g, ""));
    if (!onEnter || !(drafts[id] ?? "").trim() || !Number.isFinite(pl)) return setErrors((e) => ({ ...e, [id]: "Type the result in dollars, e.g. 125 or -310." }));
    const problem = await onEnter(id, pl);
    setErrors((e) => ({ ...e, [id]: problem ?? "" }));
  };
  return (
    <Card className="space-y-2 p-4">
      <SectionTitle>Waiting for your P/L</SectionTitle>
      <p className="text-xs text-muted">These expired without a fill to price them by. Enter each one&apos;s result (total dollars for the position, negative for a loss) from your broker&apos;s statement.</p>
      <ul className="divide-y divide-line">
        {positions.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <span className="text-muted">{botName(p.botId)}</span>
            <span className="font-mono text-xs">{legsText(p)}</span>
            <span className="text-xs text-faint">
              {p.filledQuantity || p.requestedQuantity} contract{(p.filledQuantity || p.requestedQuantity) === 1 ? "" : "s"}, credit {p.credit != null ? `$${p.credit.toFixed(2)}` : "unknown"} · {p.expiry}
            </span>
            <span className="ml-auto flex items-center gap-2">
              <input
                aria-label={`P/L for ${legsText(p)}`}
                value={drafts[p.id] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                inputMode="decimal"
                placeholder="$ result"
                className="w-28 rounded-lg border border-line bg-surface px-2 py-1 text-sm"
              />
              <button onClick={() => save(p.id)} className="rounded-lg border border-line px-3 py-1 text-xs font-medium hover:bg-surface-2">
                Save
              </button>
            </span>
            {errors[p.id] && <span className="w-full text-xs text-down">{errors[p.id]}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ExecutorBanner({ executor }: { executor: StatusExecutor }) {
  if (executor.error) {
    return (
      <div className="rounded-xl bg-down-soft px-4 py-3 text-sm text-down">
        <span className="font-semibold">Executor not usable — signals are refused until this is fixed.</span> {executor.error}
      </div>
    );
  }
  const mock = executor.venue === "mock";
  const live = !mock && !executor.sandbox;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-3 text-sm", mock ? "bg-amber-500/10 text-amber-500" : live ? "bg-down-soft text-down" : "bg-accent/10 text-accent")}>
      <span className="font-semibold">
        {mock ? "Mock executor — test trades only. Nothing reaches a broker." : executor.venue === "ibkr" ? (live ? "LIVE — Interactive Brokers: real money" : "Interactive Brokers PAPER (paper money)") : live ? "LIVE — Tradier PRODUCTION: real money" : "Tradier SANDBOX (paper money)"}
      </span>
      {!mock && executor.baseUrl && <span className="font-mono text-xs">{executor.baseUrl}</span>}
      {executor.dryRun && <Pill tone="warn">Dry run: decisions only, no orders</Pill>}
      {executor.testMode ? <Pill tone="info">Testing mode: test alerts ignore trading hours</Pill> : <Pill tone="neutral">Test alerts follow trading hours</Pill>}
    </div>
  );
}

function BotCard({
  bot,
  executor,
  busy,
  result,
  onToggle,
  onKill,
  onSend,
}: {
  bot: StatusBot;
  executor: StatusExecutor;
  busy: boolean;
  result: string | null;
  onToggle: (id: string) => void;
  /** The kill switch: stops every webhook run for the bot, closes included. */
  onKill?: (id: string) => void;
  onSend: (bot: StatusBot, signal: "bullish" | "bearish", price: number) => void;
}) {
  const [price, setPrice] = useState<string>(bot.suggestedPrice != null ? String(bot.suggestedPrice) : "");
  const [touched, setTouched] = useState(false);
  // Follow the suggestion (the last signal's price) until the person types their own.
  useEffect(() => {
    if (!touched && bot.suggestedPrice != null) setPrice(String(bot.suggestedPrice));
  }, [bot.suggestedPrice, touched]);

  const parsed = Number(price.replace(/,/g, ""));
  const priceOk = price.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
  // Test alerts run on the mock and on the Tradier sandbox (paper money) - never against a production account.
  const safeVenue = executor.venue === "mock" || ((executor.venue === "tradier" || executor.venue === "ibkr") && executor.sandbox === true);
  const canTest = safeVenue && !executor.error && !bot.configError;
  const why = !canTest ? (!safeVenue ? "Test alerts never run against real money: they need the mock executor or a paper broker account." : executor.error ? "The executor isn't usable." : "Finish this bot's setup first.") : !priceOk ? "Enter a test price." : "";

  return (
    <Card className="space-y-3 p-4" >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{bot.name}</div>
          <div className="text-xs text-faint">
            {bot.id}
            {bot.underlying ? ` · ${bot.underlying}` : ""}
          </div>
        </div>
        <button
          onClick={() => onToggle(bot.id)}
          disabled={busy}
          aria-label={`Bot ${bot.enabled ? "on" : "off"}`}
          className={cn("rounded-lg px-3 py-1.5 text-xs font-medium transition-colors", bot.enabled ? "bg-up-soft text-up" : "bg-surface-2 text-muted")}
        >
          {bot.enabled ? "On" : "Off"} — click to {bot.enabled ? "turn off" : "turn on"}
        </button>
      </div>

      {!bot.enabled && !bot.killSwitch && (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          Bot off: a webhook can still <span className="font-medium text-fg">close</span> the opposite position, but never opens one.
        </p>
      )}
      {onKill && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-xs">
          <span className={bot.killSwitch ? "font-semibold text-down" : "text-muted"}>
            {bot.killSwitch ? "Kill switch ON: every webhook run is blocked, closes included." : "Kill switch off. Turn it on to block every webhook run, closes included."}
          </span>
          <button
            onClick={() => onKill(bot.id)}
            disabled={busy}
            aria-label={`Kill switch ${bot.killSwitch ? "on" : "off"}`}
            className={cn("rounded-lg px-3 py-1.5 font-medium transition-colors", bot.killSwitch ? "bg-down text-white" : "border border-down/40 text-down")}
          >
            {bot.killSwitch ? "Turn kill switch off" : "Kill switch"}
          </button>
        </div>
      )}

      {bot.configError && (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          <div className="font-semibold">Setup needed — this bot can&apos;t trade yet</div>
          {bot.missingSettings && bot.missingSettings.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {bot.missingSettings.map((m) => (
                <li key={m.key}>
                  <span className="font-mono">{m.key.replace(/^BOT_[A-Z]+_EMA_BIAS_/, "")}</span> <span className="opacity-80">— {m.why}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 opacity-90">{bot.configError}</p>
          )}
        </div>
      )}
      {bot.needsAttention && (
        <div className="rounded-lg bg-down-soft px-3 py-2 text-xs text-down">Needs attention{bot.needsAttentionReason ? `: ${bot.needsAttentionReason}` : ""}</div>
      )}

      {/* The same numbers the owner reads in Option Alpha. */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Allocation" value={bot.allocation != null ? usd(bot.allocation) : "—"} />
        <Stat label="Capital at risk" value={usd(bot.atRisk)} />
        <Stat label="Available" value={bot.available != null ? usd(bot.available) : "—"} />
        <Stat label="Positions today" value={`${bot.newPositionsToday}/${bot.dailyNewPositionLimit}`} />
        <Stat label="Active positions" value={`${bot.activePositionCount}/${bot.totalPositionLimit}`} />
        <Stat label="Errors today" value={`${bot.errorCountToday}/${bot.errorFailsafeThreshold}`} />
      </div>
      {bot.settings && (
        <p className="text-xs text-muted">
          {bot.settings.quantity} × {bot.settings.widthPoints}-pt spreads, window {bot.settings.window}. Short put {signedPts(bot.settings.putShortOffset)} / short call {signedPts(bot.settings.callShortOffset)} from the price, rounded{" "}
          {bot.settings.strikeRounding === "outward" ? "out of the money (put down, call up)" : "to the nearest"} to {bot.settings.strikeIncrement}. Orders at {bot.settings.openPricePercent}% (open) / {bot.settings.closePricePercent}% (close) of bid/ask, SmartPricing {bot.settings.smartPricing} (needs live quotes).
        </p>
      )}

      <div className="space-y-2 border-t border-line pt-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-faint">Send test alert</span>
          {executor.venue === "mock" ? <TestTag /> : <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-accent">PAPER</span>}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          {bot.underlying ?? "Index"} price in the alert
          <input
            inputMode="decimal"
            value={price}
            onChange={(e) => {
              setTouched(true);
              setPrice(e.target.value);
            }}
            aria-label={`Test price for ${bot.name}`}
            className="w-28 rounded-lg border border-line bg-surface px-2 py-1 text-right text-sm text-fg outline-none focus:border-fg"
          />
        </label>
        <div className="flex gap-2">
          <button
            disabled={busy || !canTest || !priceOk}
            title={why}
            onClick={() => onSend(bot, "bullish", parsed)}
            className="flex-1 rounded-lg bg-up-soft px-3 py-2 text-sm font-medium text-up transition-colors hover:brightness-110 disabled:opacity-40"
          >
            Bullish → short put spread
          </button>
          <button
            disabled={busy || !canTest || !priceOk}
            title={why}
            onClick={() => onSend(bot, "bearish", parsed)}
            className="flex-1 rounded-lg bg-down-soft px-3 py-2 text-sm font-medium text-down transition-colors hover:brightness-110 disabled:opacity-40"
          >
            Bearish → short call spread
          </button>
        </div>
        {why && <p className="text-xs text-faint">{why}</p>}
        {result && <p className="text-xs text-muted">{result}</p>}
      </div>
    </Card>
  );
}

/** The whole page, given data. Kept free of fetching so it can be rendered on its own. */
export function StatusView({
  data,
  busyBot,
  results,
  onToggle,
  onKill,
  onSend,
  onReset,
  reconcile,
  onEnterPL,
}: {
  data: StatusResponse;
  busyBot: string | null;
  results: Record<string, string>;
  onToggle: (id: string) => void;
  onKill?: (id: string) => void;
  onSend: (bot: StatusBot, signal: "bullish" | "bearish", price: number) => void;
  onReset: () => void;
  /** Shown only with a broker executor: compare our open positions with what the broker holds. */
  reconcile?: { report: ReconcileView | null; busy: boolean; error: string | null; onRun: () => void };
  /** Saves a typed-in P/L for an expired position; resolves to a problem to show, or null when it saved. */
  onEnterPL?: (positionId: string, pl: number) => Promise<string | null>;
}) {
  const botName = (id: string | null) => data.bots.find((b) => b.id === id)?.name ?? id ?? "—";
  const active = data.positions.filter((p) => ACTIVE.includes(p.status));
  const closed = data.positions.filter((p) => !ACTIVE.includes(p.status));
  const mock = data.executor.venue === "mock";
  const awaitingResult = closed.filter((p) => p.status === "expired" && !p.settlement);

  const positionRow = (p: StatusPosition): ReactNode[] => [
    formatTime(p.openedAt ?? 0),
    <span key="bot">
      {botName(p.botId)} {isTest(p.venue, p.test) && <TestTag />}
    </span>,
    typeName(p.type),
    <span key="legs" className="font-mono text-xs">
      {legsText(p)}
    </span>,
    `${p.filledQuantity}/${p.requestedQuantity}`,
    p.credit != null ? `$${p.credit.toFixed(2)}` : "—",
    p.closePrice != null ? `$${p.closePrice.toFixed(2)}` : "—",
    <ResultCell key="pl" p={p} />,
    <Pill key="s" tone={STATUS_TONE[p.status] ?? "neutral"}>
      {p.status}
    </Pill>,
    p.expiry,
  ];
  const posHeaders = ["Opened", "Bot", "Type", "Legs (short / long)", "Qty", "Credit", "Closed at", "P/L", "Status", "Expiry"];

  return (
    <div className="space-y-4">
      {data.storageProblem && (
        <div className="rounded-xl bg-down-soft px-4 py-3 text-sm text-down">
          <span className="font-semibold">This server can&apos;t run the engine.</span> {data.storageProblem}
        </div>
      )}
      <ExecutorBanner executor={data.executor} />

      {reconcile && (data.executor.venue === "tradier" || data.executor.venue === "ibkr") && (
        <Card className="space-y-2 p-4">
          <SectionTitle
            action={
              <button onClick={reconcile.onRun} disabled={reconcile.busy} className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50">
                {reconcile.busy ? "Checking…" : "Check broker positions"}
              </button>
            }
          >
            Broker check
          </SectionTitle>
          <p className="text-xs text-muted">Compares what the bots say is open with what {data.executor.venue === "ibkr" ? "the Interactive Brokers account" : data.executor.sandbox ? "the Tradier sandbox" : "Tradier"} actually holds, leg by leg. It reports and flags the bot - it never opens or closes anything.</p>
          {reconcile.error && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">{reconcile.error}</p>}
          {reconcile.report &&
            (reconcile.report.ok ? (
              <p className="rounded-lg bg-up-soft px-3 py-2 text-sm text-up">
                All matched at {formatTime(reconcile.report.checkedAt)}: {reconcile.report.expectedLegs} expected leg{reconcile.report.expectedLegs === 1 ? "" : "s"}, {reconcile.report.brokerLegs} held at the broker.
              </p>
            ) : (
              <ul className="space-y-1 rounded-lg bg-down-soft px-3 py-2 text-sm text-down">
                {reconcile.report.problems.map((p, i) => (
                  <li key={i}>{p.text}</li>
                ))}
              </ul>
            ))}
        </Card>
      )}

      <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
        <span className="font-semibold text-fg">Don&apos;t place manual orders on positions the bot manages.</span> An order placed by hand at the broker (or from another app) is invisible to the bot: it can leave a position the bot thinks is open already closed, or one it has never heard of. To get out of a position, use <span className="font-medium text-fg">Close position</span> here, so the bot, its limits and its log stay in step with the account.
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        {data.bots.map((bot) => (
          <BotCard key={bot.id} bot={bot} executor={data.executor} busy={busyBot === bot.id} result={results[bot.id] ?? null} onToggle={onToggle} onKill={onKill} onSend={onSend} />
        ))}
      </div>

      <Card className="p-4">
        <SectionTitle
          action={
            <span className="text-xs text-faint">
              {data.alertEmail.enabled ? `Email on → ${data.alertEmail.to} (queued only - no mail sender is wired yet)` : "Email off"}
            </span>
          }
        >
          Activity alerts
        </SectionTitle>
        {data.alerts.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet. Opened and closed positions, warnings and errors show up here.</p>
        ) : (
          <ul className="space-y-1.5">
            {data.alerts.slice(0, 12).map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="text-xs text-faint">{formatTime(a.createdAt)}</span>
                <Pill tone={ALERT_TONE[a.kind]}>{ALERT_LABEL[a.kind]}</Pill>
                <span className="text-muted">{a.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <SectionTitle>Active positions</SectionTitle>
        <Table headers={posHeaders} rows={active.map(positionRow)} empty="None open. Send a test alert above and one appears here." />
      </Card>

      <Card className="p-4">
        <SectionTitle>Closed and expired positions</SectionTitle>
        <Table headers={posHeaders} rows={closed.map(positionRow)} empty="None yet. A flip closes the opposite position — it lands here." />
      </Card>

      <AwaitingResult positions={awaitingResult} botName={botName} onEnter={onEnterPL} />

      <Card className="p-4">
        <SectionTitle>Orders</SectionTitle>
        <Table
          headers={["Time", "Bot", "Order", "Legs (short / long)", "Limit", "Filled", "State"]}
          rows={data.orders.map((o) => [
            formatTime(o.createdAt),
            <span key="b">
              {botName(o.botId)} {o.venue === "mock" && <TestTag />}
            </span>,
            o.kind === "open" ? "Open (sell the spread)" : "Close (buy it back)",
            <span key="l" className="font-mono text-xs">
              {legsText({ type: o.positionType, shortStrike: o.shortStrike, longStrike: o.longStrike })}
            </span>,
            o.kind === "open" ? `$${o.limitPrice.toFixed(2)} credit` : "no limit",
            String(o.filledQuantity),
            <span key="s" title={o.rejectReason}>
              <Pill tone={STATUS_TONE[o.status] ?? "neutral"}>{o.status}</Pill>
            </span>,
          ])}
          empty="None yet."
        />
      </Card>

      <Card className="p-4">
        <SectionTitle
          action={
            mock ? (
              <button onClick={onReset} className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg">
                Reset test data
              </button>
            ) : undefined
          }
        >
          Alerts and the decision for each
        </SectionTitle>
        {data.signals.length === 0 ? (
          <p className="text-sm text-muted">No alerts yet.</p>
        ) : (
          <ul className="space-y-3">
            {data.signals.map((s) => (
              <li key={s.id} className="rounded-xl border border-line px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="text-xs text-faint">{formatTime(s.receivedAt)}</span>
                  <span className="font-medium">{botName(s.botId)}</span>
                  <Pill tone={s.signal === "bullish" ? "ok" : s.signal === "bearish" ? "error" : "neutral"}>{s.signal || "unknown"}</Pill>
                  <span className="text-muted">{s.price > 0 ? `@ ${fmtNum(s.price)}` : ""}</span>
                  {s.test && <TestTag />}
                  {s.status === "rejected" && <Pill tone="error">rejected: {s.rejectReason}</Pill>}
                </div>
                {s.decisions.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {s.decisions.map((d) => (
                      <li key={d.id} className="text-sm">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <Pill tone={outcomeTone(d.outcome)}>{d.outcome}</Pill>
                          <span className="text-muted">{d.reason}</span>
                        </div>
                        {d.strikePlan && <div className="mt-0.5 pl-1 font-mono text-[11px] text-faint">{d.strikePlan}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function StatusDashboard() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyBot, setBusyBot] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [report, setReport] = useState<ReconcileView | null>(null);
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);

  const load = useCallback(() => {
    return fetch("/api/automation/status")
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 401 ? "Session expired - refresh the page to sign in again." : "Failed to load.");
        return r.json();
      })
      .then((json: StatusResponse) => {
        setData(json);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, []);

  usePolling(load, POLL_MS);

  const toggleBot = (botId: string) => {
    setBusyBot(botId);
    fetch(`/api/automation/bots/${botId}/toggle`, { method: "POST" })
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setResults((x) => ({ ...x, [botId]: j.error ?? "Couldn't switch it." }));
        }
      })
      .then(load)
      .finally(() => setBusyBot(null));
  };

  const killBot = (botId: string) => {
    setBusyBot(botId);
    fetch(`/api/automation/bots/${botId}/kill`, { method: "POST" })
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setResults((x) => ({ ...x, [botId]: j.error ?? "Couldn't change the kill switch." }));
        }
      })
      .then(load)
      .finally(() => setBusyBot(null));
  };

  const sendAlert = (bot: StatusBot, signal: "bullish" | "bearish", price: number) => {
    setBusyBot(bot.id);
    setResults((x) => ({ ...x, [bot.id]: "Sending…" }));
    fetch("/api/automation/test/alert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bot: bot.id, signal, price }) })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return setResults((x) => ({ ...x, [bot.id]: `Not sent: ${j.error ?? r.status}` }));
        const outcomes = (j.decisions as { outcome: string; reason: string }[]).map((d) => d.outcome).join(" → ") || "no decision yet";
        setResults((x) => ({ ...x, [bot.id]: `${signal} test alert at ${price.toLocaleString("en-US")} → ${outcomes}${j.finished ? "" : " (still working…)"}` }));
      })
      .catch(() => setResults((x) => ({ ...x, [bot.id]: "Couldn't reach the server." })))
      .then(load)
      .finally(() => setBusyBot(null));
  };

  const runReconcile = () => {
    setReconcileBusy(true);
    setReconcileError(null);
    fetch("/api/automation/reconcile", { method: "POST" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return setReconcileError(j.error ?? "Couldn't check.");
        setReport(j.report as ReconcileView);
      })
      .catch(() => setReconcileError("Couldn't reach the server."))
      .then(load)
      .finally(() => setReconcileBusy(false));
  };

  const enterPL = async (positionId: string, pl: number): Promise<string | null> => {
    try {
      const r = await fetch(`/api/automation/positions/${positionId}/settle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pl }) });
      const j = await r.json().catch(() => ({}));
      load();
      return r.ok ? null : (j.error ?? "Couldn't save it.");
    } catch {
      return "Couldn't reach the server.";
    }
  };

  const reset = () => {
    if (!window.confirm("Reset the test data? This clears every recorded alert, position, order and decision. Bots and their settings stay.")) return;
    fetch("/api/automation/test/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) })
      .then(() => setResults({}))
      .then(load);
  };

  if (error) return <Card className="p-4 text-sm text-down">{error}</Card>;
  if (!data) return <Card className="p-4 text-sm text-muted">Loading...</Card>;
  return <StatusView data={data} busyBot={busyBot} results={results} onToggle={toggleBot} onKill={killBot} onSend={sendAlert} onReset={reset} reconcile={{ report, busy: reconcileBusy, error: reconcileError, onRun: runReconcile }} onEnterPL={enterPL} />;
}
