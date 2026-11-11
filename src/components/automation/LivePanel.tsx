"use client";

import { useCallback, useState, type ReactNode } from "react";
import { Card } from "@/components/ui";
import { BybitPanel } from "./BybitPanel";
import { PullbackEditor } from "./bot/PullbackEditor";
import { cn } from "@/lib/format";
import type { LiveStatus } from "@/lib/automation/liveControl";
import { usePolling } from "./usePolling";

const REFRESH_MS = 4000;
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (ms: number | null) => (ms === null ? "—" : new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }));
const side = (type: string) => (type === "short_put_spread" ? "Long" : "Short");

function Row({ label, children, tone }: { label: string; children: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2 text-sm last:border-b-0">
      <span className="text-muted">{label}</span>
      <span className={cn("font-medium tabular", tone === "good" && "text-up", tone === "bad" && "text-down")}>{children}</span>
    </div>
  );
}

export const LIVE_TABS = ["status", "settings"] as const;
export type LiveTab = (typeof LIVE_TABS)[number];
const TAB_LABEL: Record<LiveTab, string> = { status: "Status", settings: "Settings" };

export interface LiveViewProps {
  s: LiveStatus;
  /** What fills the rest of the Status view: the live twin of the demo Bybit page (strip, four cards, open trade, history). The container passes it; tests pass a stand-in. */
  tradesPanel?: ReactNode;
  /** The tab being shown. */
  tab?: LiveTab;
  onTab?(tab: LiveTab): void;
  message: string | null;
  busy: boolean;
  /** The "Are you sure?" box is open (the toggle was pressed while OFF). */
  confirming?: boolean;
  onAsk?(): void;
  onCancel?(): void;
  daily: string;
  onDaily(v: string): void;
  onCheck(): void;
  /** true = the confirm button was pressed; false = the toggle was switched OFF. */
  onSwitch(on: boolean): void;
  onSaveDaily(): void;
  onStage(stage: 1 | 2): void;
  /** Saves one change to the LIVE bot's own pullback exit / chain values. */
  onSavePullback?(body: Record<string, unknown>, text: string): void;
}

/** Why the last account check did not pass, in words (or null when it passed or has not run). */
export function checkFailure(s: LiveStatus): string | null {
  if (!s.check || s.check.ok) return null;
  const parts = [...s.check.problems, ...(s.check.unreadable ? [`Bybit could not be asked: ${s.check.unreadable}`] : [])];
  return parts.join(" ") || "it did not pass";
}

/** One plain line: what to do next. Only reads the status; changes nothing. */
export function nextStep(s: LiveStatus): string {
  if (!s.key.present) return "Add the live key to .env.local, then release the app. Nothing else can be done before that.";
  if (s.bot.killSwitch) return "The kill switch is on for the live bot. Turn it off first.";
  if (s.resumePending) return "Live trading is turning itself back on after the restart. Give it a minute, then look again.";
  if (s.switch.on && s.mirror.on) return "Live trading is ON, and the signals reach the live bot. Watch the Open trade box and the Trade history on this page. To stop, switch the toggle OFF.";
  if (s.switch.on) return "Live trading is ON, but the signals do not reach the live bot, so no new live trade will open. Switch it OFF and ON again.";
  if (!s.check) return "Open Settings and press Check the live account now.";
  if (!s.check.ok) return "Fix what the red box says, then open Settings and check again.";
  if (s.warnings.length > 0 && s.stage === 2) return "The account check passed. Before stage 2, add this Mac's IP to the key at Bybit (see Settings). Then you can switch live trading ON.";
  return "The account check passed. When you are ready, switch the Live trading toggle ON and confirm.";
}

/** The Live page, drawn from one status. The buttons are a convenience: the server checks every rule again (the confirm, a key, a passing account check). */
export function LivePanelView(p: LiveViewProps) {
  const { s } = p;
  const tab = p.tab ?? "status";
  const failure = checkFailure(s);
  return (
    <div className="space-y-4" data-testid="live-panel">
      <div className="flex flex-wrap items-end justify-between gap-x-4 border-b border-line">
        <div className="flex gap-1 overflow-x-auto [scrollbar-width:none] sm:gap-2" role="tablist" aria-label="Live trading sections">
          {LIVE_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              data-testid={`live-tab-${t}`}
              onClick={() => p.onTab?.(t)}
              className={cn("-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors sm:px-4", tab === t ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg")}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="flex gap-3 pb-2 text-xs font-medium" data-testid="live-pill">
          <span className={s.switch.on ? "text-down" : "text-muted"}>Live trading: {s.switch.on ? "ON" : "OFF"}</span>
          {!s.switch.on && s.mirror.on && <span className="text-down">Closing only: a live position is held</span>}
        </div>
      </div>

      {failure && (
        <p className="rounded-lg bg-down-soft px-3 py-2 text-sm font-medium text-down" role="alert" data-testid="live-check-banner">
          The last account check did not pass: {failure} Live trading will not turn on until a check passes.
        </p>
      )}

      {p.message && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700" role="status" data-testid="live-message">
          {p.message}
        </p>
      )}

      <div role="tabpanel" aria-label={TAB_LABEL[tab]} data-testid={`live-tabpanel-${tab}`} className="space-y-4">
        {tab === "status" && <StatusTab {...p} />}
        {tab === "settings" && <SettingsTab {...p} />}
      </div>
    </div>
  );
}

const positionText = (s: LiveStatus) => (s.position ? `${side(s.position.type)} (${s.position.status}) since ${when(s.position.openedAt)}${s.position.entry ? `, entry ${s.position.entry}` : ""}` : "none");

/** The master toggle. Pressed while OFF it only opens the "Are you sure?" box (nothing is sent); pressed while ON it switches OFF at once, with no confirm. */
function Toggle(p: Pick<LiveViewProps, "s" | "busy" | "onAsk" | "onSwitch">) {
  const on = p.s.switch.on;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Live trading"
      data-testid="live-toggle"
      disabled={p.busy || (!on && (!p.s.key.present || p.s.resumePending))}
      onClick={() => (on ? p.onSwitch(false) : p.onAsk?.())}
      className={cn("relative inline-flex h-12 w-24 shrink-0 items-center rounded-full border border-line transition-colors disabled:opacity-40", on ? "bg-down" : "bg-surface-2")}
    >
      <span className={cn("absolute h-9 w-9 rounded-full bg-white shadow transition-all", on ? "left-[3.25rem]" : "left-1.5")} />
      <span className={cn("absolute text-xs font-semibold", on ? "left-3 text-white" : "right-3 text-muted")}>{on ? "ON" : "OFF"}</span>
    </button>
  );
}

function StatusTab(p: LiveViewProps) {
  const { s } = p;
  const checkTone = s.check ? (s.check.ok ? "good" : "bad") : undefined;
  const asking = !!p.confirming && !s.switch.on;
  return (
    <>
      <div className="rounded-lg bg-down px-4 py-2 text-center text-sm font-bold uppercase tracking-wide text-white" role="note" data-testid="live-banner">
        LIVE, real money on {s.host}
      </div>

      <Card className={cn("p-4", s.switch.on ? "border-down" : "")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-faint">Live trading</div>
            <div className={cn("text-2xl font-semibold", s.switch.on ? "text-down" : "text-fg")} data-testid="live-state">
              {s.switch.on ? "LIVE TRADING IS ON" : "LIVE TRADING IS OFF"}
            </div>
            {s.switch.on ? (
              <div className="text-sm text-muted">Turned on {when(s.switch.typedAt)}. Each TradingView alert reaches the demo bot and the live bot at the same moment; neither waits for the other. The live bot opens and closes real trades.</div>
            ) : s.resumePending ? (
              <div className="text-sm text-muted" data-testid="live-resume-pending">It was ON before the restart. It is turning itself back on if the account check passes.</div>
            ) : (
              <div className="text-sm text-muted">No new live order is sent. A position already held can still be closed.{s.mirror.on ? " The signals still reach the live bot while that position is held, so an opposite signal can close it." : ""}</div>
            )}
          </div>
          <Toggle s={s} busy={p.busy} onAsk={p.onAsk} onSwitch={p.onSwitch} />
        </div>
        {asking && (
          <div className="mt-3 rounded-lg border border-down bg-down-soft px-3 py-3 text-sm text-down" role="alertdialog" aria-label="Are you sure?" data-testid="live-confirm-box">
            <div className="font-semibold">Are you sure?</div>
            <p className="mt-1">This uses REAL money on Bybit. The bot will open and close real trades from the TradingView signals, and real money can be lost. Size is {s.limits.maxQty} BTC at most, one position at a time, with a stop loss on every trade and a daily loss limit of {money(s.dailyLossUsd)}.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => p.onSwitch(true)} disabled={p.busy} data-testid="live-confirm" className="rounded-lg bg-down px-5 py-2 text-sm font-semibold text-white disabled:opacity-40">
                Yes, turn live trading ON
              </button>
              <button type="button" onClick={p.onCancel} data-testid="live-cancel" className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-fg hover:bg-surface-2">
                No, keep it OFF
              </button>
            </div>
          </div>
        )}
        {!s.switch.on && s.switch.offReason && (
          <p className="mt-3 rounded-lg bg-down-soft px-3 py-2 text-sm text-down" data-testid="live-off-reason">
            It was turned OFF{s.switch.offAt ? ` at ${when(s.switch.offAt)}` : ""}: {s.switch.offReason}
          </p>
        )}
        {s.bot.killSwitch && <p className="mt-3 rounded-lg bg-down-soft px-3 py-2 text-sm text-down">The kill switch is on for the live bot. Live trading cannot be turned on until it is turned off.</p>}
        {s.bot.needsAttention && <p className="mt-3 rounded-lg bg-down-soft px-3 py-2 text-sm text-down">The live bot needs attention: {s.bot.reason ?? "see its Log"}. Turning live trading ON again, after you confirm, clears this.</p>}
        <div className="mt-3 border-t border-line pt-1">
          <Row label="Live key" tone={s.key.present ? "good" : "bad"}>
            {s.key.present ? "present (never shown)" : "missing"}
          </Row>
          {!s.key.present && <p className="py-2 text-sm text-down" data-testid="live-key-problem">{s.key.problem ?? "No live key is set."} The key goes in .env.local and takes effect when the app is next released.</p>}
          <Row label="Last account check" tone={checkTone}>
            {s.check ? `${s.check.ok ? "passed" : "did not pass"} at ${when(s.check.at)}` : "not run yet"}
          </Row>
          <p className="pt-2 text-sm font-medium text-fg" data-testid="live-next">
            <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-faint">Next</span>
            {nextStep(s)}
          </p>
        </div>
      </Card>

      {/* The live twin of the demo Bybit page: the status strip, the four cards, the open trade and the trade history. Live data only. */}
      <div data-testid="live-trades-panel">{p.tradesPanel}</div>
    </>
  );
}

function SettingsTab(p: LiveViewProps) {
  const { s } = p;
  const gate = s.gate;
  const checkTone = s.check ? (s.check.ok ? "good" : "bad") : undefined;
  return (
    <>
      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-fg">The account check</h2>
        <Row label="Live key" tone={s.key.present ? "good" : "bad"}>
          {s.key.present ? "present (never shown)" : "missing"}
        </Row>
        {!s.key.present && <p className="py-2 text-sm text-down">{s.key.problem ?? "No live key is set."} The key goes in .env.local and takes effect when the app is next released.</p>}
        <Row label="Last account check" tone={checkTone}>
          {s.check ? `${s.check.ok ? "passed" : "did not pass"} at ${when(s.check.at)}` : "not run yet"}
        </Row>
        {s.check && (
          <>
            <Row label="Margin mode (must be isolated)">{s.check.marginMode ?? "—"}</Row>
            <Row label="Leverage">{s.check.leverage === null ? "—" : `${s.check.leverage}x`}</Row>
            {s.check.problems.map((t) => (
              <p key={t} className="py-1 text-sm text-down">{t}</p>
            ))}
            {s.check.unreadable && <p className="py-1 text-sm text-down">Bybit could not be asked: {s.check.unreadable}</p>}
          </>
        )}
        {s.warnings.map((t) => (
          <p key={t} className="py-1 text-sm font-medium text-down" data-testid="live-warning">
            Warning: {t}
          </p>
        ))}
        <p className="py-2 text-xs text-faint">The check asks Bybit what the key may do (withdraw or transfer rights are refused), puts the account on isolated margin (a loss stays inside the trade) and sets the stage&apos;s leverage, then reads both back. It runs again every time something is turned on.</p>
        <button type="button" onClick={p.onCheck} disabled={p.busy || !s.key.present} data-testid="live-check" className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-40">
          Check the live account now
        </button>
      </Card>

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-fg">The limits (written in the code; they can be lowered, never raised)</h2>
        <Row label="Order size">{s.limits.maxQty} BTC at most</Row>
        <Row label="Open at once">{s.limits.maxOpenPositions} position</Row>
        <Row label="New trades a day">{s.tradesToday} of {s.limits.maxTradesPerDay} used today</Row>
        <Row label="Daily loss limit">{money(s.dailyLossUsd)} (ceiling {money(s.limits.dailyLossCeilingUsd)})</Row>
        <div className="flex flex-wrap items-center gap-2 py-3">
          <label className="text-sm text-muted" htmlFor="live-daily">Set the daily loss limit ($)</label>
          <input id="live-daily" value={p.daily} onChange={(e) => p.onDaily(e.target.value)} inputMode="decimal" className="w-24 rounded-lg border border-line bg-surface px-3 py-2 text-sm" data-testid="live-daily" />
          <button type="button" onClick={p.onSaveDaily} disabled={p.busy} data-testid="live-daily-save" className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-40">Save</button>
        </div>
        <Row label="Stage">
          {s.stage === 1 ? "Stage 1: a $10 account, 10x isolated" : "Stage 2: up to $35, 3x isolated"}
        </Row>
        <div className="flex flex-wrap gap-2 py-2">
          <button type="button" onClick={() => p.onStage(1)} disabled={p.busy || s.stage === 1} data-testid="live-stage-1" className="rounded-lg border border-line bg-surface px-4 py-2 text-sm hover:bg-surface-2 disabled:opacity-40">Use stage 1</button>
          <button type="button" onClick={() => p.onStage(2)} disabled={p.busy || s.stage === 2 || !gate.ok} data-testid="live-stage-2" className="rounded-lg border border-line bg-surface px-4 py-2 text-sm hover:bg-surface-2 disabled:opacity-40">Use stage 2 (needs the gate)</button>
        </div>
        <p className="text-xs text-faint">Changing the stage turns live trading OFF. A stop loss alarm, a tripped daily limit, a failed account check or the kill switch also turn it OFF by themselves.</p>
      </Card>
      <PullbackEditor pb={s.pullback} chainRunning={s.chainRunning} live save={(body, text) => p.onSavePullback?.(body, text)} />

      <GateCard {...p} />

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-fg">How the signals reach the live bot</h2>
        <p className="text-sm text-muted">Each TradingView alert is checked once. Then the demo bot and the live bot get it at the same moment, each on its own: neither waits for the other, and if one is off, tripped or in error the other still gets the signal. The live bot trades only while Live trading is ON.</p>
      </Card>
    </>
  );
}

function GateCard({ s }: LiveViewProps) {
  const gate = s.gate;
  return (
    <Card className="p-4">
      <h2 className="mb-2 text-sm font-semibold text-fg">The live gate</h2>
      <p className="mb-2 text-sm text-muted">Needed for stage 2 only. Stage 1 does not need it.</p>
      <Row label="Failure tests on the real demo account" tone={gate.tests.passed === gate.tests.total ? "good" : undefined}>
        {gate.tests.passed} of {gate.tests.total}
      </Row>
      <Row label="Partial fill proven on the fake exchange (same code)" tone={gate.partialFill.passed ? "good" : undefined}>
        {gate.partialFill.passed ? "yes" : "no"}
      </Row>
      <Row label="Clean counted demo trades" tone={gate.trades.clean >= gate.trades.needed ? "good" : undefined}>
        {gate.trades.clean} of {gate.trades.needed}
      </Row>
      <p className="py-2 text-sm text-muted" data-testid="live-gate-why">{gate.ok ? "The gate is passed." : `Not passed: ${gate.why}`}</p>
    </Card>
  );
}

/** Calls a Live route and returns the new status, or the reason it was refused. */
async function call(path: string, method: "GET" | "POST", body?: unknown): Promise<{ status?: LiveStatus; error?: string }> {
  try {
    const res = await fetch(path, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const json = (await res.json().catch(() => ({}))) as { error?: string; status?: LiveStatus } & Partial<LiveStatus>;
    if (!res.ok) return { error: json.error ?? `The server answered ${res.status}.` };
    return { status: (json.status ?? (json as LiveStatus)) as LiveStatus };
  } catch (err) {
    return { error: `The server could not be reached: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function LivePanel() {
  const [s, setS] = useState<LiveStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [daily, setDaily] = useState("");
  const [tab, setTabState] = useState<LiveTab>(() => {
    const wanted = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab");
    return (LIVE_TABS as readonly string[]).includes(wanted ?? "") ? (wanted as LiveTab) : "status";
  });
  const setTab = (t: LiveTab) => {
    setTabState(t);
    try {
      window.history.replaceState(null, "", `?tab=${t}`);
    } catch {
      /* the address bar is a convenience */
    }
  };

  const load = useCallback(async () => {
    const r = await call("/api/automation/live", "GET");
    if (r.status) {
      setS(r.status);
      setDaily((d) => (d === "" ? String(r.status!.dailyLossUsd) : d));
    } else if (r.error) setMessage(r.error);
  }, []);
  usePolling(load, REFRESH_MS);

  const act = async (path: string, body: unknown, after?: () => void) => {
    setBusy(true);
    setMessage(null);
    const r = await call(path, "POST", body);
    if (r.error) setMessage(r.error);
    else {
      if (r.status) setS(r.status);
      after?.();
    }
    setBusy(false);
  };

  if (!s) return <Card className="p-4 text-sm text-muted">{message ?? "Loading the live page..."}</Card>;
  return (
    <LivePanelView
      s={s}
      tradesPanel={<BybitPanel live />}
      tab={tab}
      onTab={setTab}
      message={message}
      busy={busy}
      confirming={confirming}
      onAsk={() => setConfirming(true)}
      onCancel={() => setConfirming(false)}
      daily={daily}
      onDaily={setDaily}
      onCheck={() => void act("/api/automation/live/check", {})}
      onSwitch={(on) => {
        setConfirming(false);
        void act("/api/automation/live/switch", on ? { on: true, confirm: true } : { on: false });
      }}
      onSaveDaily={() => void act("/api/automation/live/settings", { dailyLossUsd: Number(daily) })}
      onStage={(stage) => void act("/api/automation/live/settings", { stage })}
      onSavePullback={(body) => void act("/api/automation/live/settings", { pullback: body })}
    />
  );
}
