import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord, BTC_BOT_ID } from "@/lib/automation/bots";
import { LIVE_BOT_ID } from "@/lib/automation/bybitLiveLimits";
import { LIVE_RUN_REFUSAL } from "@/lib/automation/liveRunRule";
import { decisionsStore, ordersStore, positionsStore, signalsStore } from "@/lib/automation/store";
import { TEST_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "@/lib/automation/testSupport";
import { POST } from "./route";

// THE GENERIC RUN ROUTE refuses the live bot, whoever asks and whatever the live switch says; every other bot is unchanged.

setNdxTestEnv();
setTestBotEnv();
const req = (body: unknown) => new NextRequest("http://localhost/api/automation/bots/x/run", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  setTestBotEnv();
  ensureBotRecord(LIVE_BOT_ID);
  ensureBotRecord(BTC_BOT_ID);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/automation/bots/[id]/run on the live bot", () => {
  it("is refused with a plain sentence (409), and nothing is saved, logged or sent", async () => {
    for (const body of [{ signal: "bullish", price: 76_000 }, { signal: "bearish" }, { signal: "bullish", price: 1 }, {}]) {
      const res = await POST(req(body) as never, ctx(LIVE_BOT_ID) as never);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect((await res.json()).error).toBe(LIVE_RUN_REFUSAL);
    }
    expect(signalsStore.query(() => true)).toHaveLength(0);
    expect(decisionsStore.query(() => true)).toHaveLength(0);
    expect(positionsStore.query(() => true)).toHaveLength(0);
    expect(ordersStore.query(() => true)).toHaveLength(0);
  });
  it("is refused even when the live switch is ON (the refusal does not depend on any setting)", async () => {
    const { enableLive } = await import("@/lib/automation/liveSettings");
    enableLive({ confirmed: true, preflightOk: true, gate: { ok: true, why: "" }, keyPresent: true });
    const res = await POST(req({ signal: "bullish", price: 76_000 }) as never, ctx(LIVE_BOT_ID) as never);
    expect(res.status).toBe(409);
    expect(signalsStore.query(() => true)).toHaveLength(0);
  });
  it("the sentence says what to use instead, in plain words", () => {
    expect(LIVE_RUN_REFUSAL).toMatch(/real TradingView signals/);
    expect(LIVE_RUN_REFUSAL).toMatch(/Open UP and Open DOWN buttons on the Live page/);
  });
  it("other bots are unchanged: an unknown bot is still 404, a bad signal still 400, a valid run still saves its signal and logs a decision", async () => {
    expect((await POST(req({ signal: "bullish" }) as never, ctx("nobody") as never)).status).toBe(404);
    expect((await POST(req({ signal: "sideways", price: 1 }) as never, ctx(TEST_BOT_ID) as never)).status).toBe(400);
    const ok = await POST(req({ signal: "bullish", price: 7720 }) as never, ctx(TEST_BOT_ID) as never);
    expect(ok.status).toBe(200);
    expect(signalsStore.query((s) => s.botId === TEST_BOT_ID)).toHaveLength(1);
    expect((await ok.json()).decisions.length).toBeGreaterThan(0);
  });
});
