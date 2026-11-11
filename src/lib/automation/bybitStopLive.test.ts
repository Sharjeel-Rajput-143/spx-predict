import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error - a plain .mjs script, shared with the connection check
import { parseBybitEnv } from "../../../scripts/bybit/check.mjs";
import { ensureBotRecord } from "./bots";
import { BybitExecutor, type BybitConfig, type BybitFetch } from "./bybitExecutor";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { recordHarnessOutcome } from "./ledger";
import { positionsStore } from "./store";
import { BTC_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import type { OpenSpreadRequest } from "./types";

/**
 * THE STOP LOSS FAILURE TESTS, on the Bybit DEMO account (https://api-demo.bybit.com). Skipped unless asked for:
 *
 *   BYBIT_LIVE=1    npx vitest run src/lib/automation/bybitStopLive.test.ts      the real demo account
 *   BYBIT_LIVE=fake npx vitest run src/lib/automation/bybitStopLive.test.ts      the very same scenarios on the in-memory fake (how the harness itself is tested)
 *
 * It reads BYBIT_DEMO_API_KEY and BYBIT_DEMO_API_SECRET from the environment or .env.local (only those two, as bybitLive.test.ts does). It refuses to start unless the
 * account is flat, trades only the minimum size (0.001 BTC, about $76), ends every scenario flat whatever happened, and writes the exact START and END time of each
 * scenario into the report. NOBODY and NOTHING else may trade this demo account while it runs (the bot must be switched off, no TradingView alert may fire): the stop-loss
 * watchdog treats any position as its business, which is the point, and a second trader would be a false failure.
 *
 * What cannot be tested on the demo account, and is tested on the fake only: a partial fill (a 0.001 BTC market order fills whole). Scenario 7 runs that proof on the fake
 * exchange as part of this run, on the same code, so it is recorded against the same code hash.
 *
 * THE LEDGER. In a real run (BYBIT_LIVE=1) every scenario 1 to 7 writes its result, pass or fail, to the live gate's ledger (ledger.ts), stamped with the hash of the stop-safety
 * code it ran against. It is written by this file from the outcome of the test, never typed. Say where the ledger is with BYBIT_LEDGER_DIR (the live folder, for the built
 * copy: ~/spx-live/data/live), or BYBIT_LEDGER_DIR=none to run without recording. Run it from the release folder (cd ~/spx-live/current) so the hash is that release's.
 * The fake run (BYBIT_LIVE=fake) never writes to a ledger.
 */

const MODE = process.env.BYBIT_LIVE === "fake" ? "fake" : process.env.BYBIT_LIVE === "1" ? "live" : "off";
const REPORT = path.join(os.tmpdir(), "bybit-stop-live-report.txt");
const LEDGER_DIR = (process.env.BYBIT_LEDGER_DIR ?? "").trim();
const RECORDING = MODE === "live" && LEDGER_DIR !== "" && LEDGER_DIR.toLowerCase() !== "none";

function keysFromEnv(): { key: string; secret: string } | null {
  if (MODE === "fake") return { key: API_KEY, secret: API_SECRET };
  let file: Record<string, string> = {};
  try {
    file = parseBybitEnv(fs.readFileSync(path.resolve(__dirname, "../../../.env.local"), "utf8"));
  } catch {
    /* no file */
  }
  const key = process.env.BYBIT_DEMO_API_KEY || file.BYBIT_DEMO_API_KEY || "";
  const secret = process.env.BYBIT_DEMO_API_SECRET || file.BYBIT_DEMO_API_SECRET || "";
  return key && secret ? { key, secret } : null;
}

const lines: string[] = [];
const say = (l: string) => {
  lines.push(l);
  console.log(l);
};

describe.skipIf(MODE === "off")(`the stop loss failure tests (${MODE})`, () => {
  const keys = keysFromEnv();
  let fake: FakeBybit;
  let alarms: string[] = [];
  let funded = true;
  const sleepReal = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const cfgFor = (over: Partial<BybitConfig> = {}): BybitConfig => ({ apiKey: keys!.key, apiSecret: keys!.secret, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 100, breakevenTriggerPercent: 0, breakevenLockPercent: 0.12, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000, ...over });
  const make = (fetchImpl?: BybitFetch): BybitExecutor => {
    const ex = new BybitExecutor(cfgFor(), fetchImpl, (l) => say(`    [bot log] ${l}`));
    if (MODE === "fake") ex.sleep = async () => {};
    ex.onAlarm = (a) => {
      alarms.push(`${a.kind}: ${a.text}`);
      say(`    [ALARM ${a.kind}] ${a.text}`);
    };
    return ex;
  };
  /** The real fetch (or the fake's, when stubbed), possibly wrapped. */
  const plainFetch: BybitFetch = (url, init) => fetch(url, init);
  let executor: BybitExecutor;
  let n = 0;
  const req = (): OpenSpreadRequest => ({ botId: BTC_BOT_ID, underlying: "BTC", positionType: "short_put_spread", shortStrike: 29_000, longStrike: 28_990, quantity: 1, limitCredit: 3.5, expiry: "2026-10-06", clientOrderId: `stoplive-${Date.now()}-${++n}` });
  const held = () => executor.getAccountPosition();
  const showHeld = async (title: string) => {
    const h = await held();
    say(`    ${title}: ${h.side ? `${h.side} ${h.size} at ${h.avgPrice}, stop loss ${h.stopLoss ?? "NONE"}, take profit ${h.takeProfit ?? "NONE"}, mode ${h.tpslMode ?? "?"}` : "flat"}`);
    return h;
  };
  /** Takes the stop loss off the position the way a person at Bybit would (a stop loss of 0 cancels it). */
  const deleteStopByHand = async () => {
    await (executor as unknown as { call: (m: string, p: string, params: Record<string, unknown>, o: { auth: boolean }) => Promise<unknown> }).call("POST", "/v5/position/trading-stop", { category: "linear", symbol: "BTCUSDT", tpslMode: "Full", positionIdx: 0, stopLoss: "0" }, { auth: true });
  };
  /** START / END of a scenario, exactly. */
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

  beforeAll(() => {
    if (MODE === "live" && LEDGER_DIR === "") throw new Error("Say where the ledger is: BYBIT_LEDGER_DIR=<the live folder, for example ~/spx-live/data/live>, or BYBIT_LEDGER_DIR=none to run without recording the results.");
    if (!keys) throw new Error("No Bybit demo key: put BYBIT_DEMO_API_KEY and BYBIT_DEMO_API_SECRET in .env.local (or the environment).");
    if (MODE === "fake") {
      fake = new FakeBybit();
      fake.clock = () => Date.now();
      vi.stubGlobal("fetch", (url: string, init: Parameters<FakeBybit["fetch"]>[1]) => fake.fetch(String(url), init));
    }
    say(`Bybit stop loss failure tests (${MODE === "fake" ? "FAKE: harness self-test" : "DEMO account"}), started ${new Date().toISOString()}`);
  });
  beforeEach((ctx) => {
    // The result of scenarios 1 to 6 is written to the ledger from the test's own outcome, in a real run only.
    ctx.onTestFinished(() => {
      if (!RECORDING) return;
      const n = recordHarnessOutcome(ctx.task.name, ctx.task.result?.state, { source: "demo", dir: LEDGER_DIR });
      if (n) say(`    [ledger] scenario ${n} ${ctx.task.result?.state === "pass" ? "PASSED" : "FAILED"}: recorded`);
    });
    resetAutomationStores();
    setNdxTestEnv();
    ensureBotRecord(BTC_BOT_ID);
    executor = make();
  });
  const flatten = async () => {
    // Whatever a scenario did: the account must end flat. A reduce-only market close, sent until the account is flat.
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
    say(`\nFinished ${new Date().toISOString()}. Report saved to ${REPORT}`);
    try {
      fs.writeFileSync(REPORT, lines.join("\n") + "\n");
    } catch {
      /* the console has it */
    }
    vi.unstubAllGlobals();
  });

  it("0. connects and the account is flat to begin with", async () => {
    const c = await executor.checkConnection();
    const h = await held();
    say(`connected to the DEMO account; equity ${c.totalEquity}; holds: ${h.side ?? "nothing"}`);
    funded = (c.totalEquity ?? 0) > 0;
    expect(c.demo).toBe(true);
    expect(funded, "the demo account has no funds").toBe(true);
    expect(h.side, "the demo account must be flat before the test").toBeNull();
  }, 60_000);

  it("1. does Bybit remove the stop when the position closes?", async (ctx) => {
    if (!funded) return ctx.skip("no funds");
    await window("1. Stop removed on close: open at minimum size, read the stop, close reduce-only, read again", async () => {
      await executor.placeOpenOrder(req());
      const open = await showHeld("after the entry");
      expect(open.stopLoss).not.toBeNull();
      const orders = await executor.workingStopOrders();
      say(`    working stop orders while the position is open: ${orders.length} ${JSON.stringify(orders)}`);
      await (executor as unknown as { sendReduceOnly: (s: "Buy" | "Sell", n: number) => Promise<string | null> }).sendReduceOnly(open.side!, open.size);
      await sleepReal(MODE === "fake" ? 1 : 2000);
      const after = await showHeld("after the close");
      const left = await executor.workingStopOrders();
      say(`    working stop orders after the close: ${left.length} ${JSON.stringify(left)}`);
      say(`    ANSWER: ${after.side === null && left.length === 0 ? "YES - Bybit removed the stop with the position; nothing is left behind." : "NO - something was left behind (see above)."}`);
      expect(after.side).toBeNull();
      expect(left).toHaveLength(0);
    });
  }, 120_000);

  it("2. stop deleted by hand at Bybit: the watchdog notices, raises the alarm, repairs it once", async (ctx) => {
    if (!funded) return ctx.skip("no funds");
    await window("2. Stop deleted by hand", async () => {
      await executor.placeOpenOrder(req());
      await showHeld("after the entry");
      await deleteStopByHand();
      const gone = await showHeld("after the stop was deleted by hand (this is the unprotected moment)");
      expect(gone.stopLoss).toBeNull();
      const step = await executor.watchdogStep();
      say(`    watchdog: ${step.state}`);
      const fixed = await showHeld("after the watchdog");
      expect(step.state).toBe("repaired");
      expect(fixed.stopLoss).not.toBeNull();
      expect(alarms.map((a) => a.split(":")[0])).toEqual(["stop_problem", "resolved"]);
    });
  }, 120_000);

  it("3. stop deleted and the repair refused: the watchdog closes the position with reduce-only orders until flat", async (ctx) => {
    if (!funded) return ctx.skip("no funds");
    await window("3. Stop deleted and the repair call fails", async () => {
      await executor.placeOpenOrder(req());
      const refuseRepair: BybitFetch = async (url, init) => (init.method === "POST" && url.includes("/v5/position/trading-stop") ? { ok: true, status: 200, text: async () => JSON.stringify({ retCode: 34036, retMsg: "test: trading stop refused", result: {} }) } : plainFetch(url, init));
      const broken = make(refuseRepair);
      await deleteStopByHand();
      await showHeld("after the stop was deleted by hand");
      const step = await broken.watchdogStep();
      say(`    watchdog: ${step.state}`);
      const after = await showHeld("after the watchdog");
      expect(step.state).toBe("closed");
      expect(after.side).toBeNull();
    });
  }, 180_000);

  it("4. the network is cut right after the entry: the account ends flat or protected, never unprotected", async (ctx) => {
    if (!funded) return ctx.skip("no funds");
    await window("4. Network cut after the entry (the next 25 calls fail like a cut line)", async () => {
      let cutLeft = 0;
      const cutting: BybitFetch = async (url, init) => {
        if (cutLeft > 0) {
          cutLeft--;
          throw new TypeError("fetch failed", { cause: Object.assign(new Error("test: network cut"), { code: "ECONNRESET" }) });
        }
        const res = await plainFetch(url, init);
        if (init.method === "POST" && url.endsWith("/v5/order/create") && JSON.parse(init.body ?? "{}").reduceOnly !== true) cutLeft = 25;
        return res;
      };
      const ex = make(cutting);
      executor = ex;
      const started = Date.now();
      // Cut for longer than the 5 second check: the stop cannot be confirmed, so the rule is a reduce-only close as soon as one gets through. Either way the account must
      // never be left holding a position without a stop: it ends flat, or protected.
      const outcome = await ex.placeOpenOrder(req()).then(
        () => "the entry stood (stop confirmed once Bybit answered)",
        (e: Error) => `the entry ended: ${e.message.slice(0, 160)}`,
      );
      say(`    after ${((Date.now() - started) / 1000).toFixed(1)} s: ${outcome}`);
      const h = await showHeld("final state");
      expect(h.side === null || h.stopLoss !== null).toBe(true);
    });
  }, 180_000);

  it("5. a flip while the stop is pending: the old side closes reduce-only, the new side opens with its own stop", async (ctx) => {
    if (!funded) return ctx.skip("no funds");
    await window("5. Flip: bullish signal, then bearish signal", async () => {
      const fast = { closeConfirmTimeoutMs: 60_000, orderFillTimeoutMs: 60_000, pollIntervalMs: MODE === "fake" ? 5 : 1000, ladderStepMs: 20 };
      let skew = 0;
      const run = (direction: "bullish" | "bearish") => {
        skew += 5 * 60_000;
        const signal = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: direction, price: 29_284.55 + ++n * 0.35, barTime: `stop-live-${n}`, interval: "5", raw: { symbol: "BTC" }, now: Date.now() + skew });
        return processSignal(signal, { executor, now: Date.now(), ...fast });
      };
      await run("bullish");
      const long = await showHeld("after the bullish signal");
      expect(long).toMatchObject({ side: "Buy" });
      expect(long.stopLoss).not.toBeNull();
      await run("bearish");
      const short = await showHeld("after the bearish signal");
      expect(short).toMatchObject({ side: "Sell" });
      expect(short.stopLoss).not.toBeNull();
      expect(short.stopLoss!).toBeGreaterThan(short.avgPrice!);
      say(`    positions on record: ${positionsStore.all().filter((p) => p.botId === BTC_BOT_ID).map((p) => `${p.type}:${p.status}`).join(", ")}`);
    });
  }, 300_000);

  it("6. a restart with a position open: a fresh watchdog does the startup check and repairs a stop that went missing meanwhile", async (ctx) => {
    if (!funded) return ctx.skip("no funds");
    await window("6. Restart with a position open", async () => {
      await executor.placeOpenOrder(req());
      await showHeld("before the 'restart'");
      await deleteStopByHand(); // nobody was watching while the app was down
      const restarted = make(); // a new executor: no memory of anything
      const step = await restarted.watchdogStep();
      say(`    startup check: ${step.state} (startup: ${step.startup})`);
      const after = await showHeld("after the startup check");
      expect(step).toMatchObject({ state: "repaired", startup: true });
      expect(after.stopLoss).not.toBeNull();
    });
  }, 120_000);

  it("7. a partial fill: not testable on the demo account (a 0.001 BTC market order fills whole), so it is proven on the FAKE exchange, here, on this code", async (ctx) => {
    ctx.onTestFinished(() => {
      if (!RECORDING) return;
      const n = recordHarnessOutcome(ctx.task.name, ctx.task.result?.state, { source: "fake", dir: LEDGER_DIR });
      if (n) say(`    [ledger] scenario ${n} (fake exchange) ${ctx.task.result?.state === "pass" ? "PASSED" : "FAILED"}: recorded`);
    });
    await window("7. Partial fill (on the fake exchange: the demo account cannot do it)", async () => {
      const f = new FakeBybit();
      f.fillFraction = 0.5;
      const logs7: string[] = [];
      const ex = new BybitExecutor({ ...cfgFor(), apiKey: API_KEY, apiSecret: API_SECRET }, f.fetch, (l) => logs7.push(l));
      ex.sleep = async () => {};
      await ex.placeOpenOrder(req());
      say(`    the fake exchange filled half: it holds ${f.position.size}, stop loss ${f.position.stopLoss}`);
      expect(f.position.size).toBeCloseTo(0.0005, 10);
      expect(f.position.stopLoss).toBeGreaterThan(0);
      expect(logs7.join("\n")).toMatch(/partial fill: .* its stop loss covers all of it \(Full mode\)/);
      expect(f.created.filter((c) => c.params.reduceOnly === true)).toHaveLength(0);
      // and a missing stop on a partial fill is repaired in Full mode, for all of what is held
      const g = new FakeBybit();
      g.fillFraction = 0.5;
      g.dropStops = true;
      const ex2 = new BybitExecutor({ ...cfgFor(), apiKey: API_KEY, apiSecret: API_SECRET }, g.fetch, () => undefined);
      ex2.sleep = async () => {};
      await ex2.placeOpenOrder({ ...req(), clientOrderId: "p7b" });
      expect(g.of("/v5/position/trading-stop", "POST")[0].params).toMatchObject({ tpslMode: "Full" });
      expect(g.position.stopLoss).toBeGreaterThan(0);
    });
  });
});
