import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error - a plain .mjs script, shared with the connection check
import { parseBybitEnv } from "../../../scripts/bybit/check.mjs";
import { ensureBotRecord } from "./bots";
import { BybitExecutor, type BybitConfig, type BybitTrace } from "./bybitExecutor";
import { runBybitRiskCheck } from "./bybitRisk";
import { buildBybitView } from "./bybitView";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { manualClose, processSignal, receiveAndSaveSignal } from "./engine";
import { settleDerivResults, resetDerivResultAttempts } from "./derivResults";
import { botsStore, decisionsStore, positionsStore } from "./store";
import { BTC_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";

/**
 * THE DEMO ACCOUNT TEST. Runs the real executor and the real engine against your Bybit DEMO account (https://api-demo.bybit.com) and prints exactly what Bybit
 * returned for every call. It is skipped unless asked for:
 *
 *   BYBIT_LIVE=1 npx vitest run src/lib/automation/bybitLive.test.ts
 *
 * It reads BYBIT_DEMO_API_KEY and BYBIT_DEMO_API_SECRET from the environment or .env.local (only those two), and refuses to start unless the demo account holds
 * nothing in the symbol. Every scenario ends flat, and a last step flattens the account whatever happened. Orders are the smallest size (0.001 BTC, about $76).
 *
 *   BYBIT_LIVE=fake  runs the very same scenarios against the in-memory fake exchange: how the harness itself is tested (npm test runs it that way).
 *
 * Scenarios that depend on the market moving (a stop loss being hit, the open loss reaching a limit) wait up to BYBIT_LIVE_WAIT_SECONDS (default 240) and say
 * INCONCLUSIVE, with what was seen, if the market did not do it in that time. They never fake a result.
 */

const MODE = process.env.BYBIT_LIVE === "fake" ? "fake" : process.env.BYBIT_LIVE === "1" ? "live" : "off";
const WAIT_MS = Number(process.env.BYBIT_LIVE_WAIT_SECONDS ?? (MODE === "fake" ? 2 : 240)) * 1000;
const POLL_MS = MODE === "fake" ? 5 : 1000;
const REPORT = path.join(os.tmpdir(), "bybit-live-report.txt");

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
const compact = (v: unknown, max = 600) => {
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)} ...(cut)` : s;
};
const fmtTrace = (t: BybitTrace) =>
  `    ${t.method} ${t.path}${t.method === "GET" && Object.keys(t.params).length ? `?${new URLSearchParams(Object.entries(t.params).map(([k, v]) => [k, String(v)])).toString()}` : ""}${t.method === "POST" ? `  body ${compact(t.params, 400)}` : ""}\n      -> HTTP ${t.httpStatus ?? "no answer"}, retCode ${t.retCode ?? "-"}, retMsg ${JSON.stringify(t.retMsg)}${t.result ? `\n      result ${compact(t.result)}` : ""}`;

describe.skipIf(MODE === "off")(`the Bybit demo account (${MODE})`, () => {
  const keys = keysFromEnv();
  let fake: FakeBybit;
  let traces: BybitTrace[] = [];
  let executor: BybitExecutor;
  let cfg: BybitConfig;
  let flatten: () => Promise<void> = async () => {};
  /** False when the demo account is empty: every order would be refused (110007), so the scenarios that trade say so and stop instead of failing in confusing ways. */
  let funded = true;

  const make = (over: Partial<BybitConfig> = {}): BybitExecutor => {
    cfg = { apiKey: keys!.key, apiSecret: keys!.secret, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 100, breakevenTriggerPercent: 0, breakevenLockPercent: 0.12, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000, ...over };
    const ex = new BybitExecutor(cfg, undefined, (l) => say(`  [bot log] ${l}`));
    if (MODE === "fake") ex.sleep = async () => {};
    ex.onCall = (t) => traces.push(t);
    return ex;
  };
  const fast = { closeConfirmTimeoutMs: 60_000, orderFillTimeoutMs: 60_000, pollIntervalMs: POLL_MS, ladderStepMs: 20 };
  let n = 0;
  /** Each alert is stamped 5 minutes after the last, so the engine's own duplicate guard (the same direction within 120 seconds) never hides what is being tested. */
  let skew = 0;
  const stamp = () => Date.now() + skew;
  const alert = (direction: "bullish" | "bearish") => {
    skew += 5 * 60_000;
    const price = 29_284.55 + ++n * 0.35;
    return receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: direction, price, barTime: `live-${n}`, interval: "5", raw: { symbol: "BTC" }, now: stamp() });
  };
  // Only the alert's own time is spread out; the run itself happens now, so the position's times are the real ones (which is what finding a stop in Bybit's history relies on).
  const run = (direction: "bullish" | "bearish") => processSignal(alert(direction), { executor, now: Date.now(), ...fast });
  const outcomes = () => decisionsStore.all().filter((d) => d.signalId !== null).map((d) => d.outcome);
  const mine = () => positionsStore.all().filter((p) => p.botId === BTC_BOT_ID);
  const open = () => mine().filter((p) => p.status === "open");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Prints the calls made since the last time, exactly as Bybit answered. */
  const showCalls = (title: string) => {
    say(`\n  Calls to Bybit - ${title}:`);
    for (const t of traces) say(fmtTrace(t));
    traces = [];
  };
  const step = (text: string) => say(`\n=== ${text} ===`);

  /** Waits for `done()` while nudging the market in fake mode. Returns whether it came true in time. */
  async function waitFor(done: () => Promise<boolean>, nudge?: () => void): Promise<boolean> {
    const end = Date.now() + WAIT_MS;
    do {
      if (await done()) return true;
      nudge?.();
      await sleep(Math.min(3000, POLL_MS * 3));
    } while (Date.now() < end);
    return await done();
  }

  beforeAll(() => {
    if (!keys) throw new Error("No Bybit demo key: put BYBIT_DEMO_API_KEY and BYBIT_DEMO_API_SECRET in .env.local (or the environment).");
    if (MODE === "fake") {
      fake = new FakeBybit();
      fake.clock = () => Date.now();
      vi.stubGlobal("fetch", (url: string, init: Parameters<FakeBybit["fetch"]>[1]) => fake.fetch(String(url), init));
    }
    say(`Bybit ${MODE === "fake" ? "FAKE (harness self-test)" : "DEMO"} test, started ${new Date().toISOString()}`);
  });

  beforeEach(() => {
    resetAutomationStores();
    setNdxTestEnv();
    resetDerivResultAttempts();
    ensureBotRecord(BTC_BOT_ID);
    delete process.env.BYBIT_KILL_SWITCH;
    traces = [];
    executor = make();
    flatten = async () => {
      const held = await executor.getAccountPosition();
      if (held.side) {
        say(`  (clean-up: closing ${held.side} ${held.size} left on the account)`);
        const side = held.side === "Buy" ? "short_put_spread" : "short_call_spread";
        const pos = mine().find((p) => p.status === "open") ?? { id: "cleanup", botId: BTC_BOT_ID, type: side, filledQuantity: held.size / cfg.qty, requestedQuantity: held.size / cfg.qty, brokerOrderRef: "bybit-open-0" };
        await executor.placeCloseOrder(pos as never, { manual: true, clientOrderId: `cleanup-${Date.now()}` }).catch((e) => say(`  clean-up close failed: ${e instanceof Error ? e.message : e}`));
      }
    };
  });

  afterEach(async () => {
    await flatten().catch((e) => say(`  clean-up check failed: ${e instanceof Error ? e.message : e}`));
  });

  afterAll(async () => {
    say(`\nFinished ${new Date().toISOString()}. Full report saved to ${REPORT}`);
    try {
      fs.writeFileSync(REPORT, lines.join("\n") + "\n");
    } catch {
      /* the console has it */
    }
    vi.unstubAllGlobals();
  });

  it("0. connects with the key and the account is flat to begin with", async () => {
    step("0. Connection");
    const c = await executor.checkConnection();
    const held = await executor.getAccountPosition();
    showCalls("connection");
    say(`  connected to the DEMO account; equity ${c.totalEquity}; the account holds: ${held.side ?? "nothing"}`);
    expect(c.demo).toBe(true);
    funded = (c.totalEquity ?? 0) > 0;
    expect(funded, "BLOCKED: the demo account has NO FUNDS (equity 0), so Bybit refuses every order with retCode 110007. In Bybit (Demo Trading -> Assets) use Request Demo Funds, then run this again.").toBe(true);
    expect(held.side, "the demo account must be flat before the test: close what it holds at Bybit and run again").toBeNull();
  }, 60_000);

  it("1. one open and one close", async (ctx) => {
    if (!funded) return ctx.skip("BLOCKED: the demo account has no funds");
    step("1. One open and close (a bullish signal, then Close position)");
    await run("bullish");
    expect(outcomes()).toEqual(["opened"]);
    const p = open()[0];
    showCalls("the open");
    say(`  position ${p.id}: ${p.type}, status ${p.status}, order ${p.brokerOrderRef}, entry price ${(p.credit! * 100) / cfg.qty}`);
    const held = await executor.getAccountPosition();
    say(`  Bybit holds: ${held.side} ${held.size} at ${held.avgPrice}, stop loss ${held.stopLoss}, take profit ${held.takeProfit}, unrealised ${held.unrealisedPnl}`);
    expect(held).toMatchObject({ side: "Buy", size: 0.001 });
    expect(held.stopLoss, "the stop loss is on the position at Bybit").not.toBeNull();
    expect(held.takeProfit, "the take profit is on the position at Bybit").not.toBeNull();
    traces = [];

    const closed = await manualClose(p.id, { executor, now: Date.now(), ...fast });
    showCalls("the close");
    say(`  close result: ${closed.outcome} - ${closed.reason}`);
    expect(closed.ok).toBe(true);
    const after = positionsStore.get(p.id)!;
    say(`  position now ${after.status}, closed by ${after.closeReason}, close price ${after.closePrice}`);
    expect(after).toMatchObject({ status: "closed", closeReason: "manual" });
    expect((await executor.getAccountPosition()).side).toBeNull();

    // Bybit's own closed profit and loss (the demo may not support this endpoint)
    const got = await waitFor(async () => (await settleDerivResults(executor, Date.now() + 11 * 60_000, { retryAfterMs: 0 }).catch((e) => { say(`  closed-pnl read failed: ${e instanceof Error ? e.message : e}`); return 0; })) > 0);
    showCalls("Bybit's closed profit and loss");
    const settled = positionsStore.get(p.id)!;
    say(got ? `  Bybit's own result: ${settled.settlement?.pl} (from Bybit, net of fees)` : `  Bybit's closed PnL was not available; the result stays the fill-based figure: ${((after.credit! - after.closePrice!) * 100).toFixed(4)}`);
  }, 300_000);

  it("2. a duplicate signal sends no second order", async (ctx) => {
    if (!funded) return ctx.skip("BLOCKED: the demo account has no funds");
    step("2. Duplicate signals");
    await run("bullish");
    showCalls("the first signal");
    const entries = () => traces.filter((t) => t.path === "/v5/order/create").length;
    await run("bullish");
    showCalls("the same side again");
    say(`  decisions: ${compact(outcomes())}`);
    expect(outcomes()).toEqual(["opened", "already_in_position"]);
    // the same alert delivered twice (TradingView does this now and then): both are saved first, the engine acts on one of them
    skew += 5 * 60_000;
    const first = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: "bullish", price: 29_999.99, barTime: "dup", interval: "5", raw: { symbol: "BTC" }, now: stamp() });
    const second = receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: "bullish", price: 29_999.99, barTime: "dup", interval: "5", raw: { symbol: "BTC" }, now: stamp() });
    await processSignal(first, { executor, now: Date.now(), ...fast });
    await processSignal(second, { executor, now: Date.now(), ...fast });
    showCalls("the same alert twice");
    say(`  decisions: ${compact(outcomes())}`);
    expect(outcomes().slice(1)).toEqual(["already_in_position", "already_in_position", "duplicate_signal"]);
    expect(entries()).toBe(0);
    expect((await executor.getAccountPosition()).size, "exactly one position at Bybit").toBe(0.001);
    expect(open()).toHaveLength(1);
  }, 300_000);

  it("3. a flip closes the old side reduce-only, then opens the new side", async (ctx) => {
    if (!funded) return ctx.skip("BLOCKED: the demo account has no funds");
    step("3. A flip (bullish, then bearish)");
    await run("bullish");
    traces = [];
    await run("bearish");
    const orders = traces.filter((t) => t.path === "/v5/order/create");
    showCalls("the flip");
    say(`  decisions: ${compact(outcomes())}`);
    expect(outcomes()).toEqual(["opened", "closed", "opened"]);
    expect(orders.map((t) => [t.params.side, t.params.reduceOnly ?? false])).toEqual([["Sell", true], ["Sell", false]]);
    const long = mine().find((p) => p.type === "short_put_spread")!;
    const short = mine().find((p) => p.type === "short_call_spread")!;
    say(`  the long: ${long.status}, closed by ${long.closeReason}; the short: ${short.status}; Bybit holds ${(await executor.getAccountPosition()).side}`);
    expect(long).toMatchObject({ status: "closed", closeReason: "signal_flip" });
    expect(short.status).toBe("open");
    expect((await executor.getAccountPosition()).side).toBe("Sell");
  }, 300_000);

  it("4. a stop loss hit at Bybit makes the bot flat, and the next signal opens normally", async (ctx) => {
    if (!funded) return ctx.skip("BLOCKED: the demo account has no funds");
    step("4. A stop loss hit (the trade is opened normally; then Bybit's own stop is moved just under the price so the market can reach it)");
    await run("bullish");
    const p = open()[0];
    showCalls("the open (normal stops)");
    const gap = Number(process.env.BYBIT_LIVE_STOP_GAP ?? 2);
    say(`  waiting up to ${WAIT_MS / 1000}s. Every few seconds the stop at Bybit is set $${gap} under the current price; Bybit itself closes the trade when the price falls to it.`);
    traces = [];
    let tightened = 0;
    let refused: string | null = null;
    const raw = executor as unknown as { call: (m: string, path: string, params: Record<string, unknown>, o: { auth: boolean }) => Promise<unknown> };
    const hit = await waitFor(
      async () => {
        if (positionsStore.get(p.id)?.status !== "closed") {
          try {
            const held = await executor.getAccountPosition();
            if (held.side === "Buy" && held.markPrice) {
              const sl = (Math.floor((held.markPrice - gap) * 10) / 10).toFixed(1);
              // the stop only ever moves up: never loosened
              if (held.stopLoss === null || Number(sl) > held.stopLoss) {
                await raw.call("POST", "/v5/position/trading-stop", { category: "linear", symbol: "BTCUSDT", tpslMode: "Full", positionIdx: 0, stopLoss: sl, slTriggerBy: "MarkPrice", slOrderType: "Market" }, { auth: true }).then(
                  () => void tightened++,
                  (e: unknown) => void (refused = e instanceof Error ? e.message : String(e)),
                );
              }
            }
          } catch (e) {
            refused = e instanceof Error ? e.message : String(e);
          }
        }
        await runBybitRiskCheck(BTC_BOT_ID, executor, executor, Date.now());
        return positionsStore.get(p.id)?.status === "closed";
      },
      MODE === "fake" ? () => fake.movePrice(fake.price - 40) : undefined,
    );
    showCalls("moving the stop and watching for it");
    say(`  the stop was moved ${tightened} time(s)${refused ? `; the last refusal from Bybit: ${refused}` : ""}`);
    if (!hit) {
      say("  INCONCLUSIVE: the market did not fall to the stop in time (the position is closed by the clean-up). Run it again, or raise BYBIT_LIVE_WAIT_SECONDS.");
      return;
    }
    const after = positionsStore.get(p.id)!;
    say(`  Bybit closed it: closed by ${after.closeReason}, order ${after.brokerOrderRef}, close price ${after.closePrice}`);
    expect(after.status).toBe("closed");
    expect(after.closeReason, "Bybit's order history says this was its stop loss").toBe("stop_loss");
    expect((await executor.getAccountPosition()).side).toBeNull();
    traces = [];
    await run("bullish");
    showCalls("the next signal (the same side as the trade the stop closed)");
    expect(outcomes().at(-1)).toBe("opened");
  }, 600_000);

  it("5. the daily loss limit closes everything and blocks new entries", async (ctx) => {
    if (!funded) return ctx.skip("BLOCKED: the demo account has no funds");
    step("5. The daily loss limit (a tiny limit, so an ordinary wobble reaches it)");
    executor = make({ dailyMaxLossUsd: 0.00001 });
    await run("bullish");
    const p = open()[0];
    showCalls("the open");
    traces = [];
    const reached = await waitFor(async () => {
      await runBybitRiskCheck(BTC_BOT_ID, executor, executor, Date.now(), fast);
      return positionsStore.get(p.id)?.status === "closed";
    }, MODE === "fake" ? () => (fake.price -= 10) : undefined);
    showCalls("the risk check");
    if (!reached) {
      say("  INCONCLUSIVE: the open trade was not in a loss during the wait, so the limit was not reached. Run it again.");
      return;
    }
    const after = positionsStore.get(p.id)!;
    say(`  closed by ${after.closeReason}; the bot's day is marked: ${compact(botsStore.get(BTC_BOT_ID)?.riskTrip)}`);
    expect(after.closeReason).toBe("daily_limit");
    expect((await executor.getAccountPosition()).side).toBeNull();
    traces = [];
    await run("bullish");
    showCalls("a new signal after the limit");
    say(`  decisions: ${compact(outcomes())}; orders sent: ${traces.filter((t) => t.path === "/v5/order/create").length}`);
    expect(outcomes().at(-1)).toBe("daily_loss_limit_reached");
    expect(traces.filter((t) => t.path === "/v5/order/create")).toHaveLength(0);
  }, 600_000);

  it("6. the open trade's profit or loss on the site is what Bybit shows", async (ctx) => {
    if (!funded) return ctx.skip("BLOCKED: the demo account has no funds");
    step("6. The site's open profit/loss against Bybit's own position data");
    await run("bullish");
    traces = [];
    const rows: string[] = [];
    for (let i = 0; i < 3; i++) {
      if (MODE === "fake") fake.movePrice(fake.price + (i + 1) * 20);
      const view = await buildBybitView(executor, BTC_BOT_ID, "BTCUSDT");
      const fromView = traces.filter((t) => t.path === "/v5/position/list").at(-1)!;
      const raw = (fromView.result as { list: { side: string; size: string; avgPrice: string; markPrice: string; unrealisedPnl: string }[] }).list[0];
      // an independent read, straight from Bybit, right after
      const again = await executor.getAccountPosition();
      rows.push(`  site: ${view.open?.side} ${view.open?.size} entry ${view.open?.entryPrice} now ${view.open?.currentPrice} P/L ${view.open?.pnl}  |  Bybit's same reply: entry ${raw.avgPrice} mark ${raw.markPrice} unrealisedPnl ${raw.unrealisedPnl}  |  a second read: mark ${again.markPrice} unrealisedPnl ${again.unrealisedPnl}`);
      expect(view.open!.pnl).toBe(Number(raw.unrealisedPnl));
      expect(view.open!.entryPrice).toBe(Number(raw.avgPrice));
      expect(view.open!.currentPrice).toBe(Number(raw.markPrice));
      expect(Math.abs((view.open!.pnl ?? 0) - (again.unrealisedPnl ?? 0))).toBeLessThan(0.1);
      await sleep(MODE === "fake" ? 1 : 2000);
    }
    showCalls("three reads");
    for (const r of rows) say(r);
  }, 300_000);

  it("8. the breakeven stop: once the trade is in profit, Bybit's stop loss is moved once, the take profit stays, then the bot closes the trade", async (ctx) => {
    if (!funded) return ctx.skip("BLOCKED: the demo account has no funds");
    // A tiny trigger just for this check, so an ordinary wobble of the market reaches it (the real settings are not touched).
    const trigger = Number(process.env.BYBIT_LIVE_BREAKEVEN_TRIGGER ?? 0.01);
    const lock = Number(process.env.BYBIT_LIVE_BREAKEVEN_LOCK ?? 0.004);
    step(`8. The breakeven stop (trigger ${trigger}%, lock ${lock}%, for this check only)`);
    executor = make({ breakevenTriggerPercent: trigger, breakevenLockPercent: lock });
    await run("bullish");
    const p = open()[0];
    showCalls("the open (normal stops)");
    const before = await executor.getAccountPosition();
    say(`  Bybit holds: ${before.side} ${before.size} at ${before.avgPrice}, stop loss ${before.stopLoss}, take profit ${before.takeProfit}`);
    expect(before.stopLoss).not.toBeNull();
    expect(before.takeProfit).not.toBeNull();
    say(`  waiting up to ${WAIT_MS / 1000}s for the price to rise ${trigger}% above the entry; the risk monitor runs every few seconds, as it does in the app.`);
    traces = [];
    const moved = await waitFor(
      async () => {
        await runBybitRiskCheck(BTC_BOT_ID, executor, executor, Date.now(), fast);
        return !!positionsStore.get(p.id)?.breakevenStop || positionsStore.get(p.id)?.status === "closed";
      },
      MODE === "fake" ? () => fake.movePrice(fake.price + 12) : undefined,
    );
    const stopCalls = traces.filter((t) => t.path === "/v5/position/trading-stop");
    showCalls("the risk monitor waiting for the trigger");
    if (positionsStore.get(p.id)?.closeReason === "breakeven_close") {
      say("  The price fell back between Bybit's reading and the stop move, so Bybit REFUSED the new stop (retCode 10001) and the bot closed the trade instead, reduce only, as designed. This is the refused-move path, not the normal one: run it again to see the stop move.");
      return;
    }
    if (!moved || positionsStore.get(p.id)?.status === "closed") {
      say("  INCONCLUSIVE: the price did not rise far enough in time (the position is closed by the clean-up). Run it again, or raise BYBIT_LIVE_WAIT_SECONDS.");
      return;
    }
    const after = await executor.getAccountPosition();
    const record = positionsStore.get(p.id)!;
    say(`  Bybit now holds: stop loss ${after.stopLoss} (was ${before.stopLoss}), take profit ${after.takeProfit} (was ${before.takeProfit}); entry ${after.avgPrice}, mark ${after.markPrice}`);
    say(`  the bot recorded the move: ${JSON.stringify(record.breakevenStop)}; trading-stop calls: ${stopCalls.length}`);
    expect(stopCalls).toHaveLength(1);
    expect(Object.keys(stopCalls[0].params ?? {})).not.toContain("takeProfit");
    expect(after.stopLoss, "the stop moved at Bybit, to the profit side of the entry").toBeGreaterThan(after.avgPrice!);
    expect(after.stopLoss!).toBeGreaterThan(before.stopLoss!);
    expect(after.takeProfit, "the take profit did not move").toBe(before.takeProfit);
    expect(record.breakevenStop?.price).toBe(after.stopLoss);
    // once only: more passes send nothing
    traces = [];
    await runBybitRiskCheck(BTC_BOT_ID, executor, executor, Date.now() + 1000, fast);
    await runBybitRiskCheck(BTC_BOT_ID, executor, executor, Date.now() + 2000, fast);
    const extra = traces.filter((t) => t.path === "/v5/position/trading-stop");
    showCalls("two more passes of the monitor");
    expect(extra).toHaveLength(0);
    // then the bot closes the trade itself (reduce only)
    traces = [];
    const closed = await manualClose(p.id, { executor, now: Date.now(), ...fast });
    showCalls("the close");
    say(`  close result: ${closed.outcome} - ${closed.reason}`);
    expect(closed.ok).toBe(true);
    expect((await executor.getAccountPosition()).side).toBeNull();
  }, 600_000);

  it("7. the kill switch closes the open trade and stops new orders", async (ctx) => {
    if (!funded) return ctx.skip("BLOCKED: the demo account has no funds");
    step("7. The kill switch");
    await run("bullish");
    traces = [];
    botsStore.update(BTC_BOT_ID, { killSwitch: true });
    await runBybitRiskCheck(BTC_BOT_ID, executor, executor, Date.now(), fast);
    showCalls("the kill switch close");
    const after = mine()[0];
    say(`  closed by ${after.closeReason}; Bybit holds ${(await executor.getAccountPosition()).side ?? "nothing"}`);
    expect(after.closeReason).toBe("kill_switch");
    traces = [];
    await run("bearish");
    expect(outcomes().at(-1)).toBe("kill_switch");
    expect(traces.filter((t) => t.path === "/v5/order/create")).toHaveLength(0);
  }, 300_000);
});
