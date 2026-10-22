// REHEARSAL RUNNER - the parts that touch the machine (starting the app, a lock file, notifications, the clipboard). Everything is passed in
// so tests can run them without starting anything.
import { REQUIRED_ENV, RefuseError } from "./lib.mjs";

/** The settings the rehearsal app is started with. Only the NAMES are ever printed or saved; the secret is read from a file and passed to the app. */
export function buildRehearsalEnv({ bridgeSecret, home, base = {} }) {
  const env = {
    BROKER: "ibkr",
    BRIDGE_URL: "http://localhost:8787",
    BRIDGE_SECRET: bridgeSecret,
    PRICE_SOURCE: "broker",
    BRIDGE_MAX_QUOTE_AGE_MS: "1200000",
    BRIDGE_SYMBOLS: "NDX",
    QUOTE_MAX_WIDTH: "3",
    CLOSE_MAX_ABOVE_MARKET: "1",
    CLOSE_USE_MARKS: "1",
    AUTOMATION_STORAGE: "files",
    AUTOMATION_DATA_DIR: `${home}/ndx-rehearsal-data`,
    WEBHOOK_SECRET: "rehearsal-only-secret-value",
  };
  // An optional extra the person exported in this Terminal is passed on (names only are recorded).
  if (base.CLOSE_CHASE_MAX) env.CLOSE_CHASE_MAX = base.CLOSE_CHASE_MAX;
  return env;
}

export function envNamesOf(env) {
  return Object.keys(env).filter((n) => env[n] !== undefined && env[n] !== "");
}

/**
 * Starts the app in the background. deps: { fs, spawn, isPortBusy(port), bridge (BridgeClient), env (from buildRehearsalEnv), cwd, logDir, now(), sleep,
 * waitForApp(): Promise<boolean>, print }. Refuses when port 3000 is busy or the bridge does not say paper is true.
 */
export async function startApp(deps) {
  const say = deps.print ?? (() => {});
  if (await deps.isPortBusy(3000)) throw new RefuseError("Refusing to start: port 3000 is busy, so an app is already running there. Stop it first (Ctrl+C in its Terminal, or: node scripts/rehearsal/cli.mjs stop).");
  let health;
  try {
    health = await deps.bridge.get("/health");
  } catch (err) {
    throw new RefuseError(`Refusing to start: the bridge cannot be reached (${err.message}). Start the bridge and log in to IB Gateway (paper) first.`);
  }
  if (health.paper !== true) throw new RefuseError("Refusing to start: the bridge does not say paper is true.");
  deps.fs.mkdirSync(deps.logDir, { recursive: true });
  const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, "-");
  const logFile = `${deps.logDir}/app-${stamp}.log`;
  const fd = deps.fs.openSync(logFile, "a");
  const child = deps.spawn("npm", ["run", "dev"], { cwd: deps.cwd, env: { ...(deps.baseEnv ?? {}), ...deps.env }, detached: true, stdio: ["ignore", fd, fd] });
  child.unref?.();
  const state = { pid: child.pid, startedAt: deps.now(), logFile, envNames: envNamesOf(deps.env) };
  deps.fs.writeFileSync(`${deps.logDir}/app.json`, JSON.stringify(state, null, 2));
  say(`Starting the app in the background (process ${child.pid}). Log file: ${logFile}`);
  const up = await deps.waitForApp();
  if (!up) {
    say("The app did not answer within the time allowed. Look at the log file above. It may still be starting; check with: node scripts/rehearsal/cli.mjs preflight");
    return { ...state, up: false };
  }
  say(`The app is up on http://localhost:3000`);
  say(`To stop it: node scripts/rehearsal/cli.mjs stop    (or: kill -- -${child.pid})`);
  return { ...state, up: true };
}

/** Stops only an app this runner started (the pid it wrote down), and only if that process still looks like ours. */
export async function stopApp(deps) {
  const say = deps.print ?? (() => {});
  const file = `${deps.logDir}/app.json`;
  if (!deps.fs.existsSync(file)) throw new RefuseError("Nothing to stop: this runner has not started an app (no app.json in the log folder). An app you started by hand is stopped with Ctrl+C in its Terminal.");
  const state = JSON.parse(deps.fs.readFileSync(file, "utf8"));
  const command = await deps.commandOf(state.pid);
  if (!command) {
    deps.fs.rmSync(file, { force: true });
    say(`Process ${state.pid} is no longer running. Cleaned up.`);
    return { stopped: false };
  }
  if (!/npm|next/.test(command)) throw new RefuseError(`Refusing to stop process ${state.pid}: it does not look like the app this runner started (${command.slice(0, 60)}).`);
  deps.kill(-state.pid, "SIGTERM");
  deps.fs.rmSync(file, { force: true });
  say(`Stopped the app (process group ${state.pid}).`);
  return { stopped: true };
}

/** One scenario at a time: a lock file with the pid of the runner. A lock whose process is gone is taken over. */
export function acquireLock(deps) {
  const file = `${deps.logDir}/scenario.lock`;
  deps.fs.mkdirSync(deps.logDir, { recursive: true });
  if (deps.fs.existsSync(file)) {
    const other = Number(deps.fs.readFileSync(file, "utf8").trim());
    if (other && deps.isAlive(other)) throw new RefuseError(`Refusing to run: another scenario is running (process ${other}). One scenario at a time.`);
  }
  deps.fs.writeFileSync(file, String(deps.pid));
  return () => deps.fs.rmSync(file, { force: true });
}

/** A macOS notification, with the text passed as arguments (never through a shell). Failures are ignored: a missing notification is not a failed run. */
export function makeNotifier(execFile, platform = process.platform) {
  return (title, message) => {
    if (platform !== "darwin") return;
    const clean = (s) => String(s).replace(/[\\"]/g, "").slice(0, 200);
    try {
      execFile("osascript", ["-e", `display notification "${clean(message)}" with title "${clean(title)}"`], () => {});
    } catch {
      /* ignore */
    }
  };
}

/** Copies text to the clipboard with pbcopy. Returns whether it worked. */
export function makeCopier(spawn, platform = process.platform) {
  return (text) =>
    new Promise((resolve) => {
      if (platform !== "darwin") return resolve(false);
      try {
        const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
        p.on("error", () => resolve(false));
        p.on("close", (code) => resolve(code === 0));
        p.stdin.end(text);
      } catch {
        resolve(false);
      }
    });
}

export { REQUIRED_ENV };
