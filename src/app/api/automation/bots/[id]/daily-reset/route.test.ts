import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BTC_BOT_ID, ensureBotRecord } from "@/lib/automation/bots";
import { LIVE_BOT_ID } from "@/lib/automation/bybitLiveLimits";
import { botsStore } from "@/lib/automation/store";
import { resetAutomationStores, setNdxTestEnv } from "@/lib/automation/testSupport";
import { POST } from "./route";

// "Reset daily counter": works for the demo bot, refused for the live bot with a sentence, and changes nothing there.

setNdxTestEnv();
const req = () => new NextRequest("http://localhost/api/automation/bots/x/daily-reset", { method: "POST" });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(BTC_BOT_ID);
  ensureBotRecord(LIVE_BOT_ID);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/automation/bots/[id]/daily-reset", () => {
  it("the live bot: refused (409) with a plain sentence, and nothing is stored", async () => {
    const res = await POST(req() as never, ctx(LIVE_BOT_ID) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The live bot's trades-a-day count cannot be reset. It restarts by itself on the next New York day.");
    expect(botsStore.get(LIVE_BOT_ID)?.dailyResetAt).toBeUndefined();
  });
  it("the demo bot: unchanged, the reset moment is stored", async () => {
    const res = await POST(req() as never, ctx(BTC_BOT_ID) as never);
    expect(res.status).toBe(200);
    expect(botsStore.get(BTC_BOT_ID)?.dailyResetAt).toBeGreaterThan(0);
    expect(botsStore.get(LIVE_BOT_ID)?.dailyResetAt).toBeUndefined(); // and never the live bot's
  });
  it("an unknown bot is 404, and someone not signed in is 401 with nothing changed", async () => {
    expect((await POST(req() as never, ctx("nobody") as never)).status).toBe(404);
    vi.stubEnv("APP_LOGIN_PASSWORD", "x-not-a-real-password");
    expect((await POST(req() as never, ctx(BTC_BOT_ID) as never)).status).toBe(401);
    expect(botsStore.get(BTC_BOT_ID)?.dailyResetAt).toBeUndefined();
  });
});
