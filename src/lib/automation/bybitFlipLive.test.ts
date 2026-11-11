import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { botsStore, decisionsStore, ordersStore, positionsStore } from "./store";
import { ensureBotRecord } from "./bots";
import { BybitExecutor, type BybitConfig, type BybitFetch } from "./bybitExecutor";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { appendEvent, ledgerSweep, readLedger } from "./ledger";
import { BTC_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";

/**
 * THE FLIP CHECK, on the Bybit DEMO account (https://api-demo.bybit.com). Skipped unless asked for:
 *
 *   BYBIT_LIVE=1    npx vitest run src/lib/automation/bybitFlipLive.test.ts      the real demo account
 *   BYBIT_LIVE=fake npx vitest run src/lib/automation/bybitFlipLive.test.ts      the very same steps on the in-memory fake (how the check itself is tested)
 *
 * What it proves, with the real engine (processSignal) and the real BybitExecutor, at the minimum size (0.001 BTC, about $76):
 *   F1 a bullish signal opens a long that has a stop loss and a take profit at Bybit;
 *   F2 a bearish signal FLIPS it: the long is closed reduce-only (position record closed, reason signal_flip), the short opens with its OWN stop loss above its entry,
 *      and while this happens a sampler reads the account every 300 ms and must never see a position without a stop loss;
 *   F3 a bullish signal flips it back (the other direction);
 *   F4 a second bullish signal while long opens nothing more (the size does not grow, no new position record);
 *   F5 with the bot switched OFF a bearish signal closes the long and opens nothing (close only).
 * It reads BYBIT_DEMO_API_KEY and BYBIT_DEMO_API_SECRET (environment, or the .env.local file). From the file it takes ONLY those two lines (see demoKeysFromText): every other line,
 * the live key's included, is skipped without being parsed, kept or printed.
 *   F7 at the end: the demo account is flat (two reads, 3 seconds apart).
 *
 * THE LEDGER GOES TO A TEMPORARY FOLDER, never to the live gate's. The test makes its own folder under the system temp folder, points the ledger at it (also through
 * LIVE_DATA_DIR, so any default-folder write lands there too), refuses to start if that folder is anywhere under ~/spx-live, and at the end checks the live ledger file
 * (if there is one) is byte-for-byte what it was at the start. So these test trades can never change the live gate's clean-trade count.
 *
 * NOBODY and NOTHING else may trade this demo account while it runs (the bot app stopped or the TradingView alerts paused): the stop-loss watchdog treats any position as
 * its business, and a second trader would be a false failure. It refuses to start unless the account is flat, and ends flat whatever happened.
 * It does not touch bybitExecutor.ts, bybitWatchdog.ts or bybitRisk.ts, so it does not make the six failure test results stale.
 */

const MODE = process.env.BYBIT_LIVE === "fake" ? "fake" : process.env.BYBIT_LIVE === "1" ? "live" : "off";
const REPORT = path.join(os.tmpdir(), "bybit-flip-live-report.txt");
const LIVE_ROOT = path.join(os.homedir(), "spx-live");
const LIVE_LEDGER = path.join(LIVE_ROOT, "data", "live", "ledger.jsonl");

/** The sampler's verdict: how many samples held a position without a stop loss. Pure, so it can be tested on its own. */
export function judgeSamples(samples: { side: string | null; stopLoss: number | null }[]): { total: number; unprotected: number } {
  return { total: samples.length, unprotected: samples.filter((s) => s.side !== null && (s.stopLoss === null || !(s.stopLoss > 0))).length };
}

/** A folder is safe for this test's ledger only if it is outside the live folder and inside the system temp folder. */
export function isSafeTempLedgerDir(dir: string, liveRoot: string = LIVE_ROOT, tmp: string = os.tmpdir()): boolean {
  const d = path.resolve(dir);
  const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
  return !within(d, path.resolve(liveRoot)) && (within(d, path.resolve(tmp)) || within(d, fs.realpathSync.native(tmp)));
}

const fileDigest = (p: string): string | null => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
};

/**
 * The two demo key values out of the text of an env file, and NOTHING else. A line is looked at only if it starts with one of the two exact names; any other line (BYBIT_LIVE_* included)
 * is skipped by a test on its name alone, so its value is never extracted, kept or printed.
 */
export function demoKeysFromText(text: string): { key: string; secret: string } {
  const out = { key: "", secret: "" };
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(BYBIT_DEMO_API_KEY|BYBIT_DEMO_API_SECRET)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (m[1] === "BYBIT_DEMO_API_KEY") out.key = v;
    else out.secret = v;
  }
  return out;
}

function keysFromEnv(): { key: string; secret: string } | null {
  if (MODE === "fake") return { key: API_KEY, secret: API_SECRET };
  let file = { key: "", secret: "" };
  try {
    file = demoKeysFromText(fs.readFileSync(path.resolve(__dirname, "../../../.env.local"), "utf8"));
  } catch {
    /* no file */
  }
  const key = process.env.BYBIT_DEMO_API_KEY || file.key;
  const secret = process.env.BYBIT_DEMO_API_SECRET || file.secret;
  return key && secret ? { key, secret } : null;
}

const lines: string[] = [];
const say = (l: string) => {
  lines.push(l);
  console.log(l);
};

describe("the flip check's own helpers", () => {
  it("demoKeysFromText takes the two demo lines and nothing else: a live key line is never extracted, whatever its place or spelling", () => {
    const text = [
      "AUTH_SECRET=not-a-key-1",
      "BYBIT_LIVE_API_KEY=LIVEKEY-must-never-come-out",
      "BYBIT_DEMO_API_KEY=demo-key-1",
      "export BYBIT_LIVE_API_SECRET='LIVESECRET-must-never-come-out'",
      'BYBIT_DEMO_API_SECRET="demo-secret-1"  ',
      "BYBIT_API_KEY=old-name-must-not-count",
      "BYBIT_DEMO_API_KEY_EXTRA=nope",
      "  # BYBIT_DEMO_API_KEY=commented-out",
    ].join("\n");
    const got = demoKeysFromText(text);
    expect(got).toEqual({ key: "demo-key-1", secret: "demo-secret-1" });
    expect(JSON.stringify(got)).not.toMatch(/LIVE|must-never|old-name|nope|commented/);
    // only the two names exist in the result, so nothing else can be kept or printed
    expect(Object.keys(got).sort()).toEqual(["key", "secret"]);
    expect(demoKeysFromText("BYBIT_LIVE_API_KEY=x\nBYBIT_LIVE_API_SECRET=y")).toEqual({ key: "", secret: "" });
    expect(demoKeysFromText("BYBIT_DEMO_API_KEY=abc # a comment")).toEqual({ key: "abc", secret: "" });
  });
  it("the flip check's source never calls the broad parser, and never names a live key variable except in this test's own words", () => {
    const src = fs.readFileSync(__filename, "utf8");
    expect(src).not.toMatch(new RegExp(["parse", "BybitEnv"].join("") + "|scripts/bybit/" + "check"));
    expect(src).not.toMatch(/process\.env\.BYBIT_LIVE_API/);
  });
  it("judgeSamples counts a position without a stop loss, and only that", () => {
    expect(judgeSamples([{ side: null, stopLoss: null }, { side: "Buy", stopLoss: 75240 }, { side: "Sell", stopLoss: 76760 }])).toEqual({ total: 3, unprotected: 0 });
    expect(judgeSamples([{ side: "Buy", stopLoss: null }, { side: "Sell", stopLoss: 0 }, { side: "Buy", stopLoss: 75240 }])).toEqual({ total: 3, unprotected: 2 });
    expect(judgeSamples([])).toEqual({ total: 0, unprotected: 0 });
  });
  it("the ledger folder must be under the system temp folder and never under the live folder", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flipcheck-helper-"));
    try {
      expect(isSafeTempLedgerDir(tmp)).toBe(true);
      expect(isSafeTempLedgerDir(path.join(LIVE_ROOT, "data", "live"))).toBe(false);
      expect(isSafeTempLedgerDir(LIVE_ROOT)).toBe(false);
      expect(isSafeTempLedgerDir(path.join(os.homedir(), "somewhere-else"))).toBe(false);
      expect(isSafeTempLedgerDir(path.join(tmp, "..", ".."))).toBe(false);
      // a "temp" folder that is really inside the live folder is refused
      expect(isSafeTempLedgerDir(path.join(LIVE_ROOT, "tmp"), LIVE_ROOT, LIVE_ROOT)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(MODE === "off")(`the flip check (${MODE})`, () => {
  const keys = keysFromEnv();
  let fake: FakeBybit;
  let ledgerDir = "";
  let liveLedgerBefore: string | null = null;
  let savedLiveDataDir: string | undefined;
  let alarms: string[] = [];
  let funded = true;
  let executor: BybitExecutor;
  let n = 0;
  let skew = 0;
  const sleepReal = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const cfgFor = (over: Partial<BybitConfig> = {}): BybitConfig => ({ apiKey: keys!.key, apiSecret: keys!.secret, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 100, breakevenTriggerPercent: 0, breakevenLockPercent: 0.12, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000, ...over });
  const make = (fetchImpl?: BybitFetch): BybitExecutor => {
    const ex = new BybitExecutor(cfgFor(), fetchImpl, (l) => say(`    [bot log] ${l}`));
    if (MODE === "fake") ex.sleep = async () => {};
    ex.onAlarm = (a) => {
      alarms.push(`${a.kind}: ${a.text}`);
      say(`    [ALARM ${a.kind}] ${a.text}`);
      if (a.kind !== "resolved") appendEvent("unprotected", { kind: a.kind, text: a.text.slice(0, 300) }, Date.now(), ledgerDir);
    };
    // The entry's confirmed stop goes to the TEMPORARY ledger, never to the live one.
    ex.onEntryProtected = (e) => {
      appendEvent("entry_protected", { ...e }, e.confirmedAt, ledgerDir);
    };
    return ex;
  };
  const held = () => executor.getAccountPosition();
  const showHeld = async (title: string) => {
    const h = await held();
    say(`    ${title}: ${h.side ? `${h.side} ${h.size} at ${h.avgPrice}, stop loss ${h.stopLoss ?? "NONE"}, take profit ${h.takeProfit ?? "NONE"}` : "flat"}`);
    return h;
  };
  async function window<T>(title: string, body: () => Promise<T>): Promise<T> {
    alarms = [];
    const start = new Date();
    say(`\n=== ${title} ===\n  START ${start.toISOString()}`);
    try {
      return await body();
    } finally {
      const end = new Date();
      say(`  END   ${end.toISOString()}  (${((end.getTime() - start.getTime()) / 1000).toFixed(1)} s)`);
    }
  }
  /** Reads the account every 300 ms (5 ms on the fake) until stopped, and keeps what it saw. */
  function sampler() {
    const seen: { side: string | null; stopLoss: number | null }[] = [];
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        const h = await held().catch(() => null);
        if (h) seen.push({ side: h.side, stopLoss: h.stopLoss });
        await sleepReal(MODE === "fake" ? 5 : 300);
      }
    })();
    return {
      async finish() {
        stop = true;
        await loop;
        return judgeSamples(seen);
      },
    };
  }
  const fast = () => ({ closeConfirmTimeoutMs: 60_000, orderFillTimeoutMs: 60_000, pollIntervalMs: MODE === "fake" ? 5 : 1000, ladderStepMs: 20 });
  const run = (direction: "bullish" | "bearish") => {
    skew += 5 * 60_000;
    const signal = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: direction, price: 29_284.55 + ++n * 0.35, barTime: `flip-live-${n}`, interval: "5", raw: { symbol: "BTC" }, now: Date.now() + skew });
    return processSignal(signal, { executor, now: Date.now(), ...fast() });
  };
  const btcPositions = () => positionsStore.all().filter((p) => p.botId === BTC_BOT_ID);
  const describePositions = () => btcPositions().map((p) => `${p.type}:${p.status}${p.closeReason ? `(${p.closeReason})` : ""}`).join(", ");
  const entriesInLedger = () => readLedger(ledgerDir).events.filter((e) => e.kind === "entry_protected");

  beforeAll(() => {
    if (!keys) throw new Error("No Bybit demo key: put BYBIT_DEMO_API_KEY and BYBIT_DEMO_API_SECRET in .env.local (or the environment).");
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipcheck-ledger-"));
    if (!isSafeTempLedgerDir(ledgerDir)) throw new Error(`The ledger folder ${ledgerDir} is not a safe temporary folder; the flip check will not run.`);
    savedLiveDataDir = process.env.LIVE_DATA_DIR;
    process.env.LIVE_DATA_DIR = ledgerDir; // any default-folder ledger write in this process lands in the temporary folder too
    liveLedgerBefore = fileDigest(LIVE_LEDGER);
    if (MODE === "fake") {
      fake = new FakeBybit();
      fake.clock = () => Date.now();
      vi.stubGlobal("fetch", (url: string, init: Parameters<FakeBybit["fetch"]>[1]) => fake.fetch(String(url), init));
    }
    say(`Bybit flip check (${MODE === "fake" ? "FAKE: self-test" : "DEMO account"}), started ${new Date().toISOString()}`);
    say(`ledger for this run (temporary): ${ledgerDir}`);
  });
  beforeEach((ctx) => {
    // F6 reads what F1-F5 left behind (the positions on record), so it must not start from empty stores.
    if (!ctx.task.name.startsWith("F6")) {
      resetAutomationStores();
      setNdxTestEnv();
      ensureBotRecord(BTC_BOT_ID);
    }
    executor = make();
  });
  const flatten = async () => {
    const ex = make();
    for (let i = 0; i < 8; i++) {
      const h = await ex.getAccountPosition().catch(() => null);
      if (h && h.side === null) return;
      if (h?.side) {
        await (ex as unknown as { sendReduceOnly: (s: "Buy" | "Sell", n: number) => Promise<string | null> }).sendReduceOnly(h.side, h.size);
        say(`    (clean-up: closing ${h.side} ${h.size})`);
      }
      await sleepReal(MODE === "fake" ? 1 : 1000);
    }
  };
  afterEach(async () => {
    await flatten();
  });
  afterAll(async () => {
    const liveLedgerAfter = fileDigest(LIVE_LEDGER);
    say(`\nlive ledger file: ${liveLedgerBefore === liveLedgerAfter ? "UNCHANGED (byte for byte)" : "CHANGED !!!"}`);
    say(`Finished ${new Date().toISOString()}. Report saved to ${REPORT}`);
    try {
      fs.writeFileSync(REPORT, lines.join("\n") + "\n");
    } catch {
      /* the console has it */
    }
    if (savedLiveDataDir === undefined) delete process.env.LIVE_DATA_DIR;
    else process.env.LIVE_DATA_DIR = savedLiveDataDir;
    vi.unstubAllGlobals();
    // the temporary ledger is kept for the report; it is in the system temp folder, not in any release or data folder
  });

  it("F0. connects, the account is flat, and the ledger is a temporary folder", async () => {
    const c = await executor.checkConnection();
    const h = await held();
    say(`connected to the DEMO account; equity ${c.totalEquity}; holds: ${h.side ?? "nothing"}`);
    funded = (c.totalEquity ?? 0) > 0;
    expect(c.demo).toBe(true);
    expect(funded, "the demo account has no funds").toBe(true);
    expect(h.side, "the demo account must be flat before the check").toBeNull();
    expect(isSafeTempLedgerDir(ledgerDir)).toBe(true);
    expect(process.env.LIVE_DATA_DIR).toBe(ledgerDir);
  }, 60_000);

  it("F1-F5. open long, flip to short, flip back, a repeat opens nothing, bot off closes only", async (ctx) => {
    if (!funded) return ctx.skip("no funds");
    const watch = sampler();
    let verdict = { total: 0, unprotected: 0 };
    try {
      await window("F1. Bullish signal opens a long with its stop", async () => {
        await run("bullish");
        const long = await showHeld("after the bullish signal");
        expect(long).toMatchObject({ side: "Buy", size: 0.001 });
        expect(long.stopLoss, "the long must have a stop loss").not.toBeNull();
        expect(long.stopLoss!).toBeLessThan(long.avgPrice!);
        expect(long.takeProfit!).toBeGreaterThan(long.avgPrice!);
        expect(btcPositions().filter((p) => p.status === "open")).toHaveLength(1);
        expect(entriesInLedger()).toHaveLength(1);
      });

      await window("F2. Bearish signal flips it: long closes reduce-only, short opens with its own stop", async () => {
        const before = btcPositions().find((p) => p.status === "open")!;
        await run("bearish");
        const short = await showHeld("after the bearish signal");
        expect(short).toMatchObject({ side: "Sell", size: 0.001 });
        expect(short.stopLoss, "the short must have its own stop loss").not.toBeNull();
        expect(short.stopLoss!).toBeGreaterThan(short.avgPrice!);
        expect(short.takeProfit!).toBeLessThan(short.avgPrice!);
        say(`    positions on record: ${describePositions()}`);
        const old = positionsStore.get(before.id)!;
        expect(old.status).toBe("closed");
        expect(old.closeReason).toBe("signal_flip");
        const closes = ordersStore.query((o) => o.positionId === before.id && o.kind === "close");
        expect(closes.length, "the long was closed by exactly one close order").toBe(1);
        expect(closes[0].ref ?? "").toMatch(/^bybit-close-/);
        expect(btcPositions().filter((p) => p.status === "open")).toHaveLength(1);
        expect(entriesInLedger()).toHaveLength(2);
      });

      await window("F3. Bullish signal flips it back: short closes, long opens with its own stop", async () => {
        const before = btcPositions().find((p) => p.status === "open")!;
        await run("bullish");
        const long = await showHeld("after the second bullish signal");
        expect(long).toMatchObject({ side: "Buy", size: 0.001 });
        expect(long.stopLoss!).toBeLessThan(long.avgPrice!);
        expect(positionsStore.get(before.id)).toMatchObject({ status: "closed", closeReason: "signal_flip" });
        expect(btcPositions().filter((p) => p.status === "open")).toHaveLength(1);
        expect(entriesInLedger()).toHaveLength(3);
      });

      await window("F4. A second bullish signal while long opens nothing more", async () => {
        const recordsBefore = btcPositions().length;
        await run("bullish");
        const still = await showHeld("after the repeated bullish signal");
        const outcomes = decisionsStore.all().slice(-3).map((d) => d.outcome).join(", ");
        say(`    last decisions: ${outcomes}`);
        expect(still).toMatchObject({ side: "Buy", size: 0.001 });
        expect(btcPositions()).toHaveLength(recordsBefore);
        expect(entriesInLedger()).toHaveLength(3);
      });

      await window("F5. Bot OFF, bearish signal: the long closes and nothing opens", async () => {
        botsStore.update(BTC_BOT_ID, { enabled: false });
        await run("bearish");
        const after = await showHeld("after the bearish signal with the bot off");
        say(`    positions on record: ${describePositions()}`);
        expect(after.side, "the account must be flat: close only").toBeNull();
        expect(btcPositions().filter((p) => p.status === "open" || p.status === "closing")).toHaveLength(0);
        expect(entriesInLedger()).toHaveLength(3);
      });
    } finally {
      verdict = await watch.finish();
    }
    say(`\nsampler: ${verdict.total} reads of the account during F1-F5, ${verdict.unprotected} saw a position without a stop loss`);
    expect(verdict.total).toBeGreaterThan(0);
    expect(verdict.unprotected, "a position without a stop loss was seen").toBe(0);
  }, 600_000);

  it("F6. the temporary ledger: every entry protected, nothing unprotected, the trades would be counted, the live ledger untouched", async (ctx) => {
    if (!funded) return ctx.skip("no funds");
    const { events, damaged } = readLedger(ledgerDir);
    expect(damaged).toBeFalsy();
    const kinds = events.reduce<Record<string, number>>((a, e) => ({ ...a, [e.kind]: (a[e.kind] ?? 0) + 1 }), {});
    say(`    temporary ledger events: ${JSON.stringify(kinds)}`);
    expect(kinds.entry_protected).toBe(3);
    expect(kinds.unprotected ?? 0).toBe(0);
    // Would the live gate count these trades? Run the very same judge, on the temporary ledger.
    const judged = ledgerSweep(Date.now());
    const after = readLedger(ledgerDir).events;
    const counted = after.filter((e) => e.kind === "trade_counted").length;
    const excluded = after.filter((e) => e.kind === "trade_excluded");
    say(`    the gate's judge on these trades: ${judged} judged, ${counted} would be counted, ${excluded.length} excluded${excluded.length ? ` (${excluded.map((e) => String(e.data.why)).join("; ")})` : ""}`);
    expect(excluded).toHaveLength(0);
    expect(counted).toBe(3);
    // nothing reached the live ledger
    expect(fileDigest(LIVE_LEDGER)).toBe(liveLedgerBefore);
  }, 60_000);

  it("F7. the demo account is flat at the end: two reads, 3 seconds apart", async (ctx) => {
    if (!funded) return ctx.skip("no funds");
    const first = await held();
    await sleepReal(MODE === "fake" ? 50 : 3000);
    const second = await held();
    say(`    final reads: ${first.side ? `${first.side} ${first.size}` : "FLAT"}, then ${second.side ? `${second.side} ${second.size}` : "FLAT"}`);
    expect(first.side, "the demo account still holds a position at the end").toBeNull();
    expect(second.side, "the demo account still holds a position 3 seconds later").toBeNull();
  }, 60_000);
});
