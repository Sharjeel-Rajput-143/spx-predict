import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetPruneClock, pruneOldRecords, pruneOncePerDay } from "./retention";
import { alertsStore, decisionsStore, errorsStore, ordersStore, positionsStore, runsStore, signalsStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";

setTestBotEnv();
setNdxTestEnv();
const DAY = 24 * 60 * 60_000;

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  __resetPruneClock();
});
afterEach(() => vi.unstubAllEnvs());

const seed = (id: string, at: number) => {
  signalsStore.insert({ id, botId: NDX_BOT_ID, signal: "bullish", barTime: "b", price: 21_000, interval: "", receivedAt: at, status: "accepted", raw: {} });
  decisionsStore.insert({ id: `d-${id}`, signalId: id, botId: NDX_BOT_ID, outcome: "opened", reason: "x", detail: {}, createdAt: at });
  runsStore.insert({ id, botId: NDX_BOT_ID, signalId: id, source: "webhook", automation: "Bullish signal", trigger: "TradingView", startedAt: at, nodes: [] });
  alertsStore.insert({ id: `a-${id}`, botId: NDX_BOT_ID, kind: "open", outcome: "opened", message: "m", signalId: id, createdAt: at, email: "off" });
  errorsStore.insert({ id: `e-${id}`, botId: NDX_BOT_ID, kind: "k", detail: {}, tradingDate: "2026-01-01", createdAt: at });
};

describe("trimming the log", () => {
  it("removes signals, decisions, runs, alerts and errors older than the retention, and keeps the newer ones", () => {
    seed("old", BASE_NOW - 120 * DAY);
    seed("new", BASE_NOW - 5 * DAY);
    expect(pruneOldRecords(BASE_NOW)).toEqual({ signals: 1, decisions: 1, runs: 1, alerts: 1, errors: 1 });
    expect(signalsStore.all().map((s) => s.id)).toEqual(["new"]);
    expect(decisionsStore.all().map((d) => d.id)).toEqual(["d-new"]);
    expect(runsStore.all().map((r) => r.id)).toEqual(["new"]);
    expect(alertsStore.all()).toHaveLength(1);
    expect(errorsStore.all()).toHaveLength(1);
  });

  it("never touches positions or their orders, however old", () => {
    const p = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "closed", botId: NDX_BOT_ID, openedAt: BASE_NOW - 400 * DAY, closedAt: BASE_NOW - 399 * DAY }));
    ordersStore.insert({ id: "o", positionId: p.id, kind: "open", status: "filled", limitPrice: 1, filledQuantity: 1, ref: "r", createdAt: BASE_NOW - 400 * DAY, updatedAt: BASE_NOW - 400 * DAY });
    pruneOldRecords(BASE_NOW);
    expect(positionsStore.get(p.id)).toBeDefined();
    expect(ordersStore.get("o")).toBeDefined();
  });

  it("LOG_RETENTION_DAYS sets the age, and 0 keeps everything", () => {
    seed("a", BASE_NOW - 40 * DAY);
    vi.stubEnv("LOG_RETENTION_DAYS", "30");
    expect(pruneOldRecords(BASE_NOW).signals).toBe(1);
    seed("b", BASE_NOW - 400 * DAY);
    vi.stubEnv("LOG_RETENTION_DAYS", "0");
    expect(pruneOldRecords(BASE_NOW)).toEqual({ signals: 0, decisions: 0, runs: 0, alerts: 0, errors: 0 });
    expect(signalsStore.all().map((s) => s.id)).toEqual(["b"]);
  });

  it("does its work at most once a day, however often it is asked", () => {
    seed("old", BASE_NOW - 120 * DAY);
    expect(pruneOncePerDay(BASE_NOW)?.signals).toBe(1);
    seed("old2", BASE_NOW - 120 * DAY);
    expect(pruneOncePerDay(BASE_NOW + 60_000)).toBeNull();
    expect(signalsStore.all().map((s) => s.id)).toEqual(["old2"]);
    expect(pruneOncePerDay(BASE_NOW + DAY + 1)?.signals).toBe(1);
  });
});
