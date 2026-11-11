import "server-only";
import fs from "node:fs";
import path from "node:path";
import { LIVE_LIMITS, clampDailyLoss, isLiveStage, type LiveStage } from "./bybitLiveLimits";
import { resolveDataDir } from "./store";

/**
 * THE LIVE BOT'S OWN SETTINGS, in their own folder (LIVE_DATA_DIR, else "live" next to the demo records): never mixed with the demo bot's records.
 *
 *   enabled         the master toggle "Live trading". OFF by default. Turned ON only by enableLive: a confirm click ("Are you sure?"), a live key, an account check that passed
 *                   just now, and (stage 2 only) the live gate. Turning it ON also turns the mirror ON, in the same write. No typing.
 *   mirrorEnabled   whether the demo bot's TradingView signals are also sent to the live bot. It goes ON only together with the toggle. When the toggle is turned OFF it is
 *                   left ON only while a live position is held (so an opposite signal can still close it); liveControl.tidyMirror turns it OFF once none is held.
 *   resume          the toggle's saved ON state: true from a deliberate ON (or an auto resume) until ANYTHING turns the toggle OFF. turnLiveOff clears it, and every OFF goes
 *                   through turnLiveOff: the OFF click, a stop loss alarm, a tripped daily loss limit, a failed account check, the kill switch, a stage change. So after
 *                   a plain restart (or a release promote) `resume` is still true only if the toggle was ON and nothing tripped, and then liveControl.attemptAutoResume may turn
 *                   it ON again, after its own checks. Whatever else, nothing resumes by itself.
 *   stage           1 = a $10 account at 10x isolated; 2 = up to $35 at 3x isolated (needs the live gate).
 *   dailyLossUsd    the daily loss limit chosen; never above the ceiling in the code.
 *
 * A file that is missing, unreadable or damaged reads as the safe defaults (everything OFF, nothing to resume). A write that fails never leaves the toggle ON: the in-memory
 * "forced off" flag is set first.
 */

export interface LiveSettings {
  enabled: boolean;
  mirrorEnabled: boolean;
  /** The toggle's saved ON state (see the header): cleared by every OFF, so only a plain restart leaves it true while the toggle is off. */
  resume: boolean;
  stage: LiveStage;
  dailyLossUsd: number;
  /** When the toggle was last turned ON (by a click, or by an auto resume). */
  typedAt: number | null;
  /** Why and when the switch was last turned OFF (by anyone or anything). */
  offReason: string | null;
  offAt: number | null;
  /** Red warnings from the last pre-trade check (for example: the key has no IP restriction). Never a block. */
  warnings: string[];
  updatedAt: number;
}

export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  enabled: false,
  mirrorEnabled: false,
  resume: false,
  stage: 1,
  dailyLossUsd: LIVE_LIMITS.defaultDailyLossUsd,
  typedAt: null,
  offReason: null,
  offAt: null,
  warnings: [],
  updatedAt: 0,
};

export function liveDataDir(env: Record<string, string | undefined> = process.env): string {
  return env.LIVE_DATA_DIR?.trim() || path.join(path.dirname(resolveDataDir(env).dir), "live");
}
const file = () => path.join(liveDataDir(), "settings.json");

let forcedOff = false;
/** Same idea for the mirror: set at a restart (or when it is turned off) so a failed write can never leave it ON. */
let forcedMirrorOff = false;

/** Clean values only: anything unusable falls back to the safe default. */
export function sanitize(raw: unknown): LiveSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    mirrorEnabled: r.mirrorEnabled === true,
    resume: r.resume === true,
    stage: isLiveStage(r.stage) ? r.stage : 1,
    dailyLossUsd: clampDailyLoss(r.dailyLossUsd),
    typedAt: typeof r.typedAt === "number" && Number.isFinite(r.typedAt) ? r.typedAt : null,
    offReason: typeof r.offReason === "string" ? r.offReason.slice(0, 500) : null,
    offAt: typeof r.offAt === "number" && Number.isFinite(r.offAt) ? r.offAt : null,
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === "string").map((w) => w.slice(0, 300)).slice(0, 10) : [],
    updatedAt: typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
  };
}

export function readLiveSettings(): LiveSettings {
  let s: LiveSettings;
  try {
    s = sanitize(JSON.parse(fs.readFileSync(file(), "utf8")));
  } catch {
    s = { ...DEFAULT_LIVE_SETTINGS };
  }
  return forcedOff || forcedMirrorOff ? { ...s, enabled: forcedOff ? false : s.enabled, mirrorEnabled: forcedMirrorOff ? false : s.mirrorEnabled } : s;
}

function write(next: LiveSettings): void {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, f);
}

/** Changes the settings that carry no risk by themselves (daily loss limit, warnings). Never turns the switch ON. The mirror is changed by enableMirror / turnMirrorOff only
 * (`mirrorEnabled` here is for tests and for code that already holds the right to do it). */
export function updateLiveSettings(patch: Partial<Pick<LiveSettings, "mirrorEnabled" | "dailyLossUsd" | "warnings">>, now: number = Date.now()): LiveSettings {
  const cur = readLiveSettings();
  const next = sanitize({ ...cur, ...patch, enabled: cur.enabled, resume: cur.resume, updatedAt: now });
  write(next);
  if (patch.mirrorEnabled === true) forcedMirrorOff = false;
  return next;
}

/**
 * Turns the toggle OFF, at once and whatever happens to the disk. Says why. Never throws. It also clears the saved ON state (`resume`): EVERY way the toggle goes OFF comes through
 * here, so nothing that turned it OFF (a click, an alarm, the daily limit, a failed check, the kill switch, a stage change) can be undone by an auto resume. The mirror is left as it is.
 */
export function turnLiveOff(reason: string, now: number = Date.now()): void {
  forcedOff = true;
  try {
    const cur = readLiveSettings();
    write({ ...cur, enabled: false, resume: false, offReason: reason.slice(0, 500), offAt: now, updatedAt: now });
  } catch (err) {
    console.error("[live] could not write the OFF state; the switch is held OFF in memory until the next restart", err);
  }
  console.warn(`[live] switch turned OFF: ${reason}`);
}

/** Turns the mirror OFF, at once and whatever happens to the disk. Never throws. A mirrored signal can then no longer reach the live bot, not even to close. */
export function turnMirrorOff(reason: string, now: number = Date.now()): void {
  forcedMirrorOff = true;
  try {
    write({ ...readLiveSettings(), mirrorEnabled: false, updatedAt: now });
  } catch (err) {
    console.error("[live] could not write the mirror OFF state; the mirror is held OFF in memory until the next restart", err);
  }
  console.warn(`[live] mirror turned OFF: ${reason}`);
}

/**
 * Run once when the server starts. The toggle and the mirror are OFF in memory and on disk after every start, whatever they were: nothing is ON until the checks say so.
 * The saved ON state (`resume`) is kept: if it is true, liveControl.attemptAutoResume may turn the toggle ON again once the account check passes. If the toggle was ON but
 * `resume` is not true (a file from before this setting existed), it stays OFF as before. Returns whether a resume is waiting.
 */
export function bootLiveSettings(now: number = Date.now()): { resumePending: boolean } {
  const g = globalThis as typeof globalThis & { __liveBooted?: boolean };
  if (g.__liveBooted) return { resumePending: false };
  g.__liveBooted = true;
  const cur = readLiveSettings();
  if (cur.enabled && !cur.resume) turnLiveOff("The app restarted: the live switch is always OFF after a restart.", now);
  else if (cur.enabled || cur.resume) {
    forcedOff = true; // OFF in memory first, whatever the disk does
    try {
      write({ ...cur, enabled: false, offReason: null, offAt: null, updatedAt: now });
    } catch (err) {
      console.error("[live] could not write the restart state; the toggle is held OFF in memory until the checks pass", err);
    }
  }
  if (cur.mirrorEnabled) turnMirrorOff("The app restarted: the mirror is always OFF after a restart.", now);
  return { resumePending: readLiveSettings().resume };
}

export type EnableResult = { ok: true } | { ok: false; reason: string };

/**
 * The only way the toggle goes ON. Either (1) `confirmed: true`, the one "Are you sure?" click, or (2) `resume: true`, an auto resume, which is allowed only while the saved ON
 * state is still true. Both need a live key and an account check that passed just now; stage 2 also needs the live gate. Stage 1 is not held up by the gate.
 * Turning it ON turns the mirror ON in the same write (the live bot then receives the signals).
 */
export function enableLive(opts: { confirmed?: boolean; resume?: boolean; preflightOk: boolean; preflightWhy?: string; gate: { ok: boolean; why: string }; keyPresent: boolean }, now: number = Date.now()): EnableResult {
  const cur = readLiveSettings();
  if (opts.resume === true) {
    if (!cur.resume) return { ok: false, reason: "There is nothing to resume: the toggle was turned OFF." };
  } else if (opts.confirmed !== true) return { ok: false, reason: "Confirm that real money is involved to turn live trading on." };
  if (!opts.keyPresent) return { ok: false, reason: "There is no live key: BYBIT_LIVE_API_KEY and BYBIT_LIVE_API_SECRET are not set." };
  if (!opts.preflightOk) return { ok: false, reason: `The live account check did not pass: ${opts.preflightWhy ?? "see the page"}.` };
  if (cur.stage === 2 && !opts.gate.ok) return { ok: false, reason: `Stage 2 needs the live gate: ${opts.gate.why}` };
  const next: LiveSettings = { ...cur, enabled: true, mirrorEnabled: true, resume: true, typedAt: now, offReason: null, offAt: null, updatedAt: now };
  try {
    write(next);
  } catch (err) {
    return { ok: false, reason: `The setting could not be saved, so live stays OFF: ${err instanceof Error ? err.message : String(err)}` };
  }
  forcedOff = false;
  forcedMirrorOff = false;
  return { ok: true };
}

/** Stage 2 only with the gate passed; going back to stage 1 is always allowed. The toggle is turned OFF by any stage change: it is turned ON again deliberately. */
export function setStage(stage: LiveStage, gate: { ok: boolean; why: string }, now: number = Date.now()): EnableResult {
  if (stage === 2 && !gate.ok) return { ok: false, reason: `Stage 2 needs the live gate: ${gate.why}` };
  const cur = readLiveSettings();
  if (cur.stage === stage) return { ok: true };
  turnLiveOff(`The stage was changed to ${stage}: turn live trading ON again when you are ready.`, now);
  write({ ...readLiveSettings(), stage, enabled: false, updatedAt: now });
  return { ok: true };
}

/** Tests only. */
export function __resetLiveSettings(): void {
  forcedOff = false;
  forcedMirrorOff = false;
  (globalThis as { __liveBooted?: boolean }).__liveBooted = false;
  fs.rmSync(liveDataDir(), { recursive: true, force: true });
}
