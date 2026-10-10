import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord } from "@/lib/automation/bots";
import { __resetSweepState } from "@/lib/automation/eodSweep";
import { __resetSettleAttempts } from "@/lib/automation/settleExpired";
import { positionsStore } from "@/lib/automation/store";
import { NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "@/lib/automation/testSupport";

// No live feed and no network: the day's close is given by the test.
vi.mock("@/lib/marketData/tickStore", () => ({ waitForTick: async () => null, getLastTick: () => null, isLiveSymbol: () => false }));
vi.mock("@/lib/marketData/yahooFinance", () => ({ fetchYahooDailyClose: async () => 30_969, fetchYahooFinancePrice: async () => null, YAHOO_CODES: {} }));

const { GET } = await import("./route");

setTestBotEnv();
setNdxTestEnv();

const call = (authorization?: string) => GET(new NextRequest("http://localhost/api/cron/sweep", { headers: authorization ? { authorization } : {} }));

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  __resetSweepState();
  __resetSettleAttempts();
  ensureBotRecord(NDX_BOT_ID);
  vi.stubEnv("CRON_SECRET", "s3cret-value");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-08T21:30:00Z")); // 5:30pm in New York, after the close
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const hold = () => positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", type: "short_call_spread", status: "open", shortStrike: 30_970, longStrike: 30_980, requestedQuantity: 1, filledQuantity: 1, credit: 3.5, expiry: "2026-10-08" }));

describe("the end-of-day job for a host that doesn't stay running", () => {
  it("is switched off with no CRON_SECRET, and refuses a wrong or missing one", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer anything")).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "s3cret-value");
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call("s3cret-value")).status).toBe(401);
  });

  it("with the secret, expires what the bot still holds and settles it from the day's close", async () => {
    const p = hold();
    const res = await call("Bearer s3cret-value");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.swept).toContain(NDX_BOT_ID);
    const after = positionsStore.get(p.id)!;
    expect(after.status).toBe("expired");
    expect(after.settlement).toMatchObject({ kind: "estimated", pl: 350, underlyingPrice: 30_969 });
  });

  it("does nothing before the bot's sweep time, and a refused call touches nothing", async () => {
    const p = hold();
    await call("Bearer wrong");
    expect(positionsStore.get(p.id)!.status).toBe("open");
    vi.setSystemTime(Date.parse("2026-10-08T18:00:00Z")); // 2pm in New York: the market is still open
    const res = await call("Bearer s3cret-value");
    expect((await res.json()).swept).toEqual([]);
    expect(positionsStore.get(p.id)!.status).toBe("open");
  });
});
