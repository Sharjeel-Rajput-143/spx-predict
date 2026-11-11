import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BTC_BOT_ID } from "./bots";
import { parseRef } from "./bybitExecutor";
import { liveDataDir } from "./liveSettings";
import { ordersStore, positionsStore } from "./store";

/**
 * THE LEDGER: the facts the live gate is measured from. Written by the code, from things that happened, never typed by anyone and never edited by the page.
 *
 *   entry_protected   the demo executor confirmed the stop loss of an entry (it says which Bybit order, and when it was sent and confirmed)
 *   unprotected       the stop watchdog found a position without a correct stop, or could not confirm one, or could not reach Bybit with a position held
 *   trade_counted     a closed demo trade that had a confirmed stop and no unprotected moment from its entry order to its close
 *   trade_excluded    a closed demo trade that did not qualify, and why
 *   test_result       one failure scenario was run by the test harness (it passed or it did not), with the hash of the stop-safety code it ran against
 *
 * The gate, as the owner set it (2026-11-10), shown honestly in three parts:
 *   1. Failure tests on the REAL Bybit demo account: all 6 passed, on the CURRENT stop-safety code (a change to those files makes earlier passes stale: they must be run again).
 *   2. Partial fill, proven on the FAKE exchange (the demo account cannot do it) on the same current code: yes or no. A fake pass never counts for 1 to 6.
 *   3. At least 5 clean counted demo trades. ONE unprotected moment resets that count to 0.
 * The gate passes only when all three hold.
 * Stage 1 (a $10 account) is not held up by the gate; Stage 2 is.
 *
 * Tamper evidence: every line carries the hash of the line before it. A line edited or removed breaks the chain, and a broken chain means the gate is NOT passed.
 * A write that fails is kept in memory and retried; while any is waiting the gate is NOT passed.
 */

/** The failure tests that run on the real demo account (scenarios 1 to 6). The partial fill (7) is a separate line: it can only be proven on the fake exchange. */
export const GATE_TESTS_NEEDED = 6;
export const PARTIAL_FILL_SCENARIO = 7;
export const GATE_TRADES_NEEDED = 5;

/** The files whose behaviour the failure scenarios exercise. A change to any of them makes every earlier test result stale. */
export const PROTECTION_FILES = ["src/lib/automation/bybitExecutor.ts", "src/lib/automation/bybitWatchdog.ts", "src/lib/automation/bybitRisk.ts"] as const;

export interface Scenario {
  id: number;
  title: string;
  /** Where a pass counts from: the real Bybit demo account, or (only where the demo cannot do it) the fake exchange. */
  source: "demo" | "fake";
}
export const SCENARIOS: readonly Scenario[] = [
  { id: 1, title: "Bybit removes the stop when the position closes", source: "demo" },
  { id: 2, title: "stop deleted by hand: alarm, one repair, confirmed", source: "demo" },
  { id: 3, title: "stop deleted and the repair refused: reduce-only closes until flat", source: "demo" },
  { id: 4, title: "network cut after the entry: ends flat or protected", source: "demo" },
  { id: 5, title: "flip: old side closed, new side has its own stop", source: "demo" },
  { id: 6, title: "restart with a position open and the stop gone: startup check repairs it", source: "demo" },
  { id: PARTIAL_FILL_SCENARIO, title: "partial fill: the stop covers all of what is held (the demo account cannot do it: proven on the fake exchange)", source: "fake" },
];

export type LedgerKind = "entry_protected" | "unprotected" | "trade_counted" | "trade_excluded" | "test_result" | "live_auto_resume";
export interface LedgerEvent {
  seq: number;
  t: number;
  kind: LedgerKind;
  data: Record<string, unknown>;
  prev: string;
  h: string;
}

const GENESIS = "genesis";
const hashOf = (e: Omit<LedgerEvent, "h">): string => crypto.createHash("sha256").update(JSON.stringify({ seq: e.seq, t: e.t, kind: e.kind, data: e.data, prev: e.prev })).digest("hex");

/** `dir`: another folder than the live one. Used by the test harness only, and only when it is told where the real ledger is (see bybitStopLive.test.ts). */
export const ledgerFile = (dir: string = liveDataDir()): string => path.join(dir, "ledger.jsonl");

export interface LedgerRead {
  events: LedgerEvent[];
  /** Null when the chain is whole; otherwise what is wrong (the gate is then NOT passed). */
  damaged: string | null;
}

/** Reads and checks the whole ledger. A missing file is an empty ledger. */
export function readLedger(dir?: string): LedgerRead {
  let text = "";
  try {
    text = fs.readFileSync(ledgerFile(dir), "utf8");
  } catch {
    return { events: [], damaged: null };
  }
  const events: LedgerEvent[] = [];
  let prev = GENESIS;
  let damaged: string | null = null;
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  lines.forEach((line, i) => {
    let e: LedgerEvent;
    try {
      e = JSON.parse(line) as LedgerEvent;
    } catch {
      damaged ??= `line ${i + 1} is not readable`;
      return;
    }
    if (e.prev !== prev || e.seq !== i + 1 || e.h !== hashOf(e)) damaged ??= `line ${i + 1} does not match the line before it (the ledger was changed)`;
    events.push(e);
    prev = typeof e.h === "string" ? e.h : prev;
  });
  return { events, damaged };
}

const pending: { kind: LedgerKind; data: Record<string, unknown>; t: number; dir?: string }[] = [];
/** How many facts are waiting to be written (a write failed). The gate is not passed while there are any. */
export const pendingWrites = (): number => pending.length;

function writeOne(kind: LedgerKind, data: Record<string, unknown>, t: number, dir?: string): void {
  const { events } = readLedger(dir);
  const last = events.at(-1);
  const base = { seq: (last?.seq ?? 0) + 1, t, kind, data, prev: last?.h ?? GENESIS };
  const line = JSON.stringify({ ...base, h: hashOf(base) });
  fs.mkdirSync(path.dirname(ledgerFile(dir)), { recursive: true });
  fs.appendFileSync(ledgerFile(dir), `${line}\n`);
}

/** Writes a fact. Never throws: a failure is kept and retried on the next write or read. */
export function appendEvent(kind: LedgerKind, data: Record<string, unknown>, t: number = Date.now(), dir?: string): boolean {
  pending.push({ kind, data, t, ...(dir ? { dir } : {}) });
  return flushPending();
}

export function flushPending(): boolean {
  while (pending.length > 0) {
    const next = pending[0];
    try {
      writeOne(next.kind, next.data, next.t, next.dir);
      pending.shift();
    } catch (err) {
      console.error("[ledger] could not write a fact; it is kept and retried", err);
      return false;
    }
  }
  return true;
}

// ------------------------------------------------------------------------------------------------------------------------------ the facts

export interface EntryProtected {
  orderId: string;
  side: "Buy" | "Sell";
  stopLoss: number;
  takeProfit: number | null;
  submittedAt: number;
  confirmedAt: number;
}
export function recordEntryProtected(e: EntryProtected): void {
  appendEvent("entry_protected", { ...e }, e.confirmedAt);
}

export function recordUnprotected(alarm: { kind: string; text: string }, at: number = Date.now()): void {
  if (alarm.kind === "resolved") return;
  appendEvent("unprotected", { kind: alarm.kind, text: alarm.text.slice(0, 300) }, at);
}

/** The hash of the stop-safety code in `root` (the folder holding src/). Null when any of the files cannot be read: then no test result can count. */
export function protectionHash(root: string = process.env.PROTECTION_ROOT || process.cwd()): string | null {
  const h = crypto.createHash("sha256");
  try {
    for (const f of PROTECTION_FILES) h.update(f).update("\0").update(fs.readFileSync(path.join(root, f))).update("\0");
  } catch {
    return null;
  }
  return h.digest("hex");
}

/**
 * Written by the test harness, only from a real run. `source` is "demo" for a run against the real Bybit demo account and "fake" for the fake exchange. A pass from the fake
 * counts only for a scenario that cannot be run on the demo account.
 */
export function recordTestResult(r: { scenario: number; passed: boolean; source: "demo" | "fake"; detail?: string }, at: number = Date.now(), root?: string, dir?: string): void {
  appendEvent("test_result", { scenario: r.scenario, passed: r.passed, source: r.source, codeHash: protectionHash(root), detail: (r.detail ?? "").slice(0, 300) }, at, dir);
}

/**
 * What the failure-test harness calls when one of its tests finishes: the test's name starts with its scenario number ("3. stop deleted..."), and `state` is the test's own
 * outcome. A pass is recorded as a pass, a failure as a failure; a test that was skipped or never finished records NOTHING (a missing result is not a pass either).
 * Returns the scenario recorded, or null.
 */
export function recordHarnessOutcome(testName: string, state: string | undefined, o: { source: "demo" | "fake"; dir: string; root?: string }, at: number = Date.now()): number | null {
  const m = /^([1-7])\./.exec(testName);
  if (!m || (state !== "pass" && state !== "fail")) return null;
  const scenario = Number(m[1]);
  const def = SCENARIOS.find((x) => x.id === scenario);
  if (!def || def.source !== o.source) return null; // a demo run records scenarios 1 to 6 as "demo"; the fake-exchange proof records 7 as "fake"; never the other way round
  recordTestResult({ scenario, passed: state === "pass", source: o.source, detail: testName.slice(0, 120) }, at, o.root, o.dir);
  return scenario;
}

/**
 * Looks at the demo bot's closed trades that have not been judged yet and counts or excludes each, from the facts above. Idempotent; run every few seconds by the risk
 * tick and whenever the gate is read. Never throws.
 */
export function ledgerSweep(now: number = Date.now()): number {
  try {
    flushPending();
    const { events } = readLedger();
    const judged = new Set(events.filter((e) => e.kind === "trade_counted" || e.kind === "trade_excluded").map((e) => String(e.data.tradeId)));
    const entries = new Map(events.filter((e) => e.kind === "entry_protected").map((e) => [String(e.data.orderId), e.data as unknown as EntryProtected]));
    const unprotected = events.filter((e) => e.kind === "unprotected").map((e) => e.t);
    let done = 0;
    for (const p of positionsStore.query((x) => x.botId === BTC_BOT_ID && x.venue === "bybit" && x.status === "closed" && x.closedAt != null)) {
      if (judged.has(p.id)) continue;
      const open = ordersStore.query((o) => o.positionId === p.id && o.kind === "open")[0];
      const orderId = parseRef(open?.ref)?.orderId ?? null;
      const entry = orderId ? entries.get(orderId) : undefined;
      const closedAt = p.closedAt as number;
      if (!entry) {
        appendEvent("trade_excluded", { tradeId: p.id, closedAt, why: "no confirmed stop loss was recorded for this entry" }, now);
      } else if (unprotected.some((t) => t >= entry.submittedAt - 1000 && t <= closedAt + 2000)) {
        appendEvent("trade_excluded", { tradeId: p.id, closedAt, orderId, why: "an unprotected moment happened between its entry and its close" }, now);
      } else {
        appendEvent("trade_counted", { tradeId: p.id, closedAt, orderId, openedAt: p.openedAt, closeReason: p.closeReason ?? null }, now);
      }
      done++;
    }
    return done;
  } catch (err) {
    console.error("[ledger] sweep failed", err);
    return 0;
  }
}

// ------------------------------------------------------------------------------------------------------------------------------ the gate

export interface GateTest {
  id: number;
  title: string;
  source: "demo" | "fake";
  /** Counts toward the gate: passed, from the right source, on the current code. */
  passed: boolean;
  /** Passed once, but the stop-safety code has changed since: it must be run again. */
  stale: boolean;
  lastRunAt: number | null;
  lastRunPassed: boolean | null;
}
export interface LiveGate {
  ok: boolean;
  why: string;
  /** Failure tests on the REAL Bybit demo account: scenarios 1 to 6. */
  tests: { passed: number; total: number; items: GateTest[] };
  /** The partial fill, proven on the FAKE exchange on the current code hash. Not part of the count above. */
  partialFill: GateTest;
  trades: { clean: number; needed: number; lastUnprotectedAt: number | null; lastUnprotectedText: string | null; counted: number; excluded: number };
  ledger: { ok: boolean; events: number; damaged: string | null; pending: number };
  codeHash: string | null;
}

export function liveGate(now: number = Date.now(), root?: string): LiveGate {
  ledgerSweep(now);
  const { events, damaged } = readLedger();
  const hash = protectionHash(root);
  const stateOf = (s: Scenario): GateTest => {
    const runs = events.filter((e) => e.kind === "test_result" && e.data.scenario === s.id);
    const last = runs.at(-1);
    const rightSource = (e: LedgerEvent) => e.data.source === s.source;
    // Only runs of the right kind on the CURRENT code count, and the latest of those decides: a pass followed by a failure on the same code is a failure.
    const onCurrent = hash === null ? [] : runs.filter((e) => rightSource(e) && e.data.codeHash === hash);
    const current = onCurrent.at(-1)?.data.passed === true;
    const everPassed = runs.some((e) => e.data.passed === true && rightSource(e));
    return { id: s.id, title: s.title, source: s.source, passed: current, stale: !current && onCurrent.length === 0 && everPassed, lastRunAt: last?.t ?? null, lastRunPassed: last ? last.data.passed === true : null };
  };
  const items: GateTest[] = SCENARIOS.filter((s) => s.source === "demo").map(stateOf);
  const partialFill = stateOf(SCENARIOS.find((s) => s.id === PARTIAL_FILL_SCENARIO)!);
  const unprot = events.filter((e) => e.kind === "unprotected");
  const lastUnprot = unprot.at(-1);
  const counted = events.filter((e) => e.kind === "trade_counted");
  const clean = counted.filter((e) => !lastUnprot || Number(e.data.closedAt) > lastUnprot.t).length;
  const testsPassed = items.filter((i) => i.passed).length;
  const pend = pendingWrites();
  const ledgerOk = damaged === null && pend === 0;
  const problems: string[] = [];
  if (!ledgerOk) problems.push(damaged ? `the ledger is damaged (${damaged})` : "a ledger write is waiting to be saved");
  if (hash === null) problems.push("the stop-safety code could not be read, so no test result can count");
  if (testsPassed < GATE_TESTS_NEEDED) {
    const todo = items.filter((i) => !i.passed).map((i) => `${i.id}${i.stale ? " (stale: run again)" : ""}`).join(", ");
    problems.push(`failure tests on the real demo account ${testsPassed} of ${GATE_TESTS_NEEDED} (still to run: ${todo})`);
  }
  if (!partialFill.passed) problems.push(`partial fill proven on the fake exchange: no${partialFill.stale ? " (stale: run again on the current code)" : ""}`);
  if (clean < GATE_TRADES_NEEDED) problems.push(`clean counted trades ${clean} of ${GATE_TRADES_NEEDED}`);
  const ok = problems.length === 0;
  return {
    ok,
    why: ok ? `all ${GATE_TESTS_NEEDED} failure tests on the real demo account passed on the current code, the partial fill is proven on the fake exchange on the same code, and ${clean} clean counted trades` : problems.join("; "),
    tests: { passed: testsPassed, total: GATE_TESTS_NEEDED, items },
    partialFill,
    trades: { clean, needed: GATE_TRADES_NEEDED, lastUnprotectedAt: lastUnprot?.t ?? null, lastUnprotectedText: lastUnprot ? String(lastUnprot.data.text ?? "") : null, counted: counted.length, excluded: events.filter((e) => e.kind === "trade_excluded").length },
    ledger: { ok: ledgerOk, events: events.length, damaged, pending: pend },
    codeHash: hash,
  };
}

/** Tests only. */
export function __resetLedger(): void {
  pending.length = 0;
  fs.rmSync(ledgerFile(), { force: true });
}
