import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { positionsStore } from "@/lib/automation/store";
import { buildPosition, resetAutomationStores } from "@/lib/automation/testSupport";
import { POST } from "./route";

const call = (body: unknown) => POST(new NextRequest("http://localhost/api/automation/analyze/hindsight", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } }));

beforeEach(() => resetAutomationStores());
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/automation/analyze/hindsight", () => {
  it("refuses a body that isn't a list of ids", async () => {
    expect((await call("not json")).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect((await call({ ids: "p1" })).status).toBe(400);
    expect((await call({ ids: [1, 2] })).status).toBe(400);
    expect((await call({ ids: Array.from({ length: 10_001 }, (_, i) => `p${i}`) })).status).toBe(400);
  });

  it("works out what holding would have made, from the day's close, for the positions asked about only", async () => {
    positionsStore.insert(buildPosition({ id: "mine", botId: "b", underlying: "NDX", type: "short_put_spread", status: "closed", shortStrike: 20_970, longStrike: 20_960, credit: 4, closePrice: 7, requestedQuantity: 1, filledQuantity: 1, expiry: "2020-01-02" }));
    positionsStore.insert(buildPosition({ id: "other", botId: "b", underlying: "NDX", type: "short_put_spread", status: "closed", shortStrike: 20_970, longStrike: 20_960, credit: 4, closePrice: 1, expiry: "2020-01-02" }));
    const day = Date.UTC(2020, 0, 2, 14, 30) / 1000;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ chart: { result: [{ timestamp: [day], indicators: { quote: [{ close: [21_100] }] } }] } }) })));
    const res = await call({ ids: ["mine"] });
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.rows).toEqual([{ id: "mine", actual: -300, held: 400 }]);
    expect(report).toMatchObject({ compared: 1, difference: 700, betterHeld: 1 });
  });

  it("a price service that is down leaves the positions as unknown, and still answers", async () => {
    positionsStore.insert(buildPosition({ id: "mine", botId: "b", underlying: "NDX", type: "short_put_spread", status: "closed", credit: 4, closePrice: 7, expiry: "2020-01-02" }));
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    const res = await call({ ids: ["mine"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ compared: 0, unknown: 1 });
  });
});
