import "server-only";
import { botsStore } from "./store";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import type { LiveGuard } from "./bybitLive";
import { logDecision } from "./decisions";
import { bootLiveSettings, readLiveSettings, turnLiveOff } from "./liveSettings";
import { countTodayNewPositions } from "./safeguards";

/** Keeps the live bot's own On/Off in step with the live switch: ON only while the switch is ON. (A bot that is off may still close a position; it never opens one.) */
export function syncLiveBot(on: boolean): void {
  if (botsStore.get(LIVE_BOT_ID)) botsStore.update(LIVE_BOT_ID, { enabled: on });
}

/** Everything that turns the live switch OFF comes through here: the switch, the bot, the Log, the red banner and the bell. Never throws. */
export function liveAutoOff(reason: string, now: number = Date.now()): void {
  try {
    turnLiveOff(reason, now);
    syncLiveBot(false);
    if (botsStore.get(LIVE_BOT_ID)) {
      logDecision({ signalId: null, botId: LIVE_BOT_ID, outcome: "executor_error", reason: `LIVE SWITCH TURNED OFF: ${reason}`, detail: { liveSwitch: "off" }, now });
      botsStore.update(LIVE_BOT_ID, { needsAttention: true, needsAttentionReason: `LIVE SWITCH TURNED OFF: ${reason}` });
    }
  } catch (err) {
    console.error("[live] could not record the switch going OFF", err);
  }
}

/** Run once per start: the live switch is OFF after every restart, and so is the live bot. */
export function bootLive(): void {
  const g = globalThis as typeof globalThis & { __liveBootedApp?: boolean };
  if (g.__liveBootedApp) return;
  g.__liveBootedApp = true;
  try {
    bootLiveSettings();
    syncLiveBot(false);
  } catch (err) {
    console.error("[live] start-up reset failed", err);
  }
}

/** The live executor's view of the switch and the day, from the real records. */
export const appLiveGuard: LiveGuard = {
  switchOn: () => {
    bootLive(); // first look after a start: OFF whatever it was
    return readLiveSettings().enabled;
  },
  stage: () => readLiveSettings().stage,
  dailyLossUsd: () => readLiveSettings().dailyLossUsd,
  tradesToday: (now) => countTodayNewPositions(LIVE_BOT_ID, now, botsStore.get(LIVE_BOT_ID)?.dailyResetAt ?? 0),
  onAutoOff: (reason) => liveAutoOff(reason),
};
