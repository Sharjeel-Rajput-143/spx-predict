#!/usr/bin/env node
// THE DOWN-WATCHER. A launch job runs this every 30 seconds (see scripts/release.mjs). It asks the live app whether it answers (GET /hook/warm, which triggers nothing).
// Two failed looks in a row (about a minute) is "down": a Mac notification with a sound every minute until the app answers again, and a line in logs/watch.log.
// During a release on purpose (shared/maintenance-until holds a time in the future) it stays quiet. It also keeps quiet when the Mac was asleep (its own looks stop then).
// There is no phone alert: if you are away from the Mac you will not hear it.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FAILS_TO_ALARM = 2;
export const MAC_EVERY_MS = 60_000;

/** One look. Pure: returns the next state and what to do. `state`: { fails, downSince, lastMac }. */
export function step({ ok, now, maintenanceUntil = 0, state = {} }) {
  const s = { fails: 0, downSince: null, lastMac: 0, ...state };
  if (ok) return { state: { fails: 0, downSince: null, lastMac: 0 }, actions: s.downSince !== null ? ["mac-recovered"] : [] };
  if (now < maintenanceUntil) return { state: { ...s, fails: 0, downSince: null }, actions: [] };
  s.fails += 1;
  if (s.fails < FAILS_TO_ALARM) return { state: s, actions: [] };
  s.downSince ??= now;
  const actions = [];
  if (now - s.lastMac >= MAC_EVERY_MS - 1000) {
    actions.push("mac-down");
    s.lastMac = now;
  }
  return { state: s, actions };
}

async function main() {
  const root = process.env.SPX_LIVE_ROOT || path.join(os.homedir(), "spx-live");
  const stateFile = path.join(root, "logs", "watch-state.json");
  const read = (f, d) => {
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; }
  };
  let ok = false;
  try {
    const r = await fetch(`http://localhost:${process.env.PORT || 3000}/hook/warm`, { signal: AbortSignal.timeout(4000) });
    ok = r.ok;
  } catch { /* down */ }
  let maintenanceUntil = 0;
  try { maintenanceUntil = Number(fs.readFileSync(path.join(root, "shared", "maintenance-until"), "utf8")) || 0; } catch { /* none */ }
  const { state, actions } = step({ ok, now: Date.now(), maintenanceUntil, state: read(stateFile, {}) });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  for (const a of actions) {
    if (a === "mac-down") execFile("osascript", ["-e", 'display notification "bot is down" with title "SPX bot" sound name "Basso"'], () => undefined);
    if (a === "mac-recovered") execFile("osascript", ["-e", 'display notification "bot is back" with title "SPX bot"'], () => undefined);
  }
  if (actions.length) console.log(`${new Date().toISOString()} ${actions.join(",")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
