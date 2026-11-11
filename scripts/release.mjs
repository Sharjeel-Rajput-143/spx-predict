#!/usr/bin/env node
// THE RELEASE TOOL. The live bot runs from a BUILT COPY in ~/spx-live (next build + next start), not from the folder where code is edited. Editing, testing and building
// happen in copies; the live copy changes only when a person runs `promote`, at a time they choose, when no trade is open.
//
//   node scripts/release.mjs setup              once: make ~/spx-live, copy .env.local there (owner only), write the launch jobs (does not install or start anything)
//   node scripts/release.mjs check-env          AUTH_SECRET: set / length / ok (never printed)
//   node scripts/release.mjs prepare            snapshot the working code into a release, then typecheck, test and build it there (low priority, memory-guarded)
//   node scripts/release.mjs rehearse [id]      start the built release on port 3100 in dry-run on a COPY of the data, prove the pages answer, stop it
//   node scripts/release.mjs promote [id] --i-chose-the-time [--wait]     THE ONLY COMMAND THAT CHANGES WHAT IS LIVE (see docs/release.md)
//   node scripts/release.mjs rollback           one step back to the previous release
//   node scripts/release.mjs status             what is live, what is prepared, memory, the down-watcher
//
// Nothing here prints the contents of .env.local, a token or a key.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const WORKING = path.resolve(import.meta.dirname, "..");
export const LIVE_ROOT = process.env.SPX_LIVE_ROOT || path.join(os.homedir(), "spx-live");
export const P = {
  releases: path.join(LIVE_ROOT, "releases"),
  shared: path.join(LIVE_ROOT, "shared"),
  data: path.join(LIVE_ROOT, "data"),
  logs: path.join(LIVE_ROOT, "logs"),
  bin: path.join(LIVE_ROOT, "bin"),
  launchd: path.join(LIVE_ROOT, "launchd"),
  current: path.join(LIVE_ROOT, "current"),
  previous: path.join(LIVE_ROOT, "previous"),
  envFile: path.join(LIVE_ROOT, "shared", ".env.local"),
  maintenance: path.join(LIVE_ROOT, "shared", "maintenance-until"),
};
export const LABELS = { app: "com.spxlive.app", watch: "com.spxlive.watch" };
export const LIVE_PORT = 3000;
export const REHEARSAL_PORT = 3100;
export const MIN_FREE_PCT = 30; // refuse to start a heavy step below this (macOS "System-wide memory free percentage")
export const ABORT_FREE_PCT = 15; // kill a heavy step that pushes the machine below this
export const MIN_FREE_GB = 2.5;
export const MIN_DISK_GB = 2; // a release is about 0.7 GB; below this the live app's own records and logs could not be written, so no build starts
export const MIN_DISK_GB_REHEARSE = 0.5; // a rehearsal writes only a copy of the records and a log
export const MIN_AUTH_SECRET = 32;
export const RECENT_SIGNAL_MS = 3 * 60_000; // no swap if a signal arrived in the last 3 minutes
export const MAX_WAIT_MS = 2 * 60 * 60_000; // --wait gives up after 2 hours

// ---------------------------------------------------------------- small pure helpers (tested)

/** "System-wide memory free percentage: 38%" -> 38 */
export function parseFreePercent(text) {
  const m = /free percentage:\s*(\d+)%/i.exec(text);
  return m ? Number(m[1]) : null;
}
/** vm_stat -> free + inactive + speculative, in GB. */
export function parseVmStat(text) {
  const ps = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const n = (label) => Number((new RegExp(`${label}:\\s+(\\d+)`).exec(text)?.[1]) ?? 0);
  return ((n("Pages free") + n("Pages inactive") + n("Pages speculative")) * ps) / 1024 ** 3;
}
export function memoryGate({ freePct, freeGb }) {
  if (freePct === null || freePct === undefined) return { ok: false, why: "could not read the machine's memory" };
  if (freePct < MIN_FREE_PCT) return { ok: false, why: `only ${freePct}% of memory is free (need ${MIN_FREE_PCT}%): a build now could push the running dev server over its memory limit and restart it` };
  if (freeGb < MIN_FREE_GB) return { ok: false, why: `only ${freeGb.toFixed(1)} GB is free (need ${MIN_FREE_GB} GB)` };
  return { ok: true, why: `${freePct}% free, ${freeGb.toFixed(1)} GB available` };
}

/** Free disk space, in GB, on the volume that holds the live folder. */
export function diskGate({ freeGb, minGb = MIN_DISK_GB }) {
  if (freeGb === null || freeGb === undefined || !Number.isFinite(freeGb)) return { ok: false, why: "could not read the free disk space" };
  if (freeGb < minGb) return { ok: false, why: `only ${freeGb.toFixed(1)} GB of disk is free (need ${minGb} GB): a release takes about 0.7 GB, and the live app must always be able to write its records and logs` };
  return { ok: true, why: `${freeGb.toFixed(1)} GB of disk free` };
}
export function readDiskFreeGb() {
  try {
    const st = fs.statfsSync(os.homedir());
    return (Number(st.bavail) * Number(st.bsize)) / 1024 ** 3;
  } catch {
    return null;
  }
}

/**
 * The only moments a swap may start: 1 to 2 minutes after a 5 minute bar closes (:01:00 to :02:30 past a multiple of five), so it is over well before the next close
 * and never right before one. Returns { ok, waitMs } where waitMs is how long until the window opens (0 inside it).
 */
export function promoteWindow(date) {
  const into = (date.getMinutes() % 5) * 60_000 + date.getSeconds() * 1000 + date.getMilliseconds();
  const open = 60_000;
  const close = 150_000;
  if (into >= open && into <= close) return { ok: true, waitMs: 0 };
  return { ok: false, waitMs: into < open ? open - into : 5 * 60_000 - into + open };
}

/** AUTH_SECRET from the text of an env file: whether it is set and how long it is. The value is never returned. */
export function authSecretStatus(envText) {
  let length = 0;
  let present = false;
  for (const line of String(envText).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?AUTH_SECRET\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[1];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    present = v.length > 0;
    length = v.length;
  }
  return { present, length, ok: length >= MIN_AUTH_SECRET };
}
export const AUTH_SECRET_HELP = `AUTH_SECRET is missing or shorter than ${MIN_AUTH_SECRET} characters. A built (production) app refuses to sign anyone in without it. To add it: in Terminal run  openssl rand -base64 48  , then add one line  AUTH_SECRET=<that text>  to .env.local in the project folder (do not share it or paste it into a chat), and run the release again. Changing it signs everybody out once.`;

export function releaseId(d = new Date()) {
  const z = (n) => String(n).padStart(2, "0");
  return `r-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

export const sha256File = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** relative path -> sha256, for every file under dir. */
export function treeHashes(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.set(path.relative(dir, full), sha256File(full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
/** Is dst an exact copy of src? */
export function verifyCopy(src, dst) {
  const a = treeHashes(src);
  const b = treeHashes(dst);
  const missing = [...a.keys()].filter((k) => !b.has(k));
  const differing = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));
  return { ok: missing.length === 0 && differing.length === 0, files: a.size, missing, differing };
}

/** Does the bot's own record keep any position open, opening or closing? (positions.json in a data folder) */
export function openPositionsInRecords(dataAutomationDir) {
  const f = path.join(dataAutomationDir, "positions.json");
  if (!fs.existsSync(f)) return 0;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  const rows = Array.isArray(j) ? j : (j.items ?? j.rows ?? []);
  return rows.filter((p) => ["open", "opening", "closing"].includes(p.status)).length;
}

/** The newest moment a signal arrived or a webhook fired, from the records in a data folder (0 if none). Read only. */
export function latestActivity(dataAutomationDir) {
  const items = (file) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dataAutomationDir, file), "utf8"));
      return Array.isArray(j) ? j : (j.items ?? []);
    } catch { return []; }
  };
  const times = [...items("signals.json").map((x) => Number(x.receivedAt)), ...items("webhooks.json").map((x) => Number(x.lastTriggeredAt))].filter((n) => Number.isFinite(n) && n > 0);
  return times.length ? Math.max(...times) : 0;
}

/**
 * From the read-only Bybit check's text: is the account flat with no live orders? The check prints two plain lines worked out from Bybit's FULL reply
 * ("HELD POSITIONS: n", "OPEN ORDERS: n"). Anything unclear (a line missing, a call that failed, a number that is not 0) counts as NOT flat.
 */
export function parseFlat(checkText) {
  const text = String(checkText ?? "");
  const held = /HELD POSITIONS:\s*(\d+)/.exec(text);
  const orders = /OPEN ORDERS:\s*(\d+)/.exec(text);
  const allPassed = /All calls passed/.test(text) && !/^FAILED/m.test(text);
  const flat = !!held && Number(held[1]) === 0 && allPassed;
  const noOrders = !!orders && Number(orders[1]) === 0 && allPassed;
  return { flat, noOrders, ok: flat && noOrders };
}

export function plistApp({ root = LIVE_ROOT, node = process.execPath } = {}) {
  const env = { NODE_ENV: "production", AUTOMATION_DATA_DIR: path.join(root, "data", "automation"), PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", PORT: String(LIVE_PORT) };
  return plist(LABELS.app, [node, path.join(root, "current", "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(LIVE_PORT)], { WorkingDirectory: path.join(root, "current"), EnvironmentVariables: env, KeepAlive: true, RunAtLoad: true, ThrottleInterval: 5, StandardOutPath: path.join(root, "logs", "app.log"), StandardErrorPath: path.join(root, "logs", "app.log") });
}
export function plistWatch({ root = LIVE_ROOT, node = process.execPath } = {}) {
  return plist(LABELS.watch, [node, path.join(root, "bin", "livewatch.mjs")], { StartInterval: 30, RunAtLoad: true, EnvironmentVariables: { SPX_LIVE_ROOT: root, PATH: "/usr/local/bin:/usr/bin:/bin" }, StandardOutPath: path.join(root, "logs", "watch.log"), StandardErrorPath: path.join(root, "logs", "watch.log") });
}
function plist(label, args, rest) {
  const xml = (v, ind = "  ") => {
    if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
    if (typeof v === "number") return `<integer>${v}</integer>`;
    if (typeof v === "string") return `<string>${v.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`;
    if (Array.isArray(v)) return `<array>\n${v.map((x) => `${ind}  ${xml(x, ind + "  ")}`).join("\n")}\n${ind}</array>`;
    return `<dict>\n${Object.entries(v).map(([k, x]) => `${ind}  <key>${k}</key>\n${ind}  ${xml(x, ind + "  ")}`).join("\n")}\n${ind}</dict>`;
  };
  const body = { Label: label, ProgramArguments: args, ...rest };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${xml(body, "")}\n</plist>\n`;
}

// ---------------------------------------------------------------- machine helpers

export function readMemory() {
  const mp = spawnSync("memory_pressure", [], { encoding: "utf8" }).stdout ?? "";
  const vm = spawnSync("vm_stat", [], { encoding: "utf8" }).stdout ?? "";
  return { freePct: parseFreePercent(mp), freeGb: parseVmStat(vm) };
}
const say = (l = "") => console.log(l);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The words that put a command at low priority: background QoS (taskpolicy -b, found in /usr/sbin on current macOS) plus nice 19. Falls back to nice alone, then to nothing. */
export function lowPriorityPrefix(exists = fs.existsSync) {
  const nice = ["/usr/bin/nice", "/bin/nice"].find((f) => exists(f));
  const tp = ["/usr/sbin/taskpolicy", "/usr/bin/taskpolicy"].find((f) => exists(f));
  return [...(tp ? [tp, "-b"] : []), ...(nice ? [nice, "-n", "19"] : [])];
}

/** Runs a command at LOW priority (background QoS + nice 19), watching memory every 5 s: below ABORT_FREE_PCT it is killed, so the dev server is never pushed into its own restart. */
export function runGuarded(cmd, args, { cwd, env = {}, logFile, memory = readMemory } = {}) {
  return new Promise((resolve) => {
    const out = logFile ? fs.openSync(logFile, "w") : "ignore";
    const [first, ...pre] = [...lowPriorityPrefix(), cmd];
    const child = spawn(first, [...pre, ...args], { cwd, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048", ...env }, stdio: ["ignore", out, out], detached: true });
    let aborted = null;
    let spawnError = null;
    child.on("error", (err) => {
      spawnError = err.message;
      clearInterval(watcher);
      if (typeof out === "number") try { fs.closeSync(out); } catch { /* closed */ }
      resolve({ code: -1, aborted: `could not start the command (${spawnError})` });
    });
    const watcher = setInterval(() => {
      const m = memory();
      if (m.freePct !== null && m.freePct < ABORT_FREE_PCT) {
        aborted = `memory fell to ${m.freePct}% free`;
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      }
    }, 5000);
    child.on("close", (code) => {
      clearInterval(watcher);
      if (spawnError) return;
      if (typeof out === "number") fs.closeSync(out);
      resolve({ code: aborted ? -1 : code, aborted });
    });
  });
}

function requireGate({ minDiskGb = MIN_DISK_GB } = {}) {
  const g = memoryGate(readMemory());
  if (!g.ok) throw new Error(`Not starting: ${g.why}.`);
  say(`memory: ${g.why}`);
  const d = diskGate({ freeGb: readDiskFreeGb(), minGb: minDiskGb });
  if (!d.ok) throw new Error(`Not starting: ${d.why}.`);
  say(`disk: ${d.why}`);
}

// ---------------------------------------------------------------- commands

export function cmdSetup({ envSrc } = {}) {
  for (const d of [P.releases, P.shared, P.data, P.logs, P.bin, P.launchd]) fs.mkdirSync(d, { recursive: true });
  syncEnv(envSrc);
  fs.copyFileSync(path.join(WORKING, "scripts", "livewatch.mjs"), path.join(P.bin, "livewatch.mjs"));
  // The two launch jobs are only KEPT here. They are copied into ~/Library/LaunchAgents (where macOS would load them at every login) by promote, not before.
  fs.writeFileSync(path.join(P.launchd, `${LABELS.app}.plist`), plistApp());
  fs.writeFileSync(path.join(P.launchd, `${LABELS.watch}.plist`), plistWatch());
  say(`set up ${LIVE_ROOT}. The two launch jobs are written to ${path.relative(os.homedir(), P.launchd)} but NOT installed or loaded: nothing is running or changed until promote.`);
  cmdCheckEnv();
}

/** Copies the working .env.local to shared (owner only). Says only whether it changed, never what is in it. */
export function syncEnv(src = path.join(WORKING, ".env.local"), dst = P.envFile) {
  if (!fs.existsSync(src)) throw new Error("No .env.local in the project folder to copy.");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const changed = !fs.existsSync(dst) || sha256File(src) !== sha256File(dst);
  if (changed) fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o600);
  say(`.env.local ${changed ? "copied to" : "already the same in"} ${path.relative(os.homedir(), dst)} (owner only). REMINDER: a change to .env.local only takes effect at a release; the live app keeps using the copy it was started with.`);
  return changed;
}

export function cmdCheckEnv(file = fs.existsSync(P.envFile) ? P.envFile : path.join(WORKING, ".env.local")) {
  const s = authSecretStatus(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  say(`AUTH_SECRET: ${s.present ? `set, ${s.length} characters` : "NOT set"} - ${s.ok ? "ok" : "NOT OK"}`);
  if (!s.ok) say(AUTH_SECRET_HELP);
  return s;
}

// .env.example (the template) goes in, because tests read it and the release never leaves this Mac; every other .env file stays out.
export function snapshotFiles(root = WORKING) {
  const list = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean);
  return list.filter((f) => !/(^|\/)\.env($|\.(?!example$))|^data\/|(^|\/)node_modules\/|^\.next\/|\.tsbuildinfo$|\.log$|\.zip$|(^|\/)\.DS_Store$|^scratchpad\/|^\.claude\//.test(f) && fs.existsSync(path.join(root, f)));
}

export async function cmdPrepare() {
  requireGate();
  if (!fs.existsSync(P.envFile)) throw new Error("Run  node scripts/release.mjs setup  first.");
  const s = cmdCheckEnv();
  if (!s.ok) throw new Error("AUTH_SECRET is not usable (see above).");
  const id = releaseId();
  const dir = path.join(P.releases, id);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  const files = snapshotFiles();
  const list = path.join(dir, "logs", "files.txt");
  fs.writeFileSync(list, files.join("\n") + "\n");
  execFileSync("rsync", ["-a", "--files-from", list, WORKING + "/", dir + "/"]);
  // node_modules is cloned (copy-on-write on APFS: instant and almost no extra disk), so the release has exactly the packages the code was tested with.
  execFileSync("cp", ["-cR", path.join(WORKING, "node_modules"), path.join(dir, "node_modules")]);
  const manifest = createHash(files, dir);
  say(`release ${id}: ${files.length} files snapshotted (${manifest.slice(0, 12)}). Typecheck, tests and build run at low priority.`);
  const meta = { id, createdAt: new Date().toISOString(), files: files.length, sourceHash: manifest, verified: {} };
  const save = () => fs.writeFileSync(path.join(dir, "RELEASE.json"), JSON.stringify(meta, null, 2));
  save();
  const step = async (name, cmd, args, env = {}) => {
    requireGate();
    const started = Date.now();
    say(`  ${name} ...`);
    const r = await runGuarded(cmd, args, { cwd: dir, env, logFile: path.join(dir, "logs", `${name}.log`) });
    if (r.code !== 0) throw new Error(`${name} FAILED${r.aborted ? ` (stopped: ${r.aborted})` : ""}; see ${path.join(dir, "logs", `${name}.log`)}`);
    meta.verified[name] = { at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000) };
    save();
    say(`  ${name} passed (${meta.verified[name].seconds} s)`);
  };
  const bin = (n) => path.join(dir, "node_modules", ".bin", n);
  await step("typecheck", bin("tsc"), ["--noEmit"]);
  await step("tests", bin("vitest"), ["run", "--maxWorkers=2"]);
  fs.symlinkSync(P.envFile, path.join(dir, ".env.local"));
  await step("build", bin("next"), ["build"], { NODE_ENV: "production" });
  // The build may have made an empty data folder here: the release's data is the shared one.
  fs.rmSync(path.join(dir, "data"), { recursive: true, force: true });
  fs.symlinkSync(P.data, path.join(dir, "data"));
  say(`release ${id} is built. Next: node scripts/release.mjs rehearse ${id}`);
  return id;
}
function createHash(files, root) {
  const h = crypto.createHash("sha256");
  for (const f of files) h.update(f).update(fs.readFileSync(path.join(root, f)));
  return h.digest("hex");
}

export function latestRelease() {
  if (!fs.existsSync(P.releases)) return null;
  return fs.readdirSync(P.releases).filter((n) => /^r-\d{8}-\d{6}$/.test(n)).sort().at(-1) ?? null;
}
export function liveDataSource() {
  // Before the first cutover the live records are in the project folder; after it, in ~/spx-live/data.
  const moved = path.join(P.data, "automation");
  return fs.existsSync(moved) ? moved : path.join(WORKING, "data", "automation");
}

async function waitReady(port, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://localhost:${port}/hook/warm`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}
function warm(dir, port) {
  const r = spawnSync(process.execPath, [path.join(dir, "scripts", "warm.mjs"), `http://localhost:${port}`], { encoding: "utf8" });
  return { ok: r.status === 0, text: r.stdout };
}

export async function cmdRehearse(id = latestRelease()) {
  if (!id) throw new Error("No release prepared.");
  const dir = path.join(P.releases, id);
  const metaFile = path.join(dir, "RELEASE.json");
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  if (!meta.verified?.build) throw new Error(`Release ${id} is not built.`);
  requireGate({ minDiskGb: MIN_DISK_GB_REHEARSE });
  const rdata = path.join(dir, "rehearsal-data");
  fs.rmSync(rdata, { recursive: true, force: true });
  fs.cpSync(liveDataSource(), path.join(rdata, "automation"), { recursive: true });
  say(`rehearsing ${id} on port ${REHEARSAL_PORT}: dry-run (the watchdog, the risk monitor and every order are OFF), on a COPY of the data.`);
  const log = fs.openSync(path.join(dir, "logs", "rehearsal.log"), "w");
  const [first, ...pre] = [...lowPriorityPrefix(), process.execPath];
  const child = spawn(first, [...pre, path.join(dir, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(REHEARSAL_PORT)], {
    cwd: dir, detached: true, stdio: ["ignore", log, log],
    env: { ...process.env, NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=1024", AUTOMATION_DATA_DIR: path.join(rdata, "automation"), AUTOMATION_DRY_RUN: "true" },
  });
  let result;
  try {
    if (!(await waitReady(REHEARSAL_PORT))) throw new Error("the built copy did not start within 60 s; see logs/rehearsal.log");
    const first = warm(dir, REHEARSAL_PORT);
    const second = warm(dir, REHEARSAL_PORT);
    say(first.text);
    say(second.text);
    const hsts = (await fetch(`http://localhost:${REHEARSAL_PORT}/hook/warm`)).headers.get("strict-transport-security");
    result = first.ok && second.ok;
    say(`production headers present: ${hsts ? "yes" : "NO"}`);
  } finally {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
    await sleep(1000);
  }
  if (result) {
    meta.verified.rehearsal = { at: new Date().toISOString() };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  }
  fs.rmSync(rdata, { recursive: true, force: true });
  say(result ? `rehearsal of ${id} PASSED. Nothing live was touched.` : `rehearsal of ${id} FAILED.`);
  return !!result;
}

// ---------------------------------------------------------------- promote / rollback

/**
 * Stops a launch job and WAITS until launchd has really unloaded it. `launchctl bootout` returns before the job is gone, and starting it again too soon fails with
 * "Bootstrap failed: 5: Input/output error" (it did, on 2026-11-10, and the first try at release 2 was rolled back because of it).
 * `lc(...args)` runs launchctl and returns { status, stderr }.
 */
export async function launchStop(lc, target, sleepFn, tries = 20) {
  lc("bootout", target);
  for (let i = 0; i < tries; i++) {
    if (lc("print", target).status !== 0) return true; // gone
    await sleepFn(500);
  }
  return false;
}

/**
 * Starts a launch job and does not stop trying until it is loaded: a failed bootstrap is asked again a second later (up to `tries` times). If the job turns out to be
 * loaded already, it is restarted instead. Returns false only if it never loaded, which the caller must treat as a failure (never as success).
 */
export async function launchStart(lc, domain, plist, target, sleepFn, tries = 20) {
  for (let i = 0; i < tries; i++) {
    if (lc("bootstrap", domain, plist).status === 0) return true; // loading the job starts it (RunAtLoad)
    if (lc("print", target).status === 0) {
      lc("kickstart", "-k", target); // it is loaded: restart it
      return true;
    }
    await sleepFn(1000);
  }
  return false;
}

/** Everything promote does to the machine, so a test can replace it. */
export function realOps() {
  const uid = process.getuid();
  const lc = (...a) => spawnSync("launchctl", a, { encoding: "utf8" });
  return {
    now: () => new Date(),
    sleep,
    memory: readMemory,
    syncEnv,
    authSecret: () => cmdCheckEnv(P.envFile),
    recordsOpen: () => openPositionsInRecords(liveDataSource()),
    lastSignalAt: () => latestActivity(liveDataSource()),
    migrateData: () => migrateData(),
    accountFlat: () => parseFlat(spawnSync(process.execPath, [path.join(WORKING, "scripts", "bybit", "check.mjs")], { encoding: "utf8" }).stdout ?? ""),
    stopLive: async () => {
      await launchStop(lc, `gui/${uid}/${LABELS.app}`, sleep);
      // First cutover: whatever answers on the live port is the dev server. Stop it (its parent `next dev` first, or it would start the child again).
      const pids = (spawnSync("lsof", ["-ti", `tcp:${LIVE_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout ?? "").split("\n").filter(Boolean);
      for (const pid of pids) {
        const ppid = (spawnSync("ps", ["-o", "ppid=", "-p", pid], { encoding: "utf8" }).stdout ?? "").trim();
        const pcmd = ppid ? (spawnSync("ps", ["-o", "command=", "-p", ppid], { encoding: "utf8" }).stdout ?? "") : "";
        if (/next dev/.test(pcmd)) try { process.kill(Number(ppid), "SIGTERM"); } catch { /* gone */ }
        try { process.kill(Number(pid), "SIGTERM"); } catch { /* gone */ }
      }
      for (let i = 0; i < 40; i++) {
        if (!(spawnSync("lsof", ["-ti", `tcp:${LIVE_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout ?? "").trim()) return true;
        await sleep(500);
      }
      return false;
    },
    startLive: async () => {
      const agent = installAgent(LABELS.app);
      logMark = fileSize(path.join(P.logs, "app.log"));
      return launchStart(lc, `gui/${uid}`, agent, `gui/${uid}/${LABELS.app}`, sleep);
    },
    startWatch: async () => {
      await launchStart(lc, `gui/${uid}`, installAgent(LABELS.watch), `gui/${uid}/${LABELS.watch}`, sleep);
    },
    /** A failed FIRST cutover: unload both jobs and take their files out of LaunchAgents, so nothing restarts the built copy at the next login. */
    removeAgents: () => {
      for (const label of [LABELS.watch, LABELS.app]) {
        lc("bootout", `gui/${uid}/${label}`);
        fs.rmSync(path.join(agentsDir(), `${label}.plist`), { force: true });
      }
    },
    startDevServer: () => { spawn("npm", ["run", "dev"], { cwd: WORKING, detached: true, stdio: "ignore" }).unref(); },
    waitReady: (ms) => waitReady(LIVE_PORT, ms),
    warm: (dir) => warm(dir, LIVE_PORT),
    startupCheckSeen: () => /Startup check/.test(sinceMark(path.join(P.logs, "app.log"), logMark)),
  };
}
const agentsDir = () => path.join(os.homedir(), "Library", "LaunchAgents");
/** Copies a launch job from ~/spx-live/launchd into ~/Library/LaunchAgents and returns the installed path. */
function installAgent(label) {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const dst = path.join(agentsDir(), `${label}.plist`);
  fs.copyFileSync(path.join(P.launchd, `${label}.plist`), dst);
  return dst;
}
let logMark = 0; // size of app.log when the live app was last started: only lines after it count as "this start"
export const fileSize = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
/** The part of a log file written after byte `mark` (all of it if the file was replaced by a shorter one). */
export function sinceMark(file, mark = 0) {
  try {
    const size = fs.statSync(file).size;
    const from = size < mark ? 0 : mark;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(size - from, 1 << 22));
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch { return ""; }
}
const readLink = (p) => { try { return fs.readlinkSync(p); } catch { return null; } };
function swapLink(link, target) {
  const tmp = `${link}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
}

/** Moves the live records to ~/spx-live/data (first cutover only): copy, verify every file by checksum, THEN set the old folder aside as a backup. */
export function migrateData({ from = path.join(WORKING, "data"), to = P.data, stamp = Date.now() } = {}) {
  const moved = [];
  for (const name of ["automation", "automations"]) {
    const src = path.join(from, name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(to, name);
    if (fs.existsSync(dst)) throw new Error(`${dst} already exists: refusing to overwrite live records.`);
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    const v = verifyCopy(src, dst);
    if (!v.ok) {
      fs.rmSync(dst, { recursive: true, force: true });
      throw new Error(`copy of ${name} did not verify (${v.missing.length} missing, ${v.differing.length} different): nothing was moved.`);
    }
    moved.push({ name, files: v.files, src, dst, backup: `${src}.pre-cutover-${stamp}` });
  }
  for (const m of moved) fs.renameSync(path.join(from, m.name), m.backup);
  return moved;
}

export async function promote({ id, wait = false, confirmed = false }, ops = realOps(), log = say) {
  const steps = [];
  const note = (s) => { steps.push(s); log(s); };
  if (!confirmed) throw new Error("promote needs --i-chose-the-time: it changes what is live, and only you choose when.");
  const dir = path.join(P.releases, id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "RELEASE.json"), "utf8"));
  for (const need of ["tests", "build", "rehearsal"]) if (!meta.verified?.[need]) throw new Error(`Release ${id} has not passed "${need}": not promoting.`);
  const firstCutover = readLink(P.current) === null;

  // 1-3. The moment (1 to 2 minutes after a 5 minute bar close), then the state of the bot and the account. With --wait, anything that is "not now" (a trade open or half open, a signal in the
  // last 3 minutes, memory) is waited out: it tries again at the next window, for up to MAX_WAIT_MS. Without --wait it refuses at once and says why.
  const notNow = (full) => {
    const g = memoryGate(ops.memory());
    if (!g.ok) return g.why;
    const open = ops.recordsOpen();
    if (open > 0) return `the bot's records show ${open} position(s) open, opening or closing`;
    const last = ops.lastSignalAt();
    if (last && ops.now().getTime() - last < RECENT_SIGNAL_MS) return `a signal arrived ${Math.round((ops.now().getTime() - last) / 1000)} s ago (a swap needs ${RECENT_SIGNAL_MS / 60_000} quiet minutes)`;
    if (full && !ops.accountFlat().ok) return "the Bybit demo account is not confirmed flat with no live orders (read-only check)";
    return null;
  };
  const deadline = ops.now().getTime() + MAX_WAIT_MS;
  let leaveWindow = false;
  let changed = false;
  for (;;) {
    const w = promoteWindow(ops.now());
    if (leaveWindow) {
      if (w.ok) { await ops.sleep(5000); continue; }
      leaveWindow = false;
    }
    if (!w.ok) {
      if (!wait) throw new Error(`Not now: a swap starts only 1 to 2 minutes after a 5 minute bar closes (:x1:00 to :x2:30 past a multiple of 5). The next window opens in ${Math.ceil(w.waitMs / 1000)} s. Run again then, or add --wait.`);
      if (ops.now().getTime() > deadline) throw new Error("Gave up waiting: the conditions for a swap were not met within the time limit. Nothing was changed.");
      note(`waiting ${Math.ceil(w.waitMs / 1000)} s for the window...`);
      await ops.sleep(Math.min(w.waitMs, 5000));
      continue;
    }
    note("window ok");
    const why = notNow(true);
    if (why) {
      if (!wait) throw new Error(`Not now: ${why}.`);
      if (ops.now().getTime() > deadline) throw new Error(`Gave up waiting: ${why}. Nothing was changed.`);
      note(`not now: ${why}. Trying again at the next window.`);
      leaveWindow = true;
      continue;
    }
    note("no trade open, no signal in the last 3 minutes: records empty, Bybit flat, no live orders");
    // Settings: copy .env.local (it only takes effect now), check the sign-in key.
    changed = ops.syncEnv();
    note(`.env.local ${changed ? "CHANGED and was copied" : "unchanged"}; it takes effect only at a release like this one.`);
    const secret = ops.authSecret();
    if (!secret.ok) throw new Error(AUTH_SECRET_HELP);
    // One more look right before the stop: nothing may have opened or arrived while the checks ran.
    const late = notNow(false);
    if (late) {
      if (!wait) throw new Error(`Not now: ${late}.`);
      note(`not now: ${late}. Trying again at the next window.`);
      leaveWindow = true;
      continue;
    }
    break;
  }
  // 4. Stop, move data once, swap, start.
  fs.mkdirSync(path.dirname(P.maintenance), { recursive: true });
  fs.writeFileSync(P.maintenance, String(Date.now() + 10 * 60_000));
  const previousTarget = readLink(P.current);
  let migrated = null;
  const back = async (why) => {
    note(`ROLLING BACK: ${why}`);
    await ops.stopLive();
    if (previousTarget) {
      swapLink(P.current, previousTarget);
      const started = await ops.startLive();
      const ok = started && (await ops.waitReady(60_000));
      note(ok ? "rolled back: the previous release answers." : "rolled back, but the previous release is NOT answering: look at logs/app.log.");
    } else {
      // The first cutover has nothing before it but the dev server.
      for (const m of migrated ?? []) {
        try {
          fs.renameSync(m.dst, `${m.dst}.failed-${Date.now()}`);
          fs.renameSync(m.backup, m.src);
        } catch (err) {
          note(`!!! COULD NOT PUT ${m.name} BACK (${err.message}). The records are safe in ${m.backup} (the old folder) and ${m.dst}: copy ${m.backup} back to ${m.src} by hand before starting the dev server.`);
        }
      }
      fs.rmSync(P.current, { force: true });
      ops.removeAgents();
      ops.startDevServer();
      note("rolled back to the dev server in the project folder (records restored; check it answers).");
    }
    fs.rmSync(P.maintenance, { force: true });
  };
  if (!(await ops.stopLive())) { fs.rmSync(P.maintenance, { force: true }); throw new Error("the live process did not stop in 20 s; nothing was changed."); }
  note("live process stopped");
  try {
    if (firstCutover) {
      migrated = ops.migrateData();
      note(`records moved to ~/spx-live/data (${migrated.map((m) => `${m.name}: ${m.files} files verified`).join(", ")}); the old folders are kept as backups`);
    }
    if (previousTarget) swapLink(P.previous, previousTarget);
    swapLink(P.current, dir);
    note(`current -> ${id}`);
    if (!(await ops.startLive())) throw new Error("the launch job would not load (launchctl kept refusing it), so the new release was never started");
    await ops.startWatch();
    if (!(await ops.waitReady(60_000))) throw new Error("the new release did not answer within 60 s");
    const w1 = ops.warm(dir);
    const w2 = ops.warm(dir);
    log(w1.text);
    log(w2.text);
    if (!w1.ok || !w2.ok) throw new Error("the post-start check failed (webhook route, session check or Bybit page not answering fast)");
    for (let i = 0; i < 20 && !ops.startupCheckSeen(); i++) await ops.sleep(1000);
    if (!ops.startupCheckSeen()) throw new Error("the stop-loss watchdog's startup check did not appear in the log");
    note("webhook route, session check and Bybit page answer fast; the stop-loss watchdog ran its startup check");
  } catch (err) {
    await back(err.message);
    throw new Error(`Promote FAILED and was rolled back: ${err.message}`);
  }
  fs.rmSync(P.maintenance, { force: true });
  fs.writeFileSync(path.join(LIVE_ROOT, "PROMOTED.json"), JSON.stringify({ id, at: new Date().toISOString() }, null, 2));
  note(`${id} IS LIVE. Roll back in one step with:  node scripts/release.mjs rollback`);
  return steps;
}

export async function rollback(ops = realOps(), log = say) {
  const prev = readLink(P.previous);
  if (!prev) throw new Error("There is no previous release to go back to (the first cutover's rollback is: start the dev server again with  npm run dev  in the project folder).");
  const cur = readLink(P.current);
  fs.mkdirSync(path.dirname(P.maintenance), { recursive: true });
  fs.writeFileSync(P.maintenance, String(Date.now() + 10 * 60_000));
  await ops.stopLive();
  swapLink(P.current, prev);
  if (cur) swapLink(P.previous, cur);
  if (!(await ops.startLive())) throw new Error("rolled back, but the launch job would not load: look at ~/spx-live/logs/app.log and run  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.spxlive.app.plist");
  if (!(await ops.waitReady(60_000))) throw new Error("rolled back, but the previous release is not answering: look at ~/spx-live/logs/app.log");
  const w1 = ops.warm(prev);
  log(w1.text);
  fs.rmSync(P.maintenance, { force: true });
  log(w1.ok ? `rolled back to ${path.basename(prev)} and it answers.` : "rolled back but the post-start check failed.");
  return w1.ok;
}

export function cmdStatus() {
  const m = readMemory();
  say(`memory: ${m.freePct}% free, ${m.freeGb.toFixed(1)} GB available`);
  say(`live: ${readLink(P.current) ? path.basename(readLink(P.current)) : "none yet (the dev server in the project folder is live)"}; previous: ${readLink(P.previous) ? path.basename(readLink(P.previous)) : "none"}`);
  const l = latestRelease();
  say(`latest prepared release: ${l ?? "none"}${l ? ` verified: ${Object.keys(JSON.parse(fs.readFileSync(path.join(P.releases, l, "RELEASE.json"), "utf8")).verified ?? {}).join(", ")}` : ""}`);
  cmdCheckEnv();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (f) => rest.includes(f);
  const arg = rest.find((a) => !a.startsWith("--"));
  try {
    if (cmd === "setup") cmdSetup();
    else if (cmd === "check-env") process.exit(cmdCheckEnv().ok ? 0 : 1);
    else if (cmd === "prepare") await cmdPrepare();
    else if (cmd === "rehearse") process.exit((await cmdRehearse(arg)) ? 0 : 1);
    else if (cmd === "promote") await promote({ id: arg ?? latestRelease(), wait: flag("--wait"), confirmed: flag("--i-chose-the-time") });
    else if (cmd === "rollback") process.exit((await rollback()) ? 0 : 1);
    else if (cmd === "status") cmdStatus();
    else say("Usage: node scripts/release.mjs setup | check-env | prepare | rehearse [id] | promote [id] --i-chose-the-time [--wait] | rollback | status");
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
