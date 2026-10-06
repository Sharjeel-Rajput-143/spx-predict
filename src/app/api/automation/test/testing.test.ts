import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestWebhook } from "@/lib/automation/webhookIngest";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { botsStore, decisionsStore, ordersStore, positionsStore, runsStore, signalsStore } from "@/lib/automation/store";
import { NDX_BOT_ID, TEST_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "@/lib/automation/testSupport";
import { GET as status } from "../status/route";
import { POST as alert } from "./alert/route";
import { POST as reset } from "./reset/route";

// The admin page's testing mode, end to end through the route handlers, on the
// mock executor only. No network: nothing here talks to a broker or any webhook URL.

setTestBotEnv();
setNdxTestEnv();

const post = (path: string, body: unknown) => new NextRequest(`http://localhost/api/automation/test/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const send = (bot: string, signal: "bullish" | "bearish", price: number) => alert(post("alert", { bot, signal, price }));
const outcomes = (bot: string) => decisionsStore.query((d) => d.botId === bot).map((d) => d.outcome);

const SATURDAY = Date.UTC(2026, 9, 10, 19, 0); // Sat Oct 10, 3pm ET: the market is closed

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  vi.stubEnv("WEBHOOK_SECRET", "test-secret-value");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Send test alert goes through the real webhook path", () => {
  it("a bullish alert opens a short put spread for each bot, labelled as a test", async () => {
    vi.stubEnv("AUTOMATION_TEST_MODE", "true");
    for (const [bot, price] of [[TEST_BOT_ID, 7720], [NDX_BOT_ID, 21_003.7]] as const) {
      const res = await send(bot, "bullish", price);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ finished: true, decisions: [{ outcome: "opened" }] });
    }
    const positions = positionsStore.all();
    expect(positions.map((p) => [p.botId, p.underlying, p.type, p.status, p.venue, p.test])).toEqual([
      [TEST_BOT_ID, "SPX", "short_put_spread", "open", "mock", true],
      [NDX_BOT_ID, "NDX", "short_put_spread", "open", "mock", true],
    ]);
    expect(ordersStore.all()).toHaveLength(2);
    // The alert is recorded like any other: a signal row plus a run trace.
    expect(signalsStore.all().map((s) => [s.botId, s.status, (s.raw as { symbol: string; test: boolean }).symbol, (s.raw as { test: boolean }).test])).toEqual([
      [TEST_BOT_ID, "accepted", "SPX", true],
      [NDX_BOT_ID, "accepted", "NDX", true],
    ]);
    expect(runsStore.all()).toHaveLength(2);
  });

  it("a flip closes the opposite side, waits for the confirmation, then opens the new one", async () => {
    vi.stubEnv("AUTOMATION_TEST_MODE", "true");
    await send(NDX_BOT_ID, "bullish", 21_003.7);
    const res = await send(NDX_BOT_ID, "bearish", 21_003.7);
    expect((await res.json()).decisions.map((d: { outcome: string }) => d.outcome)).toEqual(["closed", "opened"]);

    const byType = Object.fromEntries(positionsStore.all().map((p) => [p.type, p]));
    expect(byType.short_put_spread).toMatchObject({ status: "closed", shortStrike: 20_975, longStrike: 20_965 });
    expect(byType.short_call_spread).toMatchObject({ status: "open", shortStrike: 21_035, longStrike: 21_045 });
    expect(ordersStore.all().map((o) => `${o.kind}:${o.status}`)).toEqual(["open:filled", "close:filled", "open:filled"]);
  });

  it("goes through dedupe: the same alert twice inside the window is a duplicate", async () => {
    vi.stubEnv("AUTOMATION_TEST_MODE", "true");
    const first = await (await send(NDX_BOT_ID, "bullish", 21_003.7)).json();
    expect(first.decisions[0].outcome).toBe("opened");
    // A later signal with the same direction and price inside the window - what a double delivery looks like.
    const second = await (await send(NDX_BOT_ID, "bullish", 21_003.7)).json();
    expect(second.decisions.map((d: { outcome: string }) => d.outcome)).toEqual(["duplicate_signal"]);
    expect(positionsStore.all()).toHaveLength(1);
  });

  it("still honours the kill switch and the other safeguards", async () => {
    vi.stubEnv("AUTOMATION_TEST_MODE", "true");
    botsStore.insert({ id: NDX_BOT_ID, enabled: false, needsAttention: false, needsAttentionReason: null, createdAt: 0 });
    expect((await (await send(NDX_BOT_ID, "bullish", 21_003.7)).json()).decisions[0].outcome).toBe("automations_off");
    expect((await (await send(NDX_BOT_ID, "bullish", 7720)).json()).decisions[0].outcome).toBe("automations_off");
    expect(positionsStore.all()).toHaveLength(0);

    botsStore.update(NDX_BOT_ID, { enabled: true });
    expect((await (await send(NDX_BOT_ID, "bullish", 7720)).json()).decisions[0].outcome).toBe("price_out_of_range");
  });

  it("outside trading hours it only runs with testing mode on, and says the clock check was skipped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SATURDAY);

    const off = await (await send(NDX_BOT_ID, "bullish", 21_003.7)).json();
    expect(off.decisions.map((d: { outcome: string }) => d.outcome)).toEqual(["outside_hours"]);

    vi.stubEnv("AUTOMATION_TEST_MODE", "true");
    const on = await (await send(NDX_BOT_ID, "bearish", 21_003.7)).json();
    expect(on.decisions.map((d: { outcome: string }) => d.outcome)).toEqual(["opened"]);
    const clock = runsStore.all().at(-1)!.nodes.find((n) => n.kind === "decision" && n.text.startsWith("Current market time"));
    expect(clock).toMatchObject({ result: true });
    expect((clock as { measured: string }).measured).toMatch(/Testing mode: clock check skipped.*closed on weekends/);
  });

  it("a real webhook body can't switch testing on: a `test` field is ignored and the clock still applies", async () => {
    vi.stubEnv("AUTOMATION_TEST_MODE", "true");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SATURDAY);
    const result = ingestWebhook({ secret: "test-secret-value", test: true, bot: NDX_BOT_ID, signal: "bullish", symbol: "NDX", price: 21_003.7, bar_time: "tv-bar", interval: "5" }, { executor: sharedExecutor });
    await result.processing;
    expect(outcomes(NDX_BOT_ID)).toEqual(["outside_hours"]);
    expect(signalsStore.all()[0].raw).not.toHaveProperty("test");
  });

  it("refuses bad input, an unknown bot, and a bot whose settings are missing", async () => {
    expect((await alert(post("alert", { bot: "nope", signal: "bullish", price: 1 }))).status).toBe(404);
    expect((await alert(post("alert", { bot: NDX_BOT_ID, signal: "sideways", price: 1 }))).status).toBe(400);
    expect((await alert(post("alert", { bot: NDX_BOT_ID, signal: "bullish" }))).status).toBe(400);
    expect((await alert(post("alert", { bot: NDX_BOT_ID, signal: "bullish", price: -1 }))).status).toBe(400);

    vi.stubEnv("BOT_NDX_EMA_BIAS_PUT_SHORT_OFFSET", "");
    const res = await send(NDX_BOT_ID, "bullish", 21_003.7);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/PUT_SHORT_OFFSET/);
    expect(signalsStore.all()).toHaveLength(0);
  });

  it("is mock-only: with a broker executor selected it refuses and sends nothing", async () => {
    vi.stubEnv("EXECUTOR", "tradier");
    vi.stubEnv("TRADIER_TOKEN", "TEST-TOKEN-not-real");
    vi.stubEnv("TRADIER_ACCOUNT_ID", "ACC-TEST");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await send(NDX_BOT_ID, "bullish", 21_003.7);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/mock executor/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(signalsStore.all()).toHaveLength(0);
    fetchSpy.mockRestore();
  });
});

describe("status page data", () => {
  it("lists positions with legs and credit, orders with their states, and the decisions under each alert", async () => {
    vi.stubEnv("AUTOMATION_TEST_MODE", "true");
    await send(NDX_BOT_ID, "bullish", 21_003.7);
    await send(NDX_BOT_ID, "bearish", 21_003.7);

    const data = await (await status(new NextRequest("http://localhost/api/automation/status"))).json();
    expect(data.executor).toMatchObject({ kind: "mock", venue: "mock", error: null, testMode: true });
    expect(data.positions.map((p: { type: string; status: string; test: boolean }) => [p.type, p.status, p.test])).toEqual([
      ["short_call_spread", "open", true], // active first
      ["short_put_spread", "closed", true],
    ]);
    expect(data.orders).toHaveLength(3);
    expect(data.orders[0]).toMatchObject({ venue: "mock", status: "filled", shortStrike: expect.any(Number) });
    const [latest, earlier] = data.signals;
    expect(latest.decisions.map((d: { outcome: string }) => d.outcome)).toEqual(["closed", "opened"]);
    expect(earlier.decisions.map((d: { outcome: string }) => d.outcome)).toEqual(["opened"]);
    expect(latest.test).toBe(true);
    const ndx = data.bots.find((b: { id: string }) => b.id === NDX_BOT_ID);
    expect(ndx).toMatchObject({ underlying: "NDX", enabled: true, activePositionCount: 1, closedPositionCount: 1, suggestedPrice: 21_003.7 });
  });

  it("suggests the middle of the price range for a bot that has had no alert, and lists missing settings for one that can't run", async () => {
    const data = await (await status(new NextRequest("http://localhost/api/automation/status"))).json();
    expect(data.bots.find((b: { id: string }) => b.id === NDX_BOT_ID).suggestedPrice).toBe(22_500); // (15,000 + 30,000) / 2, on the increment
    vi.stubEnv("BOT_NDX_EMA_BIAS_PRICE_MAX", "");
    const broken = await (await status(new NextRequest("http://localhost/api/automation/status"))).json();
    expect(broken.bots.find((b: { id: string }) => b.id === NDX_BOT_ID).missingSettings.map((m: { key: string }) => m.key)).toEqual(["BOT_NDX_EMA_BIAS_PRICE_MAX"]);
  });

  it("reports a misconfigured broker executor instead of failing", async () => {
    vi.stubEnv("EXECUTOR", "tradier");
    vi.stubEnv("TRADIER_TOKEN", "");
    const data = await (await status(new NextRequest("http://localhost/api/automation/status"))).json();
    expect(data.executor.error).toMatch(/TRADIER_TOKEN/);
  });
});

describe("Reset test data", () => {
  it("needs an explicit confirm, clears what was recorded, and keeps the bots", async () => {
    vi.stubEnv("AUTOMATION_TEST_MODE", "true");
    await send(NDX_BOT_ID, "bullish", 21_003.7);
    botsStore.update(NDX_BOT_ID, { enabled: false, needsAttention: true, needsAttentionReason: "from a test run" });

    expect((await reset(post("reset", {}))).status).toBe(400);
    expect(positionsStore.all()).toHaveLength(1);

    const res = await reset(post("reset", { confirm: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).cleared).toMatchObject({ signals: 1, positions: 1, orders: 1, decisions: 1, runs: 1 });
    expect([signalsStore.all(), positionsStore.all(), ordersStore.all(), decisionsStore.all(), runsStore.all()].map((r) => r.length)).toEqual([0, 0, 0, 0, 0]);
    // The bot is still there, still off (the kill switch is the person's call), and no longer flagged.
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ enabled: false, needsAttention: false, needsAttentionReason: null });
  });

  it("after a reset the same alert is accepted again (dedupe memory is cleared too)", async () => {
    vi.stubEnv("AUTOMATION_TEST_MODE", "true");
    await send(NDX_BOT_ID, "bullish", 21_003.7);
    await reset(post("reset", { confirm: true }));
    expect((await (await send(NDX_BOT_ID, "bullish", 21_003.7)).json()).decisions[0].outcome).toBe("opened");
  });

  it("refuses with a broker executor selected - that data isn't test data", async () => {
    vi.stubEnv("EXECUTOR", "tradier");
    vi.stubEnv("TRADIER_TOKEN", "TEST-TOKEN-not-real");
    vi.stubEnv("TRADIER_ACCOUNT_ID", "ACC-TEST");
    positionsStore.insert({ id: "p", botId: NDX_BOT_ID } as never);
    expect((await reset(post("reset", { confirm: true }))).status).toBe(409);
    expect(positionsStore.all()).toHaveLength(1);
  });
});
