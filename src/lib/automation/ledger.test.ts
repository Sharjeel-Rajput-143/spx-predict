import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord } from "./bots";
import { BybitExecutor, type BybitConfig } from "./bybitExecutor";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { API_KEY, API_SECRET, FakeBybit } from "./bybitTestSupport";
import { raiseStopAlarm } from "./bybitWatchdog";
import { processSignal, receiveAndSaveSignal } from "./engine";
import { recordHarnessOutcome, GATE_TESTS_NEEDED, GATE_TRADES_NEEDED, PROTECTION_FILES, SCENARIOS, __resetLedger, appendEvent, flushPending, ledgerFile, ledgerSweep, liveGate, pendingWrites, protectionHash, readLedger, recordEntryProtected, recordTestResult, recordUnprotected } from "./ledger";
import { __resetLiveSettings } from "./liveSettings";
import { botsStore, ordersStore, positionsStore } from "./store";
import { BASE_NOW, BTC_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";

// THE LEDGER AND THE GATE NUMBERS. Facts in, numbers out: tests passed out of 7 (on the current code), clean counted trades out of 5, one unprotected moment resets the trades to 0.

setNdxTestEnv();
let root: string;
const makeRoot = (suffix = "") => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "spx-protect-"));
  for (const f of PROTECTION_FILES) {
    fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true });
    fs.writeFileSync(path.join(r, f), `// ${f}\n${suffix}`);
  }
  return r;
};
const T = BASE_NOW;
const pass = (scenario: number, source: "demo" | "fake" = scenario === 7 ? "fake" : "demo", passed = true, at = T) => recordTestResult({ scenario, passed, source }, at, root);
const passAll = () => SCENARIOS.forEach((s) => pass(s.id));
const gate = (now = T + 1000) => liveGate(now, root);

/** A demo trade as the engine leaves it: an open order row with its Bybit reference, and a closed position. */
function trade(id: string, orderId: string, opts: { openedAt: number; closedAt: number | null; status?: "closed" | "open"; botId?: string; venue?: "bybit" | "mock" }) {
  positionsStore.insert({ id, botId: opts.botId ?? BTC_BOT_ID, venue: opts.venue ?? "bybit", status: opts.status ?? "closed", openedAt: opts.openedAt, closedAt: opts.closedAt, type: "short_put_spread", closeReason: "take_profit" } as never);
  ordersStore.insert({ id: `o-${id}`, positionId: id, kind: "open", status: "filled", limitPrice: 0, filledQuantity: 1, ref: `bybit-open-${orderId}`, createdAt: opts.openedAt, updatedAt: opts.openedAt } as never);
}
const protectedEntry = (orderId: string, submittedAt: number) => recordEntryProtected({ orderId, side: "Buy", stopLoss: 75_000, takeProfit: 77_000, submittedAt, confirmedAt: submittedAt + 800 });
/** One whole clean trade, n minutes after T. */
function cleanTrade(n: number) {
  const at = T + n * 60_000;
  protectedEntry(`ord${n}`, at);
  trade(`pos${n}`, `ord${n}`, { openedAt: at + 1000, closedAt: at + 30_000 });
}

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  __resetLiveSettings();
  __resetLedger();
  root = makeRoot();
  vi.stubEnv("PROTECTION_ROOT", root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the ledger file", () => {
  it("is empty and whole to begin with, and lives in the live folder, not the demo records", () => {
    expect(readLedger()).toEqual({ events: [], damaged: null });
    expect(ledgerFile()).toContain("spx-predict-live-test-");
  });
  it("each fact is chained to the one before; the chain reads back whole", () => {
    appendEvent("unprotected", { kind: "stop_problem", text: "a" }, 1);
    appendEvent("unprotected", { kind: "stop_problem", text: "b" }, 2);
    const r = readLedger();
    expect(r.damaged).toBeNull();
    expect(r.events.map((e) => [e.seq, e.t])).toEqual([[1, 1], [2, 2]]);
    expect(r.events[0].prev).toBe("genesis");
    expect(r.events[1].prev).toBe(r.events[0].h);
  });
  it("an edited line, a removed line, a swapped pair and garbage are all noticed", () => {
    for (let i = 1; i <= 4; i++) appendEvent("unprotected", { kind: "stop_problem", text: `t${i}` }, i);
    const original = fs.readFileSync(ledgerFile(), "utf8");
    const lines = original.trim().split("\n");
    const tries: Record<string, string> = {
      edited: [lines[0], lines[1].replace("t2", "t9"), lines[2], lines[3]].join("\n"),
      removed: [lines[0], lines[2], lines[3]].join("\n"),
      swapped: [lines[0], lines[2], lines[1], lines[3]].join("\n"),
      garbage: `${original}not json\n`,
      forgedTail: `${original}${JSON.stringify({ seq: 5, t: 5, kind: "trade_counted", data: {}, prev: "x", h: "y" })}\n`,
    };
    for (const [name, text] of Object.entries(tries)) {
      fs.writeFileSync(ledgerFile(), `${text}\n`);
      expect(readLedger().damaged, name).not.toBeNull();
    }
    fs.writeFileSync(ledgerFile(), original);
    expect(readLedger().damaged).toBeNull();
  });
  it("a write that fails is kept and retried, in order, and the gate is NOT passed while it waits", () => {
    const real = fs.appendFileSync;
    let fail = true;
    vi.spyOn(fs, "appendFileSync").mockImplementation((...a: Parameters<typeof fs.appendFileSync>) => {
      if (fail) throw new Error("disk full");
      return real(...a);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    passAll();
    for (let i = 1; i <= 5; i++) cleanTrade(i);
    expect(pendingWrites()).toBeGreaterThan(0);
    expect(gate().ok).toBe(false);
    expect(gate().ledger).toMatchObject({ ok: false, pending: expect.any(Number) });
    fail = false;
    expect(flushPending()).toBe(true);
    expect(pendingWrites()).toBe(0);
    const seqs = readLedger().events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(readLedger().damaged).toBeNull();
  });
});

describe("the stop-safety code hash", () => {
  it("is the same for the same files and changes when ANY one of them changes", () => {
    const h = protectionHash(root)!;
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(protectionHash(root)).toBe(h);
    for (const f of PROTECTION_FILES) {
      const full = path.join(root, f);
      const was = fs.readFileSync(full, "utf8");
      fs.writeFileSync(full, `${was}\n// changed`);
      expect(protectionHash(root), f).not.toBe(h);
      fs.writeFileSync(full, was);
      expect(protectionHash(root), f).toBe(h);
    }
  });
  it("is null when a file cannot be read (then no test can count)", () => {
    fs.rmSync(path.join(root, PROTECTION_FILES[1]));
    expect(protectionHash(root)).toBeNull();
    pass(2);
    expect(gate().tests.items[1].passed).toBe(false);
    expect(gate().why).toMatch(/could not be read/);
  });
  it("covers the executor, the watchdog and the risk check", () => {
    expect([...PROTECTION_FILES]).toEqual(["src/lib/automation/bybitExecutor.ts", "src/lib/automation/bybitWatchdog.ts", "src/lib/automation/bybitRisk.ts"]);
    for (const f of PROTECTION_FILES) expect(fs.existsSync(path.resolve(__dirname, "../../..", f)), f).toBe(true);
  });
});

describe("failure tests on the real demo account: X of 6, and the partial fill on the fake exchange: yes or no", () => {
  it("starts at 0 of 6 (scenarios 1 to 6) with the partial fill as its own line, not proven", () => {
    const g = gate();
    expect(GATE_TESTS_NEEDED).toBe(6);
    expect(g.tests).toMatchObject({ passed: 0, total: 6 });
    expect(g.tests.items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(g.tests.items.every((i) => i.source === "demo")).toBe(true);
    expect(g.partialFill).toMatchObject({ id: 7, source: "fake", passed: false, stale: false });
    expect(g.ok).toBe(false);
    expect(g.why).toMatch(/failure tests on the real demo account 0 of 6/);
    expect(g.why).toMatch(/partial fill proven on the fake exchange: no/);
  });
  it("counts each scenario that passed on the current code", () => {
    pass(1);
    pass(2);
    expect(gate().tests.passed).toBe(2);
    pass(3);
    expect(gate().tests.passed).toBe(3);
  });
  it("a FAILED run does not count, and a later failure on the same code undoes an earlier pass", () => {
    pass(1, "demo", false);
    expect(gate().tests.passed).toBe(0);
    pass(1);
    expect(gate().tests.passed).toBe(1);
    pass(1, "demo", false, T + 5);
    expect(gate().tests.passed).toBe(0);
    pass(1, "demo", true, T + 10);
    expect(gate().tests.passed).toBe(1);
  });
  it("scenarios 1 to 6 count only from the REAL demo account; the fake exchange cannot pass them", () => {
    for (const id of [1, 2, 3, 4, 5, 6]) pass(id, "fake");
    expect(gate().tests.passed).toBe(0);
    for (const id of [1, 2, 3, 4, 5, 6]) pass(id, "demo");
    expect(gate().tests.passed).toBe(6);
  });
  it("the partial fill cannot be run on the demo account, so it is proven on the fake exchange only: a 'demo' result for it counts for nothing, and it never adds to the X of 6", () => {
    pass(7, "demo");
    expect(gate().partialFill.passed).toBe(false);
    pass(7, "fake");
    expect(gate().partialFill).toMatchObject({ passed: true, source: "fake" });
    expect(gate().tests.passed).toBe(0); // the six real tests are counted on their own
  });
  it("THE GATE NEEDS BOTH: six real tests without the fake partial fill is not enough, and the partial fill without the six is not enough", () => {
    for (const id of [1, 2, 3, 4, 5, 6]) pass(id, "demo");
    for (let i = 1; i <= 5; i++) cleanTrade(i);
    expect(gate(T + 3_600_000)).toMatchObject({ ok: false, tests: { passed: 6 }, partialFill: { passed: false } });
    expect(gate(T + 3_600_000).why).toMatch(/partial fill proven on the fake exchange: no/);
    pass(7, "fake");
    expect(gate(T + 3_600_000).ok).toBe(true);
    __resetLedger();
    pass(7, "fake");
    for (const id of [1, 2, 3, 4, 5]) pass(id, "demo");
    for (let i = 1; i <= 5; i++) cleanTrade(i);
    expect(gate(T + 3_600_000)).toMatchObject({ ok: false, tests: { passed: 5 }, partialFill: { passed: true } });
    expect(gate(T + 3_600_000).why).toMatch(/failure tests on the real demo account 5 of 6/);
  });
  it("a failed partial-fill run on the current code undoes an earlier pass; running it again on the same code passes it again", () => {
    pass(7, "fake");
    expect(gate().partialFill.passed).toBe(true);
    pass(7, "fake", false, T + 5);
    expect(gate().partialFill.passed).toBe(false);
    pass(7, "fake", true, T + 10);
    expect(gate().partialFill.passed).toBe(true);
  });
  it("THE RE-RUN RULE: change any stop-safety file and every earlier pass (the partial fill too) is stale until it is run again on the new code", () => {
    passAll();
    expect(gate().tests.passed).toBe(6);
    expect(gate().partialFill.passed).toBe(true);
    fs.appendFileSync(path.join(root, PROTECTION_FILES[0]), "\n// a change to the executor\n");
    const g = gate();
    expect(g.tests.passed).toBe(0);
    expect(g.tests.items.every((i) => i.stale)).toBe(true);
    expect(g.partialFill).toMatchObject({ passed: false, stale: true });
    expect(g.why).toMatch(/stale: run again/);
    expect(g.why).toMatch(/partial fill proven on the fake exchange: no \(stale: run again on the current code\)/);
    pass(2);
    expect(gate().tests.passed).toBe(1);
    expect(gate().tests.items[1]).toMatchObject({ passed: true, stale: false });
    expect(gate().tests.items[0]).toMatchObject({ passed: false, stale: true });
  });
  it("a result is stamped with the hash of the code it ran against", () => {
    pass(2);
    const e = readLedger().events.at(-1)!;
    expect(e.kind).toBe("test_result");
    expect(e.data).toMatchObject({ scenario: 2, passed: true, source: "demo", codeHash: protectionHash(root) });
  });
});

describe("clean counted trades X of 5", () => {
  it("a closed demo trade with a confirmed stop and no unprotected moment is counted", () => {
    cleanTrade(1);
    expect(ledgerSweep(T + 3_600_000)).toBe(1);
    expect(gate(T + 3_600_000).trades).toMatchObject({ clean: 1, needed: 5, counted: 1, excluded: 0 });
  });
  it("five of them, plus the six real tests and the fake partial fill on the current code, open the gate; four do not", () => {
    passAll();
    for (let i = 1; i <= 4; i++) cleanTrade(i);
    expect(gate(T + 3_600_000).ok).toBe(false);
    expect(gate(T + 3_600_000).why).toMatch(/clean counted trades 4 of 5/);
    cleanTrade(5);
    const g = gate(T + 3_600_000);
    expect(GATE_TRADES_NEEDED).toBe(5);
    expect(g).toMatchObject({ ok: true, trades: { clean: 5 }, tests: { passed: 6, total: 6 }, partialFill: { passed: true } });
  });
  it("five clean trades are not enough without the tests, and the tests are not enough without the five trades", () => {
    for (let i = 1; i <= 5; i++) cleanTrade(i);
    expect(gate(T + 3_600_000).ok).toBe(false);
    __resetLedger();
    passAll();
    expect(gate(T + 3_600_000).ok).toBe(false);
  });
  it("a trade with no confirmed stop on record (for instance one from before the ledger existed) is excluded, not counted", () => {
    trade("old", "999", { openedAt: T, closedAt: T + 60_000 });
    ledgerSweep(T + 120_000);
    expect(gate(T + 120_000).trades).toMatchObject({ clean: 0, counted: 0, excluded: 1 });
    expect(readLedger().events.at(-1)!.data.why).toMatch(/no confirmed stop/);
  });
  it("an unprotected moment from its entry to its close excludes the trade", () => {
    protectedEntry("ordA", T);
    trade("posA", "ordA", { openedAt: T + 1000, closedAt: T + 60_000 });
    recordUnprotected({ kind: "stop_problem", text: "stop missing" }, T + 20_000);
    ledgerSweep(T + 120_000);
    expect(gate(T + 120_000).trades).toMatchObject({ clean: 0, counted: 0, excluded: 1 });
  });
  it("an unprotected moment DURING the entry itself (before the engine marks the trade open) also excludes it", () => {
    protectedEntry("ordB", T);
    recordUnprotected({ kind: "stop_problem", text: "stop missing right after the entry, repaired" }, T + 300);
    trade("posB", "ordB", { openedAt: T + 1500, closedAt: T + 60_000 });
    ledgerSweep(T + 120_000);
    expect(gate(T + 120_000).trades.excluded).toBe(1);
  });
  it("THE RESET RULE: one unprotected moment sets the count to 0, whatever the count was; trades after it count again from 0", () => {
    for (let i = 1; i <= 3; i++) cleanTrade(i);
    expect(gate(T + 10 * 60_000).trades.clean).toBe(3);
    recordUnprotected({ kind: "unreachable", text: "Bybit could not be read with a position held" }, T + 11 * 60_000);
    const after = gate(T + 12 * 60_000);
    expect(after.trades.clean).toBe(0);
    expect(after.trades.counted).toBe(3); // still on record, but no longer in the count
    expect(after.trades.lastUnprotectedAt).toBe(T + 11 * 60_000);
    expect(after.trades.lastUnprotectedText).toMatch(/could not be read/);
    cleanTrade(20);
    cleanTrade(21);
    expect(gate(T + 30 * 60_000).trades.clean).toBe(2);
    recordUnprotected({ kind: "stop_problem", text: "again" }, T + 31 * 60_000);
    expect(gate(T + 32 * 60_000).trades.clean).toBe(0);
  });
  it("an unprotected moment with no trade open (a watchdog 'unreachable') still resets the count", () => {
    cleanTrade(1);
    cleanTrade(2);
    recordUnprotected({ kind: "unreachable", text: "x" }, T + 5 * 60_000);
    expect(gate(T + 6 * 60_000).trades.clean).toBe(0);
  });
  it("an all-clear ('resolved') is not an unprotected moment and resets nothing", () => {
    cleanTrade(1);
    recordUnprotected({ kind: "resolved", text: "fine now" }, T + 5 * 60_000);
    expect(readLedger().events.filter((e) => e.kind === "unprotected")).toHaveLength(0);
    expect(gate(T + 6 * 60_000).trades.clean).toBe(1);
  });
  it("only the DEMO bot's closed bybit trades are judged: not the live bot, not an open trade, not a simulated one", () => {
    protectedEntry("l1", T);
    trade("live1", "l1", { openedAt: T, closedAt: T + 60_000, botId: LIVE_BOT_ID });
    protectedEntry("o1", T);
    trade("open1", "o1", { openedAt: T, closedAt: null, status: "open" });
    protectedEntry("m1", T);
    trade("mock1", "m1", { openedAt: T, closedAt: T + 60_000, venue: "mock" });
    expect(ledgerSweep(T + 120_000)).toBe(0);
    expect(gate(T + 120_000).trades).toMatchObject({ counted: 0, excluded: 0 });
  });
  it("the sweep is idempotent: running it again judges nothing twice", () => {
    cleanTrade(1);
    expect(ledgerSweep(T + 120_000)).toBe(1);
    expect(ledgerSweep(T + 130_000)).toBe(0);
    expect(readLedger().events.filter((e) => e.kind === "trade_counted")).toHaveLength(1);
  });
  it("a trade that closed BEFORE a later unprotected moment is out of the count (the count is of trades closed since the last one)", () => {
    cleanTrade(1);
    recordUnprotected({ kind: "stop_problem", text: "later, on another trade" }, T + 90 * 60_000);
    expect(gate(T + 100 * 60_000).trades.clean).toBe(0);
  });
});

describe("a damaged ledger can never pass the gate", () => {
  it("even with everything else in order", () => {
    passAll();
    for (let i = 1; i <= 5; i++) cleanTrade(i);
    expect(gate(T + 3_600_000).ok).toBe(true);
    const lines = fs.readFileSync(ledgerFile(), "utf8").trim().split("\n");
    fs.writeFileSync(ledgerFile(), `${lines.slice(1).join("\n")}\n`); // the first line removed
    const g = gate(T + 3_600_000);
    expect(g.ok).toBe(false);
    expect(g.ledger.ok).toBe(false);
    expect(g.why).toMatch(/ledger is damaged/);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------ through the real executor

describe("the facts as the real executor and engine produce them (fake exchange)", () => {
  const config: BybitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, apiBase: "https://api-demo.bybit.com", symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 10, breakevenTriggerPercent: 0, breakevenLockPercent: 0, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000 };
  const fast = { closeConfirmTimeoutMs: 1000, orderFillTimeoutMs: 1000, pollIntervalMs: 5, ladderStepMs: 20 };
  let bybit: FakeBybit;
  let nowMs: number;
  const build = () => {
    const ex = new BybitExecutor(config, bybit.fetch, () => undefined, () => nowMs);
    ex.sleep = async () => undefined;
    ex.onEntryProtected = recordEntryProtected; // what watchdogTick wires in the app
    ex.onAlarm = (a) => raiseStopAlarm(a, nowMs);
    return ex;
  };
  const sig = (direction: "bullish" | "bearish", bar: string) => receiveAndSaveSignal({ botId: BTC_BOT_ID, signal: direction, price: 76_000, barTime: bar, interval: "5", raw: { symbol: "BTC" }, now: nowMs });
  const go = (ex: BybitExecutor, direction: "bullish" | "bearish", bar: string, at: number) => {
    nowMs = at;
    bybit.clock = () => nowMs;
    return processSignal(sig(direction, bar), { executor: ex, now: at, ...fast });
  };
  beforeEach(() => {
    bybit = new FakeBybit();
    nowMs = BASE_NOW;
    ensureBotRecord(BTC_BOT_ID);
  });

  it("a normal trade: entry confirmed, flipped, closed -> the first trade is COUNTED (and the second, still open, is not judged)", async () => {
    const ex = build();
    await go(ex, "bullish", "e1", BASE_NOW);
    expect(readLedger().events.filter((e) => e.kind === "entry_protected")).toHaveLength(1);
    expect(readLedger().events.find((e) => e.kind === "entry_protected")!.data).toMatchObject({ side: "Buy", orderId: "1001" });
    await go(ex, "bearish", "e2", BASE_NOW + 10 * 60_000);
    ledgerSweep(BASE_NOW + 11 * 60_000);
    const g = gate(BASE_NOW + 11 * 60_000);
    expect(g.trades).toMatchObject({ clean: 1, counted: 1, excluded: 0 });
    expect(readLedger().events.filter((e) => e.kind === "entry_protected")).toHaveLength(2);
    expect(positionsStore.query((p) => p.status === "open")).toHaveLength(1);
  });

  it("an entry whose stop was missing (repaired at once) rings the alarm path: the ledger gets an unprotected moment, the trade is EXCLUDED and the count is 0", async () => {
    const ex = build();
    bybit.dropStops = true; // Bybit ignored the stop on the entry; the executor repairs it
    await go(ex, "bullish", "e1", BASE_NOW);
    expect(readLedger().events.filter((e) => e.kind === "unprotected").length).toBeGreaterThan(0);
    bybit.dropStops = false;
    await go(ex, "bearish", "e2", BASE_NOW + 10 * 60_000);
    ledgerSweep(BASE_NOW + 11 * 60_000);
    const g = gate(BASE_NOW + 11 * 60_000);
    expect(g.trades.clean).toBe(0);
    expect(g.trades.excluded).toBeGreaterThanOrEqual(1);
    expect(botsStore.get(BTC_BOT_ID)?.needsAttention).toBe(true); // the alarm still reaches the page as before
  });

  it("an entry that could not be protected and was closed again leaves no 'confirmed stop' fact", async () => {
    const ex = build();
    bybit.dropStops = true;
    bybit.tradingStopFails = true;
    await go(ex, "bullish", "e1", BASE_NOW);
    expect(readLedger().events.filter((e) => e.kind === "entry_protected")).toHaveLength(0);
    expect(readLedger().events.filter((e) => e.kind === "unprotected").length).toBeGreaterThan(0);
  });

  it("an executor with no ledger hook set (the live one, or a test) writes nothing", async () => {
    const ex = new BybitExecutor(config, bybit.fetch, () => undefined, () => nowMs);
    ex.sleep = async () => undefined;
    await go(ex, "bullish", "e1", BASE_NOW);
    expect(readLedger().events).toHaveLength(0);
  });
});

describe("what the harness records when a test finishes", () => {
  const dir = () => path.dirname(ledgerFile());
  const last = () => readLedger(dir()).events.at(-1)!;
  it("a passed scenario is a pass; a failed one is a FAILURE; each stamped with the code hash and the right source", () => {
    expect(recordHarnessOutcome("3. stop deleted and the repair refused", "pass", { source: "demo", dir: dir(), root })).toBe(3);
    expect(last().data).toMatchObject({ scenario: 3, passed: true, source: "demo", codeHash: protectionHash(root) });
    expect(recordHarnessOutcome("4. the network is cut", "fail", { source: "demo", dir: dir(), root })).toBe(4);
    expect(last().data).toMatchObject({ scenario: 4, passed: false });
  });
  it("a skipped or unfinished test records NOTHING (a missing result is not a pass)", () => {
    for (const state of ["skip", "run", "todo", undefined]) expect(recordHarnessOutcome("2. x", state, { source: "demo", dir: dir(), root }), String(state)).toBeNull();
    expect(readLedger(dir()).events).toHaveLength(0);
  });
  it("test 0 (the connection check) and anything that is not a scenario record nothing", () => {
    for (const name of ["0. connects and the account is flat", "8. something", "flip", "5 flip"]) expect(recordHarnessOutcome(name, "pass", { source: "demo", dir: dir(), root }), name).toBeNull();
  });
  it("a demo run cannot record scenario 7, and the fake proof cannot record 1 to 6", () => {
    expect(recordHarnessOutcome("7. partial fill", "pass", { source: "demo", dir: dir(), root })).toBeNull();
    expect(recordHarnessOutcome("2. stop deleted", "pass", { source: "fake", dir: dir(), root })).toBeNull();
    expect(recordHarnessOutcome("7. partial fill", "pass", { source: "fake", dir: dir(), root })).toBe(7);
  });
  it("and the gate then counts exactly those", () => {
    for (const n of ["1.", "2.", "3.", "4.", "5.", "6."]) recordHarnessOutcome(`${n} x`, "pass", { source: "demo", dir: dir(), root });
    recordHarnessOutcome("7. partial fill", "pass", { source: "fake", dir: dir(), root });
    expect(gate().tests).toMatchObject({ passed: 6, total: 6 });
    expect(gate().partialFill.passed).toBe(true);
    recordHarnessOutcome("5. flip", "fail", { source: "demo", dir: dir(), root }, T + 5);
    expect(gate().tests.passed).toBe(5);
    recordHarnessOutcome("7. partial fill", "fail", { source: "fake", dir: dir(), root }, T + 6);
    expect(gate().partialFill.passed).toBe(false);
  });
});
