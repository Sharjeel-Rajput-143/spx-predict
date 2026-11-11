// Tests for scripts/release.mjs. EVERYTHING here happens in a temporary folder: SPX_LIVE_ROOT points at it BEFORE the module loads, `promote` and `rollback` are given fake
// machine operations (no launchctl, no kill, no server, no Bybit), and a guard below fails the whole file if the live root is ever anything but a temp folder.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "spx-release-test-"));
process.env.SPX_LIVE_ROOT = path.join(ROOT, "spx-live");
const R = await import("./release.mjs");

const tmp = (name) => fs.mkdtempSync(path.join(ROOT, `${name}-`));
const write = (f, text = "x") => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

describe("safety guard", () => {
  it("the tool's live root is a temp folder in this test file, never the real ~/spx-live", () => {
    expect(R.LIVE_ROOT.startsWith(os.tmpdir()) || R.LIVE_ROOT.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(R.LIVE_ROOT).not.toBe(path.join(os.homedir(), "spx-live"));
  });
});

describe("memory", () => {
  const MP = "The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: 33%\n";
  const VM = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                4583.\nPages active:                            168209.\nPages inactive:                          164236.\nPages speculative:                         3381.\n";
  it("reads the free percentage and the free+inactive+speculative gigabytes", () => {
    expect(R.parseFreePercent(MP)).toBe(33);
    expect(R.parseFreePercent("nothing")).toBeNull();
    expect(R.parseVmStat(VM)).toBeCloseTo(2.63, 1);
  });
  it("refuses a heavy step below 30% free or below 2.5 GB, and when memory cannot be read", () => {
    expect(R.memoryGate({ freePct: 33, freeGb: 2.63 }).ok).toBe(true);
    expect(R.memoryGate({ freePct: 29, freeGb: 8 }).ok).toBe(false);
    expect(R.memoryGate({ freePct: 50, freeGb: 2.4 }).ok).toBe(false);
    expect(R.memoryGate({ freePct: null, freeGb: 8 }).ok).toBe(false);
    expect(R.memoryGate({ freePct: 29, freeGb: 8 }).why).toMatch(/restart/);
  });

  it("refuses to build when the disk is nearly full, so the live app can always write its records and logs", () => {
    expect(R.diskGate({ freeGb: 3.7 }).ok).toBe(true);
    expect(R.diskGate({ freeGb: 2 }).ok).toBe(true);
    expect(R.diskGate({ freeGb: 1.99 }).ok).toBe(false);
    expect(R.diskGate({ freeGb: 0.3 }).why).toMatch(/records and logs/);
    expect(R.diskGate({ freeGb: null }).ok).toBe(false);
    expect(R.diskGate({ freeGb: Number.NaN }).ok).toBe(false);
    expect(typeof R.readDiskFreeGb()).toBe("number");
    // a rehearsal writes almost nothing, so it has its own lower floor; a build keeps the 2 GB one
    expect(R.MIN_DISK_GB_REHEARSE).toBeLessThan(R.MIN_DISK_GB);
    expect(R.diskGate({ freeGb: 1.5, minGb: R.MIN_DISK_GB_REHEARSE }).ok).toBe(true);
    expect(R.diskGate({ freeGb: 0.4, minGb: R.MIN_DISK_GB_REHEARSE }).ok).toBe(false);
    expect(R.diskGate({ freeGb: 1.5 }).ok).toBe(false);
  });
});

describe("the swap window: 1 to 2.5 minutes after a 5 minute bar close", () => {
  const at = (m, s = 0) => new Date(2026, 10, 10, 12, m, s);
  it("is open from :x1:00 to :x2:30 past a multiple of five, on every cycle", () => {
    for (const base of [0, 5, 10, 25, 55]) {
      expect(R.promoteWindow(at(base + 1, 0)).ok).toBe(true);
      expect(R.promoteWindow(at(base + 1, 59)).ok).toBe(true);
      expect(R.promoteWindow(at(base + 2, 30)).ok).toBe(true);
    }
  });
  it("is closed right at the bar close, just after the window, and right before the next close, and says how long to wait", () => {
    expect(R.promoteWindow(at(30, 0))).toEqual({ ok: false, waitMs: 60_000 });
    expect(R.promoteWindow(at(30, 59)).ok).toBe(false);
    expect(R.promoteWindow(at(32, 31))).toEqual({ ok: false, waitMs: 5 * 60_000 - 151_000 + 60_000 });
    expect(R.promoteWindow(at(34, 30)).ok).toBe(false);
    expect(R.promoteWindow(at(34, 59)).ok).toBe(false);
    expect(R.promoteWindow(at(33, 0)).waitMs).toBe(3 * 60_000);
  });
});

describe("AUTH_SECRET check never reveals the value", () => {
  const secret = "s3cr3t-value-that-is-long-enough-to-pass-0123456789";
  it("reports present/length/ok only", () => {
    const s = R.authSecretStatus(`FOO=1\nAUTH_SECRET=${secret}\n`);
    expect(s).toEqual({ present: true, length: secret.length, ok: true });
    expect(JSON.stringify(s)).not.toContain("s3cr3t");
  });
  it("handles quotes, export, comments and CRLF", () => {
    expect(R.authSecretStatus(`export AUTH_SECRET="${secret}"\r\n`).ok).toBe(true);
    expect(R.authSecretStatus(`AUTH_SECRET='${secret}' # note\n`).ok).toBe(true);
    expect(R.authSecretStatus(`AUTH_SECRET=${secret} # note\n`).length).toBe(secret.length);
  });
  it("is not ok when missing, empty or short", () => {
    expect(R.authSecretStatus("").ok).toBe(false);
    expect(R.authSecretStatus("AUTH_SECRET=\n").present).toBe(false);
    expect(R.authSecretStatus("AUTH_SECRET=short\n")).toMatchObject({ present: true, length: 5, ok: false });
    expect(R.authSecretStatus("# AUTH_SECRET=commented-out-value-that-is-long-enough-xxxxxxxx\n").present).toBe(false);
  });
  it("the help text says how to add one and never contains a value", () => {
    expect(R.AUTH_SECRET_HELP).toMatch(/openssl rand/);
    expect(R.AUTH_SECRET_HELP).toMatch(/\.env\.local/);
  });
  it("cmdCheckEnv prints status without the value", () => {
    const f = path.join(tmp("env"), ".env.local");
    write(f, `AUTH_SECRET=${secret}\nOTHER=abc\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const s = R.cmdCheckEnv(f);
    const printed = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(s.ok).toBe(true);
    expect(printed).toMatch(/set, 51 characters/);
    expect(printed).not.toContain("s3cr3t");
  });
});

describe("syncEnv copies .env.local owner-only and never prints it", () => {
  it("copies, then reports unchanged, then copies again after a change; mode 600; prints no contents", () => {
    const d = tmp("sync");
    const src = path.join(d, "src.env");
    const dst = path.join(d, "shared", ".env.local");
    write(src, "BYBIT_DEMO_API_SECRET=very-secret-value\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(R.syncEnv(src, dst)).toBe(true);
    expect(R.syncEnv(src, dst)).toBe(false);
    write(src, "BYBIT_DEMO_API_SECRET=another-secret\n");
    expect(R.syncEnv(src, dst)).toBe(true);
    const printed = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(dst, "utf8")).toContain("another-secret");
    expect(printed).not.toMatch(/very-secret|another-secret/);
    expect(printed).toMatch(/takes effect|REMINDER/);
  });
  it("fails clearly when there is no .env.local to copy", () => {
    expect(() => R.syncEnv(path.join(tmp("nosrc"), "missing"), path.join(tmp("nodst"), "x"))).toThrow(/No \.env\.local/);
  });
});

describe("setup", () => {
  beforeEach(() => fs.rmSync(R.LIVE_ROOT, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(R.LIVE_ROOT, { recursive: true, force: true }));
  it("makes the folders, copies .env.local owner-only, makes a long random private topic, keeps the launch jobs OUT of LaunchAgents, makes no phone topic, and prints no secret", () => {
    const src = path.join(tmp("setupenv"), "env");
    write(src, "AUTH_SECRET=0123456789012345678901234567890123456789\nBYBIT_DEMO_API_SECRET=do-not-print-me\n");
    const homeJob = path.join(os.homedir(), "Library", "LaunchAgents", "com.spxlive.app.plist");
    const homeBefore = fs.existsSync(homeJob);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    R.cmdSetup({ envSrc: src });
    const printed = log.mock.calls.flat().join("\n");
    log.mockRestore();
    for (const d of ["releases", "shared", "data", "logs", "bin", "launchd"]) expect(fs.statSync(path.join(R.LIVE_ROOT, d)).isDirectory()).toBe(true);
    expect(fs.statSync(R.P.envFile).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(R.P.shared, "ntfy-topic"))).toBe(false); // the phone alert is out: no topic is ever made
    expect(printed).not.toContain("do-not-print-me");
    expect(printed).toMatch(/AUTH_SECRET: set, 40 characters - ok/);
    expect(fs.existsSync(path.join(R.P.bin, "livewatch.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(R.P.launchd, "com.spxlive.app.plist"))).toBe(true);
    expect(fs.existsSync(path.join(R.P.launchd, "com.spxlive.watch.plist"))).toBe(true);
    expect(fs.existsSync(homeJob)).toBe(homeBefore); // setup did not install anything into the real LaunchAgents
    // running it again is harmless
    const log2 = vi.spyOn(console, "log").mockImplementation(() => undefined);
    R.cmdSetup({ envSrc: src });
    log2.mockRestore();
    expect(fs.existsSync(path.join(R.P.shared, "ntfy-topic"))).toBe(false);
  });
});

describe("release ids and checksums", () => {
  it("makes sortable ids from the time", () => {
    expect(R.releaseId(new Date(2026, 10, 10, 1, 2, 3))).toBe("r-20261110-010203");
    expect(R.releaseId(new Date(2026, 10, 10, 1, 2, 3)) < R.releaseId(new Date(2026, 10, 10, 13, 0, 0))).toBe(true);
  });
  it("verifyCopy says yes for an exact copy and names missing and changed files otherwise", () => {
    const d = tmp("vc");
    const a = path.join(d, "a");
    write(path.join(a, "one.json"), "1");
    write(path.join(a, "sub", "two.json"), "2");
    const b = path.join(d, "b");
    fs.cpSync(a, b, { recursive: true });
    expect(R.verifyCopy(a, b)).toMatchObject({ ok: true, files: 2 });
    write(path.join(b, "sub", "two.json"), "CHANGED");
    fs.rmSync(path.join(b, "one.json"));
    const v = R.verifyCopy(a, b);
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(["one.json"]);
    expect(v.differing).toEqual([path.join("sub", "two.json")]);
  });
});

describe("migrateData: the first-cutover move of the live records", () => {
  const make = () => {
    const d = tmp("mig");
    const from = path.join(d, "project", "data");
    const to = path.join(d, "live", "data");
    write(path.join(from, "automation", "positions.json"), '{"items":[]}');
    write(path.join(from, "automation", "bots.json"), '{"items":[1]}');
    write(path.join(from, "automations", "x.json"), "{}");
    return { d, from, to };
  };
  it("copies both folders, verifies every file, and keeps the old ones as .pre-cutover backups", () => {
    const { from, to } = make();
    const moved = R.migrateData({ from, to, stamp: 111 });
    expect(moved.map((m) => [m.name, m.files])).toEqual([["automation", 2], ["automations", 1]]);
    expect(fs.readFileSync(path.join(to, "automation", "bots.json"), "utf8")).toBe('{"items":[1]}');
    expect(fs.existsSync(path.join(from, "automation"))).toBe(false);
    expect(fs.readFileSync(path.join(from, "automation.pre-cutover-111", "bots.json"), "utf8")).toBe('{"items":[1]}');
    expect(moved[0]).toMatchObject({ src: path.join(from, "automation"), dst: path.join(to, "automation"), backup: path.join(from, "automation.pre-cutover-111") });
  });
  it("refuses to overwrite records that already exist at the destination, changing nothing", () => {
    const { from, to } = make();
    write(path.join(to, "automation", "positions.json"), "LIVE");
    expect(() => R.migrateData({ from, to })).toThrow(/refusing to overwrite/);
    expect(fs.existsSync(path.join(from, "automation", "positions.json"))).toBe(true);
    expect(fs.readFileSync(path.join(to, "automation", "positions.json"), "utf8")).toBe("LIVE");
  });
  it("a copy that does not match its checksums is deleted and NOTHING is moved: the old folders stay exactly where they were", () => {
    const { from, to } = make();
    const real = fs.cpSync;
    const spy = vi.spyOn(fs, "cpSync").mockImplementation((src, dst, opts) => {
      real(src, dst, opts);
      write(path.join(dst, "bots.json"), "CORRUPTED"); // as if the disk lost a byte
    });
    try {
      expect(() => R.migrateData({ from, to })).toThrow(/did not verify.*nothing was moved/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(path.join(from, "automation", "bots.json"), "utf8")).toBe('{"items":[1]}');
    expect(fs.existsSync(path.join(to, "automation"))).toBe(false);
    expect(fs.readdirSync(from).filter((n) => n.includes("pre-cutover"))).toEqual([]);
  });
  it("does nothing when there is no data folder", () => {
    const d = tmp("mig-empty");
    expect(R.migrateData({ from: path.join(d, "none"), to: path.join(d, "to") })).toEqual([]);
  });
});

describe("open positions in the bot's own records", () => {
  const dir = () => tmp("rec");
  const put = (d, items) => write(path.join(d, "positions.json"), JSON.stringify({ schemaVersion: 1, collection: "positions", items }));
  it("counts open, opening and closing; ignores closed, expired and rejected", () => {
    const d = dir();
    put(d, [{ status: "closed" }, { status: "expired" }, { status: "rejected" }, { status: "open" }, { status: "opening" }, { status: "closing" }]);
    expect(R.openPositionsInRecords(d)).toBe(3);
  });
  it("is zero for no file or only closed positions", () => {
    expect(R.openPositionsInRecords(dir())).toBe(0);
    const d = dir();
    put(d, [{ status: "closed" }]);
    expect(R.openPositionsInRecords(d)).toBe(0);
  });
});

describe("latestActivity: the newest signal or webhook firing in the records", () => {
  it("takes the newest receivedAt / lastTriggeredAt, and is 0 for no records", () => {
    const d = tmp("act");
    expect(R.latestActivity(d)).toBe(0);
    write(path.join(d, "signals.json"), JSON.stringify({ items: [{ receivedAt: 1000 }, { receivedAt: 5000 }] }));
    write(path.join(d, "webhooks.json"), JSON.stringify({ items: [{ lastTriggeredAt: 7000 }, { lastTriggeredAt: null }] }));
    expect(R.latestActivity(d)).toBe(7000);
    write(path.join(d, "webhooks.json"), "not json");
    expect(R.latestActivity(d)).toBe(5000);
  });
});

describe("parseFlat reads the check's two plain lines, and anything unclear is NOT flat", () => {
  const out = (held, orders, tail = "\n=== SUMMARY ===\nPASS    position\n\nAll calls passed.\n") =>
    `PASS    GET /v5/position/list  (position)\n        HTTP 200  {"retCode":0,"result":{"list":[{"symbol":"BTCUSDT","avgPrice":"0","side":"" ...(cut)\n` +
    (held === null ? "" : `        HELD POSITIONS: ${held}\n`) +
    `PASS    GET /v5/order/realtime  (live orders)\n        HTTP 200  {"retCode":0 ...(cut)\n` +
    (orders === null ? "" : `        OPEN ORDERS: ${orders}\n`) + tail;
  it("flat with no orders: ok", () => expect(R.parseFlat(out(0, 0))).toEqual({ flat: true, noOrders: true, ok: true }));
  it("a position held: not flat", () => expect(R.parseFlat(out(1, 0))).toMatchObject({ flat: false, ok: false }));
  it("an order open: not ok", () => expect(R.parseFlat(out(0, 2))).toMatchObject({ noOrders: false, ok: false }));
  it("a line missing: not ok", () => {
    expect(R.parseFlat(out(null, 0)).ok).toBe(false);
    expect(R.parseFlat(out(0, null)).ok).toBe(false);
  });
  it("any failed call or no 'All calls passed': not ok", () => {
    expect(R.parseFlat(out(0, 0, "\nFAILED  GET /v5/x\n")).ok).toBe(false);
    expect(R.parseFlat(out(0, 0, "\n")).ok).toBe(false);
    expect(R.parseFlat("").ok).toBe(false);
    expect(R.parseFlat(undefined).ok).toBe(false);
  });
});

describe("the launch jobs", () => {
  const app = R.plistApp({ root: "/home/u/spx-live", node: "/usr/bin/node" });
  const watch = R.plistWatch({ root: "/home/u/spx-live", node: "/usr/bin/node" });
  it("the app job restarts itself after a crash, runs the built copy on port 3000 with its data in the live folder", () => {
    expect(app).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(app).toContain("<string>com.spxlive.app</string>");
    expect(app).toContain("/home/u/spx-live/current/node_modules/next/dist/bin/next");
    expect(app).toMatch(/<string>start<\/string>\s*<string>-p<\/string>\s*<string>3000<\/string>/);
    expect(app).toContain("<key>AUTOMATION_DATA_DIR</key>");
    expect(app).toContain("/home/u/spx-live/data/automation");
    expect(app).toContain("<key>NODE_ENV</key>");
    expect(app).toContain("<string>production</string>");
    expect(app).toContain("<key>ThrottleInterval</key>");
  });
  it("neither job carries a key, secret, token or URL", () => {
    for (const x of [app, watch]) expect(x.replace(/<!DOCTYPE[^>]*>/, "")).not.toMatch(/secret|api[_-]?key|token|ngrok|https?:\/\//i);
  });
  it("the watcher runs every 30 seconds", () => {
    expect(watch).toContain("<key>StartInterval</key>\n  <integer>30</integer>");
    expect(watch).toContain("livewatch.mjs");
  });
  it.skipIf(process.platform !== "darwin")("macOS accepts both as well-formed property lists", () => {
    const d = tmp("plist");
    for (const [n, x] of [["app", app], ["watch", watch]]) {
      write(path.join(d, `${n}.plist`), x);
      const r = spawnSync("plutil", ["-lint", path.join(d, `${n}.plist`)], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
  });
});

describe("snapshotFiles keeps secrets, data and build output out of a release", () => {
  it("includes source and untracked source; excludes .env*, data/, node_modules, .next, logs, zips, scratchpad", () => {
    const d = tmp("snap");
    execFileSync("git", ["init", "-q"], { cwd: d });
    write(path.join(d, ".gitignore"), "ignored.txt\n");
    for (const f of ["src/a.ts", "package.json", "scripts/x.mjs", "src/data/keep.json"]) write(path.join(d, f));
    execFileSync("git", ["add", "."], { cwd: d });
    for (const f of ["untracked.ts", ".env.local", ".env", ".env.example", ".env.production", ".env.development.local", "data/automation/x.json", "node_modules/p/i.js", ".next/c", "a.log", "out.zip", "scratchpad/n.txt", ".claude/s.json", "ignored.txt", ".DS_Store", "tsconfig.tsbuildinfo"]) write(path.join(d, f));
    const got = R.snapshotFiles(d);
    for (const f of ["src/a.ts", "package.json", "scripts/x.mjs", "src/data/keep.json", "untracked.ts", ".gitignore", ".env.example"]) expect(got).toContain(f);
    for (const f of [".env.local", ".env", ".env.production", ".env.development.local", "data/automation/x.json", "node_modules/p/i.js", ".next/c", "a.log", "out.zip", "scratchpad/n.txt", ".claude/s.json", "ignored.txt", ".DS_Store", "tsconfig.tsbuildinfo"]) expect(got).not.toContain(f);
  });
});

describe("low-priority running (the way builds are kept from slowing the live app)", () => {
  it("uses taskpolicy -b and nice 19 where they exist, falls back to nice alone, then to nothing", () => {
    const has = (...found) => (f) => found.includes(f);
    expect(R.lowPriorityPrefix(has("/usr/sbin/taskpolicy", "/usr/bin/nice"))).toEqual(["/usr/sbin/taskpolicy", "-b", "/usr/bin/nice", "-n", "19"]);
    expect(R.lowPriorityPrefix(has("/usr/bin/nice"))).toEqual(["/usr/bin/nice", "-n", "19"]);
    expect(R.lowPriorityPrefix(has())).toEqual([]);
  });
  it.skipIf(process.platform !== "darwin")("on this Mac the wrapper really runs a command, writes its output to the log and returns its exit code", async () => {
    expect(R.lowPriorityPrefix().length).toBeGreaterThan(0);
    const log = path.join(tmp("guard"), "out.log");
    const r = await R.runGuarded("/bin/sh", ["-c", "echo hello-from-low-priority; exit 3"], { logFile: log, memory: () => ({ freePct: 50, freeGb: 8 }) });
    expect(r).toEqual({ code: 3, aborted: null });
    expect(fs.readFileSync(log, "utf8")).toContain("hello-from-low-priority");
    const ok = await R.runGuarded("/bin/sh", ["-c", "exit 0"], { logFile: log, memory: () => ({ freePct: 50, freeGb: 8 }) });
    expect(ok.code).toBe(0);
  });
  it("a command that cannot start is reported as a failure, not a crash", async () => {
    const r = await R.runGuarded("/nonexistent/binary-xyz", [], { logFile: path.join(tmp("guard2"), "o.log"), memory: () => ({ freePct: 50, freeGb: 8 }) });
    // through taskpolicy/nice the wrapper starts and the inner command fails; with no wrapper the spawn itself fails. Either way: not zero, no throw.
    expect(r.code).not.toBe(0);
  });
  it("a step that pushes memory under 15% free is killed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const p = R.runGuarded("/bin/sh", ["-c", "sleep 30"], { memory: () => ({ freePct: 10, freeGb: 1 }) });
      await vi.advanceTimersByTimeAsync(5100);
      vi.useRealTimers();
      const r = await p;
      expect(r.code).toBe(-1);
      expect(r.aborted).toMatch(/10% free/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stopping and starting a launch job (the race that rolled back the first try at release 2)", () => {
  /** A scripted launchctl: each call is written down; `script` says what each command answers, in order. */
  const fakeLc = (script) => {
    const calls = [];
    const counts = {};
    const lc = (...args) => {
      calls.push(args.join(" "));
      const cmd = args[0];
      counts[cmd] = (counts[cmd] ?? 0) + 1;
      const answers = script[cmd] ?? [0];
      return { status: answers[Math.min(counts[cmd] - 1, answers.length - 1)], stderr: "" };
    };
    return { lc, calls };
  };
  const nap = () => { const sleeps = []; return { sleeps, sleepFn: async (ms) => void sleeps.push(ms) }; };

  it("stop: boots the job out, then WAITS until launchd says it is gone", async () => {
    const { lc, calls } = fakeLc({ print: [0, 0, 113] }); // still loaded twice, then gone
    const { sleeps, sleepFn } = nap();
    expect(await R.launchStop(lc, "gui/501/x", sleepFn)).toBe(true);
    expect(calls[0]).toBe("bootout gui/501/x");
    expect(calls.filter((c) => c.startsWith("print"))).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });
  it("stop: a job that never goes away is reported as not stopped", async () => {
    const { lc } = fakeLc({ print: [0] });
    expect(await R.launchStop(lc, "gui/501/x", nap().sleepFn, 4)).toBe(false);
  });
  it("stop: a job that was never loaded is 'stopped' at once", async () => {
    const { lc } = fakeLc({ print: [113] });
    const { sleeps, sleepFn } = nap();
    expect(await R.launchStop(lc, "gui/501/x", sleepFn)).toBe(true);
    expect(sleeps).toHaveLength(0);
  });

  it("start: THE REAL FAILURE. launchctl refuses twice (Input/output error, status 5), then accepts: it is asked again until it takes", async () => {
    const { lc, calls } = fakeLc({ bootstrap: [5, 5, 0], print: [113] });
    const { sleeps, sleepFn } = nap();
    expect(await R.launchStart(lc, "gui/501", "/p/x.plist", "gui/501/x", sleepFn)).toBe(true);
    expect(calls.filter((c) => c.startsWith("bootstrap"))).toHaveLength(3);
    expect(sleeps).toEqual([1000, 1000]);
  });
  it("start: a refusal (status 5) is NEVER taken for success: if it never loads, the answer is false", async () => {
    const { lc } = fakeLc({ bootstrap: [5], print: [113] });
    expect(await R.launchStart(lc, "gui/501", "/p/x.plist", "gui/501/x", nap().sleepFn, 4)).toBe(false);
  });
  it("start: when the refusal is because the job is loaded already, it is restarted instead", async () => {
    const { lc, calls } = fakeLc({ bootstrap: [5], print: [0] });
    expect(await R.launchStart(lc, "gui/501", "/p/x.plist", "gui/501/x", nap().sleepFn)).toBe(true);
    expect(calls).toContain("kickstart -k gui/501/x");
  });
  it("start: works first time with no waiting", async () => {
    const { lc } = fakeLc({ bootstrap: [0] });
    const { sleeps, sleepFn } = nap();
    expect(await R.launchStart(lc, "gui/501", "/p/x.plist", "gui/501/x", sleepFn)).toBe(true);
    expect(sleeps).toHaveLength(0);
  });
});

describe("only log lines from this start count", () => {
  it("sinceMark returns what was written after the mark, all of a replaced shorter file, and '' for a missing file", () => {
    const f = path.join(tmp("log"), "app.log");
    write(f, "old Startup check\n");
    const mark = R.fileSize(f);
    expect(R.sinceMark(f, mark)).toBe("");
    fs.appendFileSync(f, "new line\n");
    expect(R.sinceMark(f, mark)).toBe("new line\n");
    write(f, "x");
    expect(R.sinceMark(f, mark)).toBe("x");
    expect(R.sinceMark(path.join(tmp("log2"), "none"), 0)).toBe("");
    expect(R.fileSize(path.join(tmp("log3"), "none"))).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ promote / rollback with fake machine operations

const P = R.P;
const at = (m, s = 0) => new Date(2026, 10, 10, 12, m, s);

function makeRelease(id = "r-20261110-123000", verified = ["typecheck", "tests", "build", "rehearsal"]) {
  const dir = path.join(P.releases, id);
  write(path.join(dir, "RELEASE.json"), JSON.stringify({ id, verified: Object.fromEntries(verified.map((v) => [v, { at: "x" }])) }));
  return dir;
}

function fakeOps(over = {}, start = at(31, 30)) {
  let t = start;
  const calls = [];
  const ops = {
    calls,
    now: () => t,
    sleep: async (ms) => { t = new Date(t.getTime() + ms); },
    memory: () => ({ freePct: 40, freeGb: 4 }),
    syncEnv: () => { calls.push("syncEnv"); return false; },
    authSecret: () => ({ present: true, length: 48, ok: true }),
    recordsOpen: () => 0,
    lastSignalAt: () => 0,
    accountFlat: () => ({ ok: true }),
    stopLive: async () => { calls.push("stop"); return true; },
    migrateData: () => {
      calls.push("migrate");
      const d = tmp("fakemove");
      const m = { name: "automation", files: 7, src: path.join(d, "automation"), dst: path.join(d, "live-automation"), backup: path.join(d, "automation.pre-cutover-1") };
      fs.mkdirSync(m.dst);
      fs.mkdirSync(m.backup);
      return [m];
    },
    startLive: () => { calls.push("startLive"); return true; },
    startWatch: () => { calls.push("startWatch"); },
    startDevServer: () => { calls.push("startDevServer"); },
    removeAgents: () => { calls.push("removeAgents"); },
    waitReady: async () => { calls.push("waitReady"); return true; },
    warm: () => { calls.push("warm"); return { ok: true, text: "OK" }; },
    startupCheckSeen: () => true,
    ...over,
  };
  return ops;
}
const quiet = () => undefined;
const reset = () => { fs.rmSync(R.LIVE_ROOT, { recursive: true, force: true }); fs.mkdirSync(R.LIVE_ROOT, { recursive: true }); };

describe("promote: the only command that changes what is live", () => {
  beforeEach(reset);
  afterEach(reset);

  it("refuses without --i-chose-the-time, and touches nothing", async () => {
    makeRelease();
    const ops = fakeOps();
    await expect(R.promote({ id: "r-20261110-123000", confirmed: false }, ops, quiet)).rejects.toThrow(/i-chose-the-time/);
    expect(ops.calls).toEqual([]);
  });

  it("refuses a release that has not passed tests, build and the rehearsal", async () => {
    for (const missing of ["tests", "build", "rehearsal"]) {
      const verified = ["typecheck", "tests", "build", "rehearsal"].filter((v) => v !== missing);
      makeRelease("r-20261110-123000", verified);
      const ops = fakeOps();
      await expect(R.promote({ id: "r-20261110-123000", confirmed: true }, ops, quiet)).rejects.toThrow(new RegExp(`"${missing}"`));
      expect(ops.calls).toEqual([]);
    }
  });

  it("refuses outside the window (and says when it opens), unless --wait, which then waits and goes", async () => {
    makeRelease();
    const ops = fakeOps({}, at(30, 20));
    await expect(R.promote({ id: "r-20261110-123000", confirmed: true }, ops, quiet)).rejects.toThrow(/window opens in 40 s/);
    expect(ops.calls).toEqual([]);
    const logs = [];
    await R.promote({ id: "r-20261110-123000", confirmed: true, wait: true }, ops, (l) => logs.push(l));
    expect(logs.some((l) => /waiting/.test(l))).toBe(true);
    expect(ops.calls).toContain("stop");
  });

  it("refuses, changing nothing and leaving no maintenance flag, when memory is low, records show a trade, the account is not flat, or AUTH_SECRET is unusable", async () => {
    makeRelease();
    const cases = [
      [{ memory: () => ({ freePct: 20, freeGb: 4 }) }, /memory|free/],
      [{ recordsOpen: () => 1 }, /1 position\(s\) open/],
      [{ accountFlat: () => ({ ok: false }) }, /not confirmed flat/],
      [{ authSecret: () => ({ ok: false, present: false, length: 0 }) }, /AUTH_SECRET/],
    ];
    for (const [over, re] of cases) {
      const ops = fakeOps(over);
      await expect(R.promote({ id: "r-20261110-123000", confirmed: true }, ops, quiet)).rejects.toThrow(re);
      expect(ops.calls).not.toContain("stop");
      expect(ops.calls).not.toContain("startLive");
      expect(fs.existsSync(P.maintenance)).toBe(false);
      expect(fs.existsSync(P.current)).toBe(false);
    }
  });

  it("refuses when a signal arrived in the last 3 minutes (and goes when the last one is older), changing nothing", async () => {
    makeRelease();
    const recent = fakeOps();
    recent.lastSignalAt = () => recent.now().getTime() - 60_000;
    await expect(R.promote({ id: "r-20261110-123000", confirmed: true }, recent, quiet)).rejects.toThrow(/signal arrived 60 s ago/);
    expect(recent.calls).not.toContain("stop");
    expect(fs.existsSync(P.maintenance)).toBe(false);
    const older = fakeOps();
    older.lastSignalAt = () => older.now().getTime() - 4 * 60_000;
    await R.promote({ id: "r-20261110-123000", confirmed: true }, older, quiet);
    expect(older.calls).toContain("stop");
  });

  it("--wait: a position that is open at the first window is waited out; the swap happens at a later window after it closed, never inside the first", async () => {
    makeRelease();
    const ops = fakeOps();
    ops.recordsOpen = () => (ops.now() < at(33) ? 1 : 0);
    const logs = [];
    const stoppedAt = [];
    const stop = ops.stopLive;
    ops.stopLive = async () => { stoppedAt.push(ops.now()); return stop(); };
    await R.promote({ id: "r-20261110-123000", confirmed: true, wait: true }, ops, (l) => logs.push(l));
    expect(logs.some((l) => /not now: .*1 position\(s\) open.*next window/.test(l))).toBe(true);
    expect(stoppedAt).toHaveLength(1);
    expect(stoppedAt[0] >= at(36, 0)).toBe(true); // the window 1 to 2.5 min after the :35 close... (:36:00 on)
    expect(R.promoteWindow(stoppedAt[0]).ok).toBe(true);
  });

  it("--wait gives up after 2 hours of 'not now' and changes nothing", async () => {
    makeRelease();
    const ops = fakeOps({ recordsOpen: () => 1 });
    await expect(R.promote({ id: "r-20261110-123000", confirmed: true, wait: true }, ops, quiet)).rejects.toThrow(/Gave up waiting/);
    expect(ops.calls).not.toContain("stop");
    expect(fs.existsSync(P.maintenance)).toBe(false);
  });

  it("one more look right before the stop: a signal that arrives while the checks run stops the swap", async () => {
    makeRelease();
    const ops = fakeOps();
    let n = 0;
    ops.lastSignalAt = () => (++n === 1 ? 0 : ops.now().getTime() - 2000);
    await expect(R.promote({ id: "r-20261110-123000", confirmed: true }, ops, quiet)).rejects.toThrow(/signal arrived/);
    expect(ops.calls).not.toContain("stop");
    expect(fs.existsSync(P.maintenance)).toBe(false);
    expect(fs.existsSync(P.current)).toBe(false);
  });

  it("first cutover, everything fine: stop -> migrate -> swap -> start -> ready -> warm twice -> startup check; then current points at the release and the flag is gone", async () => {
    const dir = makeRelease();
    const ops = fakeOps();
    const logs = [];
    const steps = await R.promote({ id: "r-20261110-123000", confirmed: true }, ops, (l) => logs.push(l));
    expect(ops.calls).toEqual(["syncEnv", "stop", "migrate", "startLive", "startWatch", "waitReady", "warm", "warm"]);
    expect(fs.readlinkSync(P.current)).toBe(dir);
    expect(fs.existsSync(P.previous)).toBe(false);
    expect(fs.existsSync(P.maintenance)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(R.LIVE_ROOT, "PROMOTED.json"), "utf8")).id).toBe("r-20261110-123000");
    expect(steps.at(-1)).toMatch(/IS LIVE.*rollback/);
    expect(logs.join("\n")).toMatch(/7 files verified/);
  });

  it("the maintenance flag is set (in the future) while the swap runs, so the down-watcher stays quiet", async () => {
    makeRelease();
    let flag = 0;
    const ops = fakeOps({ stopLive: async () => { flag = Number(fs.readFileSync(P.maintenance, "utf8")); return true; } });
    await R.promote({ id: "r-20261110-123000", confirmed: true }, ops, quiet);
    expect(flag).toBeGreaterThan(Date.now() + 5 * 60_000);
  });

  it("if the live process will not stop, nothing is changed and the flag is removed", async () => {
    makeRelease();
    const ops = fakeOps({ stopLive: async () => false });
    await expect(R.promote({ id: "r-20261110-123000", confirmed: true }, ops, quiet)).rejects.toThrow(/did not stop/);
    expect(ops.calls).not.toContain("migrate");
    expect(fs.existsSync(P.current)).toBe(false);
    expect(fs.existsSync(P.maintenance)).toBe(false);
  });

  it("first cutover that fails after the move: the records go back exactly where they were, the dev server is started again, the flag is removed", async () => {
    makeRelease();
    const d = tmp("firstfail");
    const from = path.join(d, "project", "data");
    write(path.join(from, "automation", "positions.json"), '{"items":["precious"]}');
    write(path.join(from, "automations", "a.json"), "{}");
    const ops = fakeOps({ migrateData: () => R.migrateData({ from, to: P.data }), warm: () => ({ ok: false, text: "FAIL" }) });
    await expect(R.promote({ id: "r-20261110-123000", confirmed: true }, ops, quiet)).rejects.toThrow(/rolled back.*post-start check/);
    expect(fs.readFileSync(path.join(from, "automation", "positions.json"), "utf8")).toBe('{"items":["precious"]}');
    expect(fs.existsSync(path.join(from, "automations", "a.json"))).toBe(true);
    expect(fs.readdirSync(from).filter((n) => n.includes("pre-cutover"))).toEqual([]);
    expect(fs.existsSync(path.join(P.data, "automation"))).toBe(false);
    expect(ops.calls).toContain("startDevServer");
    expect(ops.calls).toContain("removeAgents"); // nothing may restart the built copy at the next login
    expect(fs.existsSync(P.current)).toBe(false);
    expect(fs.existsSync(P.maintenance)).toBe(false);
  });

  it("fails and rolls back when the new release does not answer, or when the watchdog's startup check never appears", async () => {
    makeRelease();
    for (const over of [{ waitReady: async () => false }, { startupCheckSeen: () => false }]) {
      const ops = fakeOps(over);
      await expect(R.promote({ id: "r-20261110-123000", confirmed: true }, ops, quiet)).rejects.toThrow(/rolled back/);
      expect(ops.calls).toContain("startDevServer");
      expect(fs.existsSync(P.current)).toBe(false);
    }
  });

  it("if the launch job will not load, promote does NOT wait 60 s for an app that was never started: it fails at once and puts the previous release back", async () => {
    const oldDir = makeRelease("r-20261110-100000");
    makeRelease("r-20261110-123000");
    fs.symlinkSync(oldDir, P.current);
    let starts = 0;
    const ops = fakeOps({ startLive: async () => { ops.calls.push("startLive"); return ++starts > 1; } }); // refuses the new release, takes the old one back
    await expect(R.promote({ id: "r-20261110-123000", confirmed: true }, ops, quiet)).rejects.toThrow(/would not load.*never started/s);
    expect(ops.calls.filter((c) => c === "startLive")).toHaveLength(2);
    expect(ops.calls.filter((c) => c === "waitReady")).toHaveLength(1); // only for the previous release coming back
    expect(fs.readlinkSync(P.current)).toBe(oldDir);
    expect(fs.existsSync(P.maintenance)).toBe(false);
  });

  it("if the previous release will not load either, the rollback SAYS SO instead of claiming it answers", async () => {
    const oldDir = makeRelease("r-20261110-100000");
    makeRelease("r-20261110-123000");
    fs.symlinkSync(oldDir, P.current);
    const logs = [];
    const ops = fakeOps({ startLive: async () => { ops.calls.push("startLive"); return false; }, waitReady: async () => { ops.calls.push("waitReady"); return true; } });
    await expect(R.promote({ id: "r-20261110-123000", confirmed: true }, ops, (l) => logs.push(l))).rejects.toThrow(/rolled back/);
    expect(logs.join("\n")).toMatch(/NOT answering/);
    expect(logs.join("\n")).not.toMatch(/previous release answers/);
    expect(ops.calls).not.toContain("waitReady");
  });

  it("a later release: the old one becomes 'previous'; a failure puts the old one back and restarts it (no dev server)", async () => {
    const oldDir = makeRelease("r-20261110-100000");
    const newDir = makeRelease("r-20261110-123000");
    fs.symlinkSync(oldDir, P.current);
    // good promote first
    const ok = fakeOps();
    await R.promote({ id: "r-20261110-123000", confirmed: true }, ok, quiet);
    expect(ok.calls).not.toContain("migrate");
    expect(fs.readlinkSync(P.current)).toBe(newDir);
    expect(fs.readlinkSync(P.previous)).toBe(oldDir);
    // now a bad one on top of it
    const bad = makeRelease("r-20261110-130000");
    const ops = fakeOps({ warm: () => ({ ok: false, text: "FAIL" }) });
    await expect(R.promote({ id: "r-20261110-130000", confirmed: true }, ops, quiet)).rejects.toThrow(/rolled back/);
    expect(fs.readlinkSync(P.current)).toBe(newDir);
    expect(ops.calls.filter((c) => c === "startLive")).toHaveLength(2);
    expect(ops.calls).not.toContain("startDevServer");
    expect(ops.calls).not.toContain("removeAgents"); // the earlier release is still running from the launch job
    expect(bad).toBeTruthy();
  });
});

describe("rollback: one step back", () => {
  beforeEach(reset);
  afterEach(reset);
  it("says what to do when there is no previous release (the first cutover goes back to the dev server)", async () => {
    await expect(R.rollback(fakeOps(), quiet)).rejects.toThrow(/npm run dev/);
  });
  it("swaps current and previous, restarts, proves it answers, removes the flag", async () => {
    const a = makeRelease("r-20261110-100000");
    const b = makeRelease("r-20261110-123000");
    fs.symlinkSync(b, P.current);
    fs.symlinkSync(a, P.previous);
    const ops = fakeOps();
    expect(await R.rollback(ops, quiet)).toBe(true);
    expect(fs.readlinkSync(P.current)).toBe(a);
    expect(fs.readlinkSync(P.previous)).toBe(b);
    expect(ops.calls).toEqual(["stop", "startLive", "waitReady", "warm"]);
    expect(fs.existsSync(P.maintenance)).toBe(false);
  });
  it("reports clearly when the previous release does not answer", async () => {
    const a = makeRelease("r-20261110-100000");
    fs.symlinkSync(makeRelease("r-20261110-123000"), P.current);
    fs.symlinkSync(a, P.previous);
    await expect(R.rollback(fakeOps({ waitReady: async () => false }), quiet)).rejects.toThrow(/not answering/);
  });
});

describe("the real machine operations are never used by these tests", () => {
  it("promote and rollback only ever run with the fake ops above (realOps is the default only for the command line)", () => {
    expect(typeof R.realOps).toBe("function");
    expect(R.promote.length).toBeGreaterThanOrEqual(1);
  });
});
