import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { signalsStore } from "@/lib/automation/store";
import { NDX_BOT_ID, TEST_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "@/lib/automation/testSupport";
import { POST } from "./route";

process.env.WEBHOOK_SECRET = "test-secret";
setTestBotEnv();
setNdxTestEnv();

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/webhook/tradingview", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const validBody = {
  secret: "test-secret",
  bot: TEST_BOT_ID,
  signal: "bullish",
  symbol: "SPX",
  price: 7720.5,
  bar_time: "2026-10-06T14:40:00Z",
  interval: "5",
};

beforeEach(() => {
  resetAutomationStores();
});

describe("POST /api/webhook/tradingview", () => {
  it("#9 returns 401 and stores only a rejected log row on a wrong secret", async () => {
    const res = await POST(makeRequest({ ...validBody, secret: "wrong-secret" }));
    expect(res.status).toBe(401);

    const signals = signalsStore.all();
    expect(signals).toHaveLength(1);
    expect(signals[0].status).toBe("rejected");
    expect(signals[0].rejectReason).toBe("bad_secret");
    expect(JSON.stringify(signals[0].raw)).not.toContain("wrong-secret");
  });

  it("returns 401 and logs a rejection when the secret is missing entirely", async () => {
    const { secret: _secret, ...withoutSecret } = validBody;
    const res = await POST(makeRequest(withoutSecret));
    expect(res.status).toBe(401);
    expect(signalsStore.all()).toHaveLength(1);
  });

  it("returns 400 and stores nothing on a malformed (non-JSON) body", async () => {
    const req = new NextRequest("http://localhost/api/webhook/tradingview", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(signalsStore.all()).toHaveLength(0);
  });

  it("returns 400 for an unknown signal value, after the secret has already been checked", async () => {
    const res = await POST(makeRequest({ ...validBody, signal: "sideways" }));
    expect(res.status).toBe(400);
  });

  it("accepts a valid, correctly-authenticated signal and responds quickly", async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    const signals = signalsStore.query((s) => s.botId === TEST_BOT_ID);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ status: "accepted", signal: "bullish", barTime: validBody.bar_time });
  });

  it("returns 400 for a bot that doesn't exist and logs it as unknown_bot", async () => {
    const res = await POST(makeRequest({ ...validBody, bot: "xyz_bot" }));
    expect(res.status).toBe(400);
    expect(signalsStore.all()[0]).toMatchObject({ status: "rejected", rejectReason: "unknown_bot" });
  });

  it("routes the NDX alert (bot ndx_ema_bias, symbol NDX) to the NDX bot only", async () => {
    // The body is the TradingView alert message from the NDX addendum, field for field.
    const res = await POST(makeRequest({ secret: "test-secret", bot: NDX_BOT_ID, signal: "bearish", symbol: "NDX", price: 21003.7, bar_time: "2026-10-06T14:40:00Z", interval: "5" }));
    expect(res.status).toBe(200);
    expect(signalsStore.query((s) => s.botId === NDX_BOT_ID)).toHaveLength(1);
    expect(signalsStore.query((s) => s.botId === TEST_BOT_ID)).toHaveLength(0);
    expect(signalsStore.all()[0].raw).toMatchObject({ symbol: "NDX" });
  });
});
