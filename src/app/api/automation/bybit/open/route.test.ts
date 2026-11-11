import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord, BTC_BOT_ID } from "@/lib/automation/bots";
import { positionsStore, signalsStore } from "@/lib/automation/store";
import { resetAutomationStores, setNdxTestEnv } from "@/lib/automation/testSupport";
import { POST } from "./route";

// The DEMO page's Open UP / Open DOWN route: signed in only, a plain-words refusal, and it can never be pointed at the live bot.

setNdxTestEnv();
const post = (body: unknown) => new NextRequest("http://localhost/api/automation/bybit/open", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(BTC_BOT_ID);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/automation/bybit/open", () => {
  it("answers 401 to someone who is not signed in, and opens nothing", async () => {
    vi.stubEnv("APP_LOGIN_PASSWORD", "x-not-a-real-password");
    const res = await POST(post({ direction: "up" }) as never);
    expect(res.status).toBe(401);
    expect(signalsStore.query(() => true)).toHaveLength(0);
    expect(positionsStore.query(() => true)).toHaveLength(0);
  });
  it("refuses a bad direction with a sentence, and a body that is not JSON", async () => {
    const res = await POST(post({ direction: "sideways" }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/up.*down/);
    expect((await POST(post("not json") as never)).status).toBe(400);
    expect(signalsStore.query(() => true)).toHaveLength(0);
  });
  it("takes no bot id from the caller: the route is the demo bot's only (a bot named in the body is ignored)", async () => {
    await POST(post({ direction: "up", bot: "btc_bybit_live", botId: "btc_bybit_live", confirm: true }) as never);
    expect(signalsStore.query((s) => s.botId === "btc_bybit_live")).toHaveLength(0);
    expect(positionsStore.query((p) => p.botId === "btc_bybit_live")).toHaveLength(0);
  });
});
