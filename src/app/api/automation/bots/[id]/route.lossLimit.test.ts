import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord } from "@/lib/automation/bots";
import { botsStore, positionsStore } from "@/lib/automation/store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "@/lib/automation/testSupport";
import { GET, PATCH } from "./route";

// The bot's detail answer carries the daily loss limit and today's result for the Settings tab, and the Safeguards panel can save the limit.
setNdxTestEnv();
const ctx = { params: Promise.resolve({ id: NDX_BOT_ID }) };
const url = `http://localhost/api/automation/bots/${NDX_BOT_ID}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_NOW);
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(NDX_BOT_ID);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const closedToday = (credit: number, closePrice: number, closedAt = BASE_NOW - 3_600_000) =>
  positionsStore.insert(buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "closed", requestedQuantity: 1, filledQuantity: 1, credit, closePrice, closedAt }));

describe("GET: the limit and today's result", () => {
  it("off by default, with today's realized result", async () => {
    closedToday(3, 5);
    const body = await (await GET(new NextRequest(url), ctx)).json();
    expect(body.limits.dailyLossLimit).toBe(0);
    expect(body.dayLoss).toEqual({ limit: 0, realized: -200, closedToday: 1, unpriced: 0, lastCheck: null });
  });

  it("with a limit set: the limit, and the last evaluation of today (an evaluation from another day is not shown)", async () => {
    botsStore.update(NDX_BOT_ID, { safeguards: { dailyLossLimit: 150 } });
    const snap = { at: BASE_NOW - 600_000, limit: 150, realized: -200, openLoss: null, openLossWhy: "no mark", total: -200, hit: true, closedToday: 1, unpriced: 0 };
    botsStore.update(NDX_BOT_ID, { lossCheck: snap });
    const today = await (await GET(new NextRequest(url), ctx)).json();
    expect(today.limits.dailyLossLimit).toBe(150);
    expect(today.dayLoss.lastCheck).toMatchObject({ hit: true, openLoss: null });
    botsStore.update(NDX_BOT_ID, { lossCheck: { ...snap, at: BASE_NOW - 24 * 3_600_000 } });
    const stale = await (await GET(new NextRequest(url), ctx)).json();
    expect(stale.dayLoss.lastCheck).toBeNull();
  });

  it("DAILY_LOSS_LIMIT is the default the answer shows", async () => {
    vi.stubEnv("DAILY_LOSS_LIMIT", "75");
    const body = await (await GET(new NextRequest(url), ctx)).json();
    expect(body.limits.dailyLossLimit).toBe(75);
    expect(body.dayLoss.limit).toBe(75);
  });
});

describe("PATCH: the Safeguards panel saves the limit", () => {
  const patch = (body: unknown) => PATCH(new NextRequest(url, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), ctx);

  it("saves a limit (and 0 for off), and refuses a negative or a non-number", async () => {
    expect((await patch({ safeguards: { dailyLossLimit: 25 } })).status).toBe(200);
    expect(botsStore.get(NDX_BOT_ID)?.safeguards?.dailyLossLimit).toBe(25);
    expect((await patch({ safeguards: { dailyLossLimit: 0 } })).status).toBe(200);
    expect(botsStore.get(NDX_BOT_ID)?.safeguards?.dailyLossLimit).toBe(0);
    for (const bad of [-5, null, "abc"]) {
      const res = await patch({ safeguards: { dailyLossLimit: bad } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Daily loss limit/);
    }
    expect(botsStore.get(NDX_BOT_ID)?.safeguards?.dailyLossLimit).toBe(0);
  });
});
