#!/usr/bin/env node
// REHEARSAL RUNNER for the NDX bot. PAPER ONLY. See docs/rehearsal-runner.md for how to use it.
//
//   node scripts/rehearsal/cli.mjs preflight
//   node scripts/rehearsal/cli.mjs start
//   node scripts/rehearsal/cli.mjs stop
//   node scripts/rehearsal/cli.mjs scenario <open-bullish|open-bearish|close|flip|repeat-alert> [--price N] [--timeout-minutes N]
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_URL_DEFAULT, AppClient, BRIDGE_URL_DEFAULT, BridgeClient, RefuseError, SCENARIOS, formatChecks, makeRedactor, parseEnvText, runPreflight, runScenario } from "./lib.mjs";
import { acquireLock, buildRehearsalEnv, makeCopier, makeNotifier, startApp, stopApp } from "./ops.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const home = os.homedir();
const logDir = path.join(home, "ndx-rehearsal-logs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBridgeSecret() {
  const file = path.join(home, ".bridge_secret");
  if (!fs.existsSync(file)) throw new RefuseError(`The bridge secret file ${file} was not found.`);
  const s = fs.readFileSync(file, "utf8").trim();
  if (!s) throw new RefuseError(`${file} is empty.`);
  return s;
}

function readAppLogin() {
  const file = path.join(repo, ".env.local");
  if (!fs.existsSync(file)) return {};
  const v = parseEnvText(fs.readFileSync(file, "utf8"), ["APP_LOGIN_EMAIL", "APP_LOGIN_PASSWORD", "AUTOMATION_STATUS_PASSWORD"]);
  return { email: v.APP_LOGIN_EMAIL ?? "", password: v.APP_LOGIN_PASSWORD || v.AUTOMATION_STATUS_PASSWORD || "" };
}

function recordedEnvNames() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(logDir, "app.json"), "utf8"));
    // only trust the record while the process it names is still there
    process.kill(state.pid, 0);
    return Array.isArray(state.envNames) ? state.envNames : null;
  } catch {
    return null;
  }
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const bridgeSecret = (() => {
    try {
      return readBridgeSecret();
    } catch (err) {
      if (cmd === "stop") return "";
      throw err;
    }
  })();
  const login = readAppLogin();
  const redact = makeRedactor([bridgeSecret, login.password, "rehearsal-only-secret-value"]);
  const print = (line) => console.log(redact(line));
  const bridge = new BridgeClient({ fetchImpl: fetch, url: process.env.REHEARSAL_BRIDGE_URL || BRIDGE_URL_DEFAULT, secret: bridgeSecret });
  const app = new AppClient({ fetchImpl: fetch, url: process.env.REHEARSAL_APP_URL || APP_URL_DEFAULT, login });

  if (cmd === "preflight") {
    const result = await runPreflight({ bridge, app, recordedEnvNames: recordedEnvNames() });
    print(formatChecks(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (cmd === "start") {
    const env = buildRehearsalEnv({ bridgeSecret, home, base: process.env });
    await startApp({
      fs,
      spawn,
      bridge,
      env,
      baseEnv: process.env,
      cwd: repo,
      logDir,
      now: Date.now,
      print,
      isPortBusy: (port) =>
        new Promise((resolve) => {
          const s = net.createConnection({ port, host: "127.0.0.1" });
          s.setTimeout(1500);
          s.on("connect", () => (s.destroy(), resolve(true)));
          s.on("timeout", () => (s.destroy(), resolve(false)));
          s.on("error", () => resolve(false));
        }),
      waitForApp: async () => {
        for (let i = 0; i < 60; i++) {
          try {
            const r = await fetch(`${app.url}/api/automation/session`, { signal: AbortSignal.timeout(3000) });
            if (r.ok) return true;
          } catch {
            /* not up yet */
          }
          await sleep(1500);
        }
        return false;
      },
    });
    return;
  }

  if (cmd === "stop") {
    await stopApp({
      fs,
      logDir,
      print,
      kill: (pid, sig) => process.kill(pid, sig),
      commandOf: (pid) =>
        new Promise((resolve) => {
          execFile("ps", ["-p", String(pid), "-o", "command="], (err, out) => resolve(err ? "" : String(out).trim()));
        }),
    });
    return;
  }

  if (cmd === "scenario") {
    const name = args[0];
    if (!name || !SCENARIOS.includes(name)) throw new RefuseError(`Usage: scenario <${SCENARIOS.join("|")}>`);
    const release = acquireLock({
      fs,
      logDir,
      pid: process.pid,
      isAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
    });
    const notify = makeNotifier(execFile);
    const copy = makeCopier(spawn);
    try {
      const price = flag(args, "--price") ? Number(flag(args, "--price")) : undefined;
      const minutes = flag(args, "--timeout-minutes") ? Number(flag(args, "--timeout-minutes")) : 6;
      const result = await runScenario(name, { bridge, app, now: Date.now, sleep, pollMs: 3000, timeoutMs: minutes * 60_000, price, print });
      const text = redact(result.report);
      fs.mkdirSync(logDir, { recursive: true });
      const file = path.join(logDir, `report-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
      fs.writeFileSync(file, `${text}\n`);
      console.log(`\n${text}\n`);
      const copied = await copy(text);
      console.log(`Report saved to ${file}${copied ? " and copied to the clipboard" : " (the clipboard copy did not work)"}.`);
      notify(result.ok ? `Rehearsal ${name}: done` : result.needsAttention ? `Rehearsal ${name}: NEEDS ATTENTION` : `Rehearsal ${name}: check the report`, result.verdict);
      process.exitCode = result.ok ? 0 : 1;
    } catch (err) {
      if (err instanceof RefuseError) notify(`Rehearsal ${name}: not run`, err.message);
      throw err;
    } finally {
      release();
    }
    return;
  }

  console.log("Usage:\n  node scripts/rehearsal/cli.mjs preflight\n  node scripts/rehearsal/cli.mjs start\n  node scripts/rehearsal/cli.mjs stop\n  node scripts/rehearsal/cli.mjs scenario <" + SCENARIOS.join("|") + "> [--price N] [--timeout-minutes N]");
  process.exitCode = cmd ? 2 : 0;
}

main().catch((err) => {
  console.error(err instanceof RefuseError ? err.message : `Error: ${err?.message ?? err}`);
  process.exitCode = err instanceof RefuseError ? 3 : 1;
});
