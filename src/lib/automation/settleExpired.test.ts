import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchYahooDailyClose } from "@/lib/marketData/yahooFinance";
import { positionPL, positionPLKind } from "./pnl";
import { __resetSettleAttempts, settleExpiredFromClose } from "./settleExpired";
import { positionsStore } from "./store";
import type { Position } from "./types";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";

setTestBotEnv();
setNdxTestEnv();

const DAY = 86_400_000;
const expired = (over: Partial<Position> = {}) =>
  positionsStore.insert(buildPosition({ type: "short_call_spread", status: "expired", botId: NDX_BOT_ID, underlying: "NDX", shortStrike: 30_970, longStrike: 30_980, requestedQuantity: 1, filledQuantity: 1, credit: 3.5, expiry: "2026-10-08", ...over }));

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  __resetSettleAttempts();
});

describe("settling an expired position from the day's close", () => {
  it("works the result out from the closing price: a call spread that finished out of the money keeps its whole credit", async () => {
    const p = expired();
    const lookup = vi.fn(async () => 30_969);
    expect(await settleExpiredFromClose({ now: BASE_NOW + 3 * DAY, lookup })).toBe(1);
    expect(lookup).toHaveBeenCalledWith("NDX", "2026-10-08");
    const after = positionsStore.get(p.id)!;
    expect(after.settlement).toMatchObject({ kind: "estimated", pl: 350, underlyingPrice: 30_969 });
    expect(after.underlyingAtClose).toBe(30_969);
    expect(positionPL(after)).toBe(350);
    expect(positionPLKind(after)).toBe("estimated");
  });

  it("a spread that finished in the money loses by how far, up to its width", async () => {
    const p = expired();
    await settleExpiredFromClose({ now: BASE_NOW + 3 * DAY, lookup: async () => 30_975 }); // 5 points in the money: -5 + 3.5 credit = -1.5 x 100
    expect(positionsStore.get(p.id)!.settlement?.pl).toBe(-150);
    const q = expired({ shortStrike: 30_900, longStrike: 30_910 });
    await settleExpiredFromClose({ now: BASE_NOW + 3 * DAY, lookup: async () => 31_500 }); // past the long strike: the full loss, 10 - 3.5
    expect(positionsStore.get(q.id)!.settlement?.pl).toBe(-650);
  });

  it("looks the closing price up once per symbol and day, however many positions share it", async () => {
    expired();
    expired({ shortStrike: 31_100, longStrike: 31_110 });
    const lookup = vi.fn(async () => 30_969);
    expect(await settleExpiredFromClose({ now: BASE_NOW + 3 * DAY, lookup })).toBe(2);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("leaves alone a position that already has a result (a person's too), today's, one with no credit, and any that isn't expired", async () => {
    expired({ settlement: { kind: "manual", pl: 123, at: BASE_NOW } });
    expired({ expiry: "2026-10-12" }); // expires on the day we are on: its close isn't final
    expired({ credit: null });
    expired({ status: "open" });
    const lookup = vi.fn(async () => 30_969);
    expect(await settleExpiredFromClose({ now: BASE_NOW + 4 * DAY, lookup })).toBe(0);
    expect(positionsStore.all().filter((p) => p.settlement?.kind === "manual")).toHaveLength(1);
    expect(positionsStore.all().filter((p) => p.settlement?.kind === "estimated")).toHaveLength(0);
  });

  it("with no closing price there is no result: nothing is guessed, and it isn't retried at once", async () => {
    const p = expired();
    const lookup = vi.fn(async () => null);
    expect(await settleExpiredFromClose({ now: BASE_NOW + 3 * DAY, lookup })).toBe(0);
    expect(positionsStore.get(p.id)!.settlement).toBeUndefined();
    await settleExpiredFromClose({ now: BASE_NOW + 3 * DAY + 60_000, lookup });
    expect(lookup).toHaveBeenCalledTimes(1);
    await settleExpiredFromClose({ now: BASE_NOW + 3 * DAY + 11 * 60_000, lookup: async () => 30_969 });
    expect(positionsStore.get(p.id)!.settlement?.pl).toBe(350);
  });

  it("a lookup that throws is no result either", async () => {
    expired();
    expect(await settleExpiredFromClose({ now: BASE_NOW + 3 * DAY, lookup: async () => Promise.reject(new Error("offline")) })).toBe(0);
  });
});

describe("the closing price itself", () => {
  const bars = (days: { date: string; close: number | null }[]) => ({
    ok: true,
    json: async () => ({ chart: { result: [{ timestamp: days.map((d) => Date.parse(`${d.date}T13:30:00Z`) / 1000), indicators: { quote: [{ close: days.map((d) => d.close) }] } }] } }),
  });

  it("picks the bar of that New York day", async () => {
    const fetcher = vi.fn(async () => bars([{ date: "2026-10-07", close: 30_900 }, { date: "2026-10-08", close: 30_969.44 }])) as unknown as typeof fetch;
    expect(await fetchYahooDailyClose("NDX", "2026-10-08", fetcher)).toBe(30_969.44);
    expect(await fetchYahooDailyClose("NDX", "2026-10-09", fetcher)).toBeNull(); // not among the bars
  });

  it("is null for an unknown symbol, a bar with no close, or a failed request", async () => {
    expect(await fetchYahooDailyClose("ZZZ", "2026-10-08")).toBeNull();
    expect(await fetchYahooDailyClose("NDX", "2026-10-08", (async () => bars([{ date: "2026-10-08", close: null }])) as unknown as typeof fetch)).toBeNull();
    expect(await fetchYahooDailyClose("NDX", "2026-10-08", (async () => ({ ok: false })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchYahooDailyClose("NDX", "2026-10-08", (async () => Promise.reject(new Error("x"))) as unknown as typeof fetch)).toBeNull();
  });
});
