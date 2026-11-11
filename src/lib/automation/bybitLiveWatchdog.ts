import "server-only";
import { WATCHDOG_INTERVAL_MS } from "./bybitExecutor";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { isKilled, runBybitRiskCheck } from "./bybitRisk";
import { isDryRun } from "./config";
import { logDecision } from "./decisions";
import { easternDateKey } from "./tradingHours";
import { liveAutoOff } from "./liveGuard";
import { readLiveSettings } from "./liveSettings";
import { liveBybitExecutor, sharedExecutor } from "./sharedExecutor";
import { botsStore, positionsStore } from "./store";

/**
 * The live bot's own stop-loss watchdog, risk check and alarms. They are the demo ones (BybitExecutor.watchdogStep, runBybitRiskCheck) run against the LIVE executor, with their
 * own timers, their own alarm and their own "recorded position" hint, so nothing the demo account does can raise a live alarm and nothing live can raise a demo one.
 *
 * They run whenever a live key exists, even with the live switch OFF: a position that is open must be watched whatever the switch says. Without a live key they do nothing.
 * A STOP LOSS ALARM turns the live switch OFF (the executor's alarm handler does that) and writes the Log line, the red banner and the bell of the LIVE bot.
 */

export { WATCHDOG_INTERVAL_MS };

export const hasRecordedLivePosition = (): boolean => positionsStore.query((p) => p.botId === LIVE_BOT_ID && p.venue === "bybit" && (p.status === "open" || p.status === "opening" || p.status === "closing")).length > 0;

export function raiseLiveStopAlarm(alarm: { kind: "stop_problem" | "unreachable" | "resolved"; text: string }, now: number = Date.now()): void {
  if (!botsStore.get(LIVE_BOT_ID)) return;
  if (alarm.kind === "resolved") {
    logDecision({ signalId: null, botId: LIVE_BOT_ID, outcome: "position_resolved", reason: `Live stop watchdog: ${alarm.text}`, detail: { stopWatchdog: true, live: true, kind: alarm.kind }, now });
    return;
  }
  const reason = `LIVE STOP LOSS ALARM: ${alarm.text}`;
  logDecision({ signalId: null, botId: LIVE_BOT_ID, outcome: "executor_error", reason, detail: { stopWatchdog: true, live: true, kind: alarm.kind }, now });
  botsStore.update(LIVE_BOT_ID, { needsAttention: true, needsAttentionReason: reason });
}

const wired = new WeakSet<object>();
function wire(executor: NonNullable<ReturnType<typeof liveBybitExecutor>>): void {
  if (wired.has(executor)) return;
  wired.add(executor);
  executor.setAlarmHandler((a) => raiseLiveStopAlarm(a));
  executor.exposedHint ??= hasRecordedLivePosition;
}

/** One look at the live account. Quiet when there is no live key. Never throws. */
export async function liveWatchdogTick(now: number = Date.now()): Promise<string | null> {
  if (isDryRun()) return null;
  const live = liveBybitExecutor();
  if (!live) return null;
  wire(live);
  try {
    const r = await live.watchdogStep(now);
    if (r.startup && r.text) console.info(`[live] ${r.text}`);
    return r.state;
  } catch (err) {
    console.error("[live] stop-loss watchdog failed", err);
    return null;
  }
}

let riskTicking = false;

/** One pass of the risk check over the live bot: the daily loss limit, the kill switch, the trade Bybit closed by its own stop, the breakeven move. Then the switch follows what tripped. */
export async function liveRiskTick(now: number = Date.now()): Promise<number> {
  if (riskTicking || isDryRun()) return 0;
  const live = liveBybitExecutor();
  if (!live || !botsStore.get(LIVE_BOT_ID)) return 0;
  wire(live);
  riskTicking = true;
  try {
    const run = await runBybitRiskCheck(LIVE_BOT_ID, sharedExecutor, live, now).catch((err) => {
      console.error("[live] risk check failed", err);
      return null;
    });
    const bot = botsStore.get(LIVE_BOT_ID);
    if (readLiveSettings().enabled) {
      if (isKilled(LIVE_BOT_ID)) liveAutoOff("the kill switch is on (the live bot's own, or BYBIT_KILL_SWITCH)", now);
      else if (bot?.riskTrip?.day === easternDateKey(now)) liveAutoOff("the daily loss limit was reached", now);
    }
    return run?.actions.length ?? 0;
  } finally {
    riskTicking = false;
  }
}

/** Tests only. */
export function __resetLiveWatchdogForTests(): void {
  riskTicking = false;
}
