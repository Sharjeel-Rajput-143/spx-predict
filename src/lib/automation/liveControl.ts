import "server-only";
import { isKilled } from "./bybitRisk";
import type { LivePreflight } from "./bybitLive";
import { hasRecordedLivePosition } from "./bybitLiveWatchdog";
import { isDryRun } from "./config";
import { LIVE_BOT_ID, LIVE_HOST, LIVE_LIMITS, STAGE_LEVERAGE, isLiveStage, type LiveStage } from "./bybitLiveLimits";
import { logDecision } from "./decisions";
import { appendEvent, liveGate, type LiveGate } from "./ledger";
import { appLiveGuard, liveAutoOff, syncLiveBot } from "./liveGuard";
import { enableLive, readLiveSettings, setStage, turnLiveOff, turnMirrorOff, updateLiveSettings, type LiveSettings } from "./liveSettings";
import { pullbackSettings, type PullbackSettings } from "./pullbackExit";
import { liveBybitExecutor, liveExecutorProblem } from "./sharedExecutor";
import { botsStore, positionsStore } from "./store";
import { updateBot } from "./bots";
import { easternDateKey } from "./tradingHours";

/**
 * THE LIVE CONTROLS (what the Live page and its routes call). One master toggle, "Live trading". Everything that turns it ON or OFF is here or in liveSettings / liveGuard.
 *
 *   ON  by the CEO needs all four, every time, checked here on the server (the page's confirm box is only a convenience):
 *         1. the one "Are you sure?" confirm (`confirmed: true`; no typing),
 *         2. a live key present (the executor exists: BYBIT_LIVE_API_KEY / BYBIT_LIVE_API_SECRET were set when the app started),
 *         3. an account check that passes JUST NOW (key rights, isolated margin, the stage's leverage, all read back from Bybit), which the app runs itself,
 *         4. no kill switch; stage 2 also needs the live gate.
 *       Turning it ON turns the mirror ON with it (the live bot then receives the signals).
 *   OFF needs nothing but being signed in, is one click, and never waits for Bybit. The mirror is left ON only while a live position is held, so an opposite signal can still
 *       close it; tidyMirror turns it OFF as soon as none is held (records and the live account both say so).
 *   AUTO RESUME: the toggle's ON state is saved. After a restart or a release, if it was ON and nothing tripped, attemptAutoResume turns it ON again, but only if a live key is
 *       present, the margin is isolated and the account check passes right then, and no position is held without a confirmed stop. Every OFF (a click, a stop loss alarm,
 *       a tripped daily loss limit, a failed account check, the kill switch, a stage change) clears the saved state, so none of them is ever resumed. It writes a ledger event.
 *
 * Nothing here returns a key, a secret or a token: only whether a key is present.
 */

/** What the live account holds (the part the controls look at). */
export interface LiveAccountPosition {
  side: "Buy" | "Sell" | null;
  size: number;
  avgPrice: number | null;
  stopLoss: number | null;
}

/** What the controls need from the outside. The app passes the real ones; tests pass fakes. */
export interface LiveControlDeps {
  /** The live executor, or null when there is no usable live key. */
  executor: () => { preflight(): Promise<LivePreflight>; getAccountPosition(): Promise<LiveAccountPosition> } | null;
  /** Why there is no executor (a sentence without any value), or null. */
  problem: () => string | null;
  gate: () => Pick<LiveGate, "ok" | "why">;
  now: () => number;
}

const defaultDeps = (): LiveControlDeps => ({ executor: liveBybitExecutor, problem: liveExecutorProblem, gate: () => liveGate(), now: Date.now });

/** The result of the last account check, kept in memory for the page (the page asks again whenever it matters). */
export interface CheckSummary {
  at: number;
  ok: boolean;
  problems: string[];
  warnings: string[];
  /** Bybit could not be read: nothing is wrong that is known, but nothing passed either. */
  unreadable: string | null;
  marginMode: string | null;
  leverage: number | null;
}
const holder = globalThis as typeof globalThis & { __liveLastCheck?: CheckSummary | null };
export const lastCheck = (): CheckSummary | null => holder.__liveLastCheck ?? null;
export const __resetLastCheck = (): void => {
  holder.__liveLastCheck = null;
};

export type ControlResult<T = object> = ({ ok: true } & T) | { ok: false; status: number; error: string };
const refuse = (error: string, status = 409): { ok: false; status: number; error: string } => ({ ok: false, status, error });

/** Asks Bybit (through the live executor) about the key and account, remembers the answer for the page, and records the warnings. Never throws. */
export async function runAccountCheck(deps: LiveControlDeps = defaultDeps()): Promise<ControlResult<{ check: CheckSummary }>> {
  const exec = deps.executor();
  if (!exec) return refuse(`There is no live key, so there is nothing to check. ${deps.problem() ?? ""}`.trim());
  let pre: LivePreflight;
  try {
    pre = await exec.preflight();
  } catch (err) {
    pre = { ok: false, problems: [], warnings: [], unreadable: err instanceof Error ? err.message : String(err) };
  }
  const check: CheckSummary = {
    at: deps.now(),
    ok: pre.ok,
    problems: pre.problems,
    warnings: pre.warnings,
    unreadable: pre.unreadable ?? null,
    marginMode: pre.marginMode ?? null,
    leverage: Number.isFinite(pre.leverage) ? (pre.leverage as number) : null,
  };
  holder.__liveLastCheck = check;
  try {
    updateLiveSettings({ warnings: pre.warnings });
  } catch {
    /* the warnings are for the page; a failed save changes nothing that matters */
  }
  // A definite problem found while the switch is ON turns it OFF (the same rule the executor applies before each entry).
  if (pre.problems.length > 0 && readLiveSettings().enabled) liveAutoOff(`the live account check failed: ${pre.problems.join(" ")}`, deps.now());
  return { ok: true, check };
}

/** The reason a check did not pass, in a sentence, for a refusal. */
function whyNot(check: CheckSummary): string {
  if (check.unreadable) return `Bybit could not be asked (${check.unreadable})`;
  return check.problems.join(" ") || "it did not pass";
}

/** Turning the toggle ON by hand: a live key, and a fresh passing account check (the app runs it). */
export async function requirePassingCheck(deps: LiveControlDeps = defaultDeps()): Promise<{ ok: true; check: CheckSummary } | { ok: false; status: number; error: string }> {
  if (!deps.executor()) return refuse(`There is no live key: BYBIT_LIVE_API_KEY and BYBIT_LIVE_API_SECRET are not set, so nothing can be turned on. ${deps.problem() ?? ""}`.trim());
  const run = await runAccountCheck(deps);
  if (!run.ok) return run;
  if (!run.check.ok) return refuse(`The live account check did not pass: ${whyNot(run.check)}`);
  return { ok: true, check: run.check };
}

/** Turns the toggle ON (and the mirror with it). `confirmed` must be exactly true: the "Are you sure?" click. No word is typed. See the header for the other conditions. */
export async function turnSwitchOn(confirmed: unknown, deps: LiveControlDeps = defaultDeps()): Promise<ControlResult<{ settings: LiveSettings }>> {
  if (confirmed !== true) return refuse("Confirm that real money is involved to turn live trading on.", 400);
  const bot = botsStore.get(LIVE_BOT_ID);
  if (!bot) return refuse("The live bot has no record yet, so it cannot be turned on.");
  if (isKilled(LIVE_BOT_ID)) return refuse("The kill switch is on (the live bot's own, or BYBIT_KILL_SWITCH). Turn it off first.");
  const pre = await requirePassingCheck(deps);
  if (!pre.ok) return pre;
  const result = enableLive({ confirmed: true, preflightOk: true, gate: deps.gate(), keyPresent: true }, deps.now());
  if (!result.ok) return refuse(result.reason);
  // Confirming after a passed check is the operator's acknowledgement of an earlier automatic OFF: the banner is cleared like a bot switch does (bots/[id]/toggle).
  syncLiveBot(true);
  botsStore.update(LIVE_BOT_ID, { needsAttention: false, needsAttentionReason: null });
  logDecision({ signalId: null, botId: LIVE_BOT_ID, outcome: "automations_off", reason: "LIVE TRADING TURNED ON by you (confirmed on the Live page, and the account check passed). The mirror is on with it.", detail: { liveSwitch: "on" }, now: deps.now() });
  return { ok: true, settings: readLiveSettings() };
}

/**
 * Turns the toggle OFF. Always works; waits for nothing. A position already held stays protected and can still be closed. The mirror is NOT touched here: it stays ON while a live
 * position is held (an opposite signal can still close it), and tidyMirror turns it OFF once none is. Call tidyMirror right after (the route does).
 */
export function turnSwitchOff(deps: Pick<LiveControlDeps, "now"> = { now: Date.now }): ControlResult<{ settings: LiveSettings }> {
  const now = deps.now();
  turnLiveOff("Turned OFF by you on the Live page.", now);
  try {
    syncLiveBot(false);
    if (botsStore.get(LIVE_BOT_ID)) logDecision({ signalId: null, botId: LIVE_BOT_ID, outcome: "automations_off", reason: "LIVE TRADING TURNED OFF by you.", detail: { liveSwitch: "off" }, now });
  } catch (err) {
    console.error("[live] could not record the switch going OFF by hand (it is OFF)", err);
  }
  return { ok: true, settings: readLiveSettings() };
}

/**
 * With the toggle OFF, the mirror stays ON only while a live position is held. This turns it OFF once none is: the app's records show none AND the live account itself shows none.
 * If the account cannot be read the mirror is left as it is (never turned off blind). Does nothing while the toggle is ON. Never throws.
 */
export async function tidyMirror(deps: Pick<LiveControlDeps, "executor"> = defaultDeps(), recorded: () => boolean = hasRecordedLivePosition): Promise<"off" | "kept" | "nothing"> {
  try {
    const s = readLiveSettings();
    if (s.enabled || !s.mirrorEnabled) return "nothing";
    if (recorded()) return "kept";
    const exec = deps.executor();
    if (exec) {
      const held = await exec.getAccountPosition().catch(() => null);
      if (!held || held.side !== null) return "kept";
    }
    if (readLiveSettings().enabled || recorded()) return "kept"; // something changed while Bybit was being asked
    turnMirrorOff("live trading is OFF and no live position is held.");
    return "off";
  } catch (err) {
    console.error("[live] could not tidy the mirror", err);
    return "kept";
  }
}

const stopConfirmed = (p: LiveAccountPosition): boolean => {
  if (p.side === null) return true;
  if (!(typeof p.stopLoss === "number" && p.stopLoss > 0) || !(typeof p.avgPrice === "number" && p.avgPrice > 0)) return false;
  return p.side === "Buy" ? p.stopLoss < p.avgPrice : p.stopLoss > p.avgPrice;
};

/**
 * AUTO RESUME, one attempt. Only while the saved ON state is true and the toggle is OFF (that is, after a restart in which nothing tripped). Returns "retry" only when Bybit could not
 * be read (the caller tries again a few times); any definite no ("refused") also clears the saved state, so it is not tried again and the toggle stays OFF until it is turned ON
 * deliberately. A refusal for a safety reason also raises the red banner. Never throws.
 */
export async function attemptAutoResume(deps: LiveControlDeps = defaultDeps()): Promise<"resumed" | "nothing" | "retry" | "refused"> {
  try {
    const now = deps.now();
    const s0 = readLiveSettings();
    if (!s0.resume || s0.enabled) return "nothing";
    const refuseResume = (why: string, banner: boolean): "refused" => {
      const reason = `Auto resume did not turn live trading back on: ${why}`;
      if (banner) liveAutoOff(reason, now);
      else {
        turnLiveOff(reason, now);
        syncLiveBot(false);
      }
      return "refused";
    };
    const exec = deps.executor();
    if (!exec) return refuseResume(`there is no live key. ${deps.problem() ?? ""}`.trim(), false);
    if (!botsStore.get(LIVE_BOT_ID)) return refuseResume("the live bot has no record.", false);
    if (isKilled(LIVE_BOT_ID)) return refuseResume("the kill switch is on.", true);
    if (botsStore.get(LIVE_BOT_ID)?.riskTrip?.day === easternDateKey(now)) return refuseResume("the daily loss limit was reached today.", true);
    if (s0.stage === 2 && !deps.gate().ok) return refuseResume("stage 2 needs the live gate.", true);
    const run = await runAccountCheck(deps);
    if (!run.ok) return refuseResume(run.error, false);
    const check = run.check;
    if (check.unreadable) return "retry";
    if (!check.ok) return refuseResume(`the account check did not pass: ${whyNot(check)}`, true);
    if (check.marginMode !== "ISOLATED_MARGIN") return refuseResume(`the margin mode is ${check.marginMode ?? "unknown"}, not isolated.`, true);
    let held: LiveAccountPosition;
    try {
      held = await exec.getAccountPosition();
    } catch {
      return "retry";
    }
    if (!stopConfirmed(held)) return refuseResume("the live account holds a position without a confirmed stop loss.", true);
    // Nothing may have changed while Bybit was being asked: still waiting to resume, no kill switch.
    const s1 = readLiveSettings();
    if (!s1.resume || s1.enabled) return "nothing";
    if (isKilled(LIVE_BOT_ID)) return refuseResume("the kill switch is on.", true);
    const result = enableLive({ resume: true, preflightOk: true, gate: deps.gate(), keyPresent: true }, now);
    if (!result.ok) return refuseResume(result.reason, false);
    syncLiveBot(true);
    logDecision({ signalId: null, botId: LIVE_BOT_ID, outcome: "automations_off", reason: "LIVE TRADING TURNED BACK ON BY ITSELF (auto resume after a restart: it was ON, nothing had tripped, and the account check passed). The mirror is on with it.", detail: { liveSwitch: "on", autoResume: true }, now });
    appendEvent("live_auto_resume", { at: now, stage: s1.stage, marginMode: check.marginMode, leverage: check.leverage, heldSide: held.side, heldSize: held.size, stopLoss: held.stopLoss }, now);
    return "resumed";
  } catch (err) {
    console.error("[live] auto resume failed; the toggle stays OFF", err);
    return "retry";
  }
}

/** Delays between auto resume attempts after a start (Bybit may not answer at once). After the last one the saved ON state is dropped and the toggle stays OFF. */
export const RESUME_DELAYS_MS = [5_000, 30_000, 90_000, 300_000, 600_000] as const;

/** Run once per start: tries the auto resume now and then a few times more if Bybit could not be read. Silent when there is nothing to resume or in a dry run (a rehearsal). */
export function scheduleAutoResume(deps: LiveControlDeps = defaultDeps(), delays: readonly number[] = RESUME_DELAYS_MS, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms).unref?.())): Promise<void> {
  const g = globalThis as typeof globalThis & { __liveResumeScheduled?: boolean };
  if (g.__liveResumeScheduled || isDryRun()) return Promise.resolve();
  g.__liveResumeScheduled = true;
  return (async () => {
    for (let i = 0; i < delays.length; i++) {
      await wait(delays[i]);
      if (!readLiveSettings().resume || readLiveSettings().enabled) return;
      const r = await attemptAutoResume(deps);
      if (r !== "retry") return;
    }
    const s = readLiveSettings();
    if (s.resume && !s.enabled) {
      turnLiveOff("Auto resume gave up: Bybit could not be read after several tries. Turn live trading ON again when you are ready.");
      syncLiveBot(false);
    }
  })().catch((err) => console.error("[live] auto resume scheduler failed; the toggle stays OFF", err));
}

/** The live bot's own pullback exit / chain settings (what the Live page's Settings tab saves). Checked by the same rules as the demo bot's (bots.ts); the live bot's saved values are its own. */
export function setLivePullback(value: unknown): ControlResult<object> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse("Send the pullback settings as an object.", 400);
  try {
    updateBot(LIVE_BOT_ID, { pullback: value as never });
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err), 400);
  }
  return { ok: true };
}

/** The daily loss limit: a number above 0 and at most the ceiling in the code. A number above the ceiling is refused, not quietly lowered. */
export function setDailyLoss(value: unknown): ControlResult<{ settings: LiveSettings }> {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return refuse("The daily loss limit must be a number above 0.", 400);
  if (n > LIVE_LIMITS.dailyLossCeilingUsd) return refuse(`The daily loss limit cannot be above $${LIVE_LIMITS.dailyLossCeilingUsd} (a ceiling written in the code).`, 400);
  return { ok: true, settings: updateLiveSettings({ dailyLossUsd: Math.round(n * 100) / 100 }) };
}

/** Stage 1 or 2. Stage 2 only with the gate passed. Any change turns the switch OFF (type LIVE again). */
export function chooseStage(value: unknown, deps: Pick<LiveControlDeps, "gate" | "now"> = { gate: () => liveGate(), now: Date.now }): ControlResult<{ settings: LiveSettings }> {
  if (!isLiveStage(value)) return refuse("The stage must be 1 or 2.", 400);
  const before = readLiveSettings().stage;
  const result = setStage(value, deps.gate(), deps.now());
  if (!result.ok) return refuse(result.reason);
  if (before !== value) syncLiveBot(false);
  return { ok: true, settings: readLiveSettings() };
}

export interface LiveStatus {
  host: string;
  switch: { on: boolean; typedAt: number | null; offReason: string | null; offAt: number | null };
  mirror: { on: boolean };
  /** The saved ON state is waiting to be resumed after a restart (the toggle is still OFF while the account check runs). */
  resumePending: boolean;
  /** The LIVE bot's own pullback exit / chain settings in force (its own saved values, separate from the demo bot's). */
  pullback: PullbackSettings;
  chainRunning: { trades: number } | null;
  stage: LiveStage;
  leverage: number;
  dailyLossUsd: number;
  limits: { maxQty: number; dailyLossCeilingUsd: number; maxTradesPerDay: number; maxOpenPositions: number };
  tradesToday: number;
  /** Whether a live key is present. Never the key. */
  key: { present: boolean; problem: string | null };
  check: CheckSummary | null;
  warnings: string[];
  gate: LiveGate;
  bot: { exists: boolean; enabled: boolean; killSwitch: boolean; needsAttention: boolean; reason: string | null };
  position: { type: string; status: string; openedAt: number | null; entry: number | null } | null;
  recent: { openedAt: number | null; closedAt: number | null; type: string; closeReason: string | null; pl: number | null }[];
  now: number;
}

/** Everything the Live page shows. Read only; asks Bybit nothing. */
export function liveStatus(deps: Pick<LiveControlDeps, "executor" | "problem" | "now"> & { gate?: () => LiveGate } = { executor: liveBybitExecutor, problem: liveExecutorProblem, now: Date.now }): LiveStatus {
  const now = deps.now();
  const s = readLiveSettings();
  const bot = botsStore.get(LIVE_BOT_ID);
  const mine = positionsStore.query((p) => p.botId === LIVE_BOT_ID).sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
  const open = mine.find((p) => p.status === "open" || p.status === "opening" || p.status === "closing");
  const hasKey = deps.executor() !== null;
  return {
    host: LIVE_HOST,
    switch: { on: s.enabled, typedAt: s.typedAt, offReason: s.offReason, offAt: s.offAt },
    mirror: { on: s.mirrorEnabled },
    resumePending: s.resume && !s.enabled,
    pullback: pullbackSettings(LIVE_BOT_ID),
    chainRunning: bot?.chainState ? { trades: bot.chainState.count } : null,
    stage: s.stage,
    leverage: STAGE_LEVERAGE[s.stage],
    dailyLossUsd: s.dailyLossUsd,
    limits: { maxQty: LIVE_LIMITS.maxQty, dailyLossCeilingUsd: LIVE_LIMITS.dailyLossCeilingUsd, maxTradesPerDay: LIVE_LIMITS.maxTradesPerDay, maxOpenPositions: LIVE_LIMITS.maxOpenPositions },
    tradesToday: appLiveGuard.tradesToday(now),
    key: { present: hasKey, problem: hasKey ? null : deps.problem() },
    check: lastCheck(),
    warnings: s.warnings,
    gate: (deps.gate ?? (() => liveGate()))(),
    bot: { exists: !!bot, enabled: !!bot?.enabled, killSwitch: isKilled(LIVE_BOT_ID), needsAttention: !!bot?.needsAttention, reason: bot?.needsAttentionReason ?? null },
    position: open ? { type: open.type, status: open.status, openedAt: open.openedAt, entry: typeof open.credit === "number" && Number.isFinite(open.credit) ? Math.round(open.credit * 1e5 * 10) / 10 : null } : null,
    recent: mine.filter((p) => p.status === "closed").slice(0, 10).map((p) => ({ openedAt: p.openedAt, closedAt: p.closedAt ?? null, type: p.type, closeReason: p.closeReason ?? null, pl: typeof p.settlement === "object" && p.settlement && "pl" in p.settlement && typeof p.settlement.pl === "number" ? p.settlement.pl : null })),
    now,
  };
}
