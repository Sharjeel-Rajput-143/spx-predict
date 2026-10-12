import { describe, expect, it, vi } from "vitest";
import { MAX_DAYS, hindsight } from "./hindsight";
import { buildPosition } from "./testSupport";
import type { Position } from "./types";

// Put spread 20,970 / 20,960, 4.00 credit, one contract: held to expiry it keeps $400 above 20,970, loses $1 per point of 1
// below it, and $600 at most. A call spread 21,035 / 21,045 at 3.50 credit mirrors that.

const NOW = Date.UTC(2026, 9, 9, 22, 0); // Friday 9 October 2026, 6pm New York: the day's close is final
let n = 0;
const put = (expiry: string, actual: { credit: number; closePrice: number }, over: Partial<Position> = {}) =>
  buildPosition({ id: `h${++n}`, botId: "b", underlying: "NDX", type: "short_put_spread", status: "closed", shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 1, filledQuantity: 1, expiry, ...actual, ...over });
const closes = (map: Record<string, number | null>) => vi.fn(async (_s: string, d: string) => map[d] ?? null);

describe("held to expiry against what it really made", () => {
  it("a position closed at a loss that would have won held to the close: holding was better", async () => {
    const r = await hindsight([put("2026-10-08", { credit: 4, closePrice: 7 })], NOW, closes({ "2026-10-08": 21_100 }));
    expect(r.rows).toEqual([{ id: expect.any(String), actual: -300, held: 400 }]);
    expect(r).toMatchObject({ compared: 1, unknown: 0, actualTotal: -300, heldTotal: 400, difference: 700, betterHeld: 1, worseHeld: 0 });
  });

  it("a position closed for a profit that would have lost: holding was worse", async () => {
    const r = await hindsight([put("2026-10-08", { credit: 4, closePrice: 1 })], NOW, closes({ "2026-10-08": 20_965 })); // 5 through: (4 - 5) x 100
    expect(r.rows[0]).toMatchObject({ actual: 300, held: -100 });
    expect(r).toMatchObject({ difference: -400, betterHeld: 0, worseHeld: 1 });
  });

  it("the loss is capped at the width, and a call spread works the other way", async () => {
    const r = await hindsight(
      [put("2026-10-08", { credit: 4, closePrice: 2 }), put("2026-10-07", { credit: 3.5, closePrice: 1 }, { type: "short_call_spread", shortStrike: 21_035, longStrike: 21_045 })],
      NOW,
      closes({ "2026-10-08": 20_000, "2026-10-07": 21_300 }),
    );
    expect(r.rows.map((x) => x.held)).toEqual([-600, -650]); // 10 - 4 and 10 - 3.5, x 100
    expect(r.heldTotal).toBe(-1250);
  });

  it("with two contracts every dollar doubles", async () => {
    const r = await hindsight([put("2026-10-08", { credit: 4, closePrice: 1 }, { requestedQuantity: 2, filledQuantity: 2 })], NOW, closes({ "2026-10-08": 21_100 }));
    expect(r.rows[0]).toMatchObject({ actual: 600, held: 800 });
  });
});

describe("what is not worked out", () => {
  it("a day with no closing price and an expiry whose close isn't final yet are counted as unknown, never guessed; a position with no credit has nothing to compare", async () => {
    const todayBefore = Date.UTC(2026, 9, 9, 18, 0); // 2pm New York: today's close is not final
    const a = await hindsight([put("2026-10-08", { credit: 4, closePrice: 1 })], NOW, closes({}));
    expect(a).toMatchObject({ compared: 0, unknown: 1, difference: 0 });
    const b = await hindsight([put("2026-10-08", { credit: 4, closePrice: 1 }, { credit: null })], NOW, closes({ "2026-10-08": 21_000 }));
    expect(b.rows).toEqual([]); // no credit means no result of its own to compare
    const c = await hindsight([put("2026-10-09", { credit: 4, closePrice: 1 })], todayBefore, closes({ "2026-10-09": 21_000 }));
    expect(c.rows[0].held).toBeNull();
    const d = await hindsight([put("2026-10-09", { credit: 4, closePrice: 1 })], NOW, closes({ "2026-10-09": 21_000 })); // after 4:30pm: final
    expect(d.rows[0].held).toBe(400);
  });

  it("only positions closed by a close order are compared: open, expired and refused ones are not", async () => {
    const r = await hindsight([put("2026-10-08", { credit: 4, closePrice: 1 }, { status: "open" }), put("2026-10-08", { credit: 4, closePrice: 1 }, { status: "expired" }), put("2026-10-08", { credit: 4, closePrice: 1 }, { status: "rejected" })], NOW, closes({ "2026-10-08": 21_000 }));
    expect(r.rows).toEqual([]);
  });

  it("a position closed with no price of its own has no actual result to compare", async () => {
    const r = await hindsight([put("2026-10-08", { credit: 4, closePrice: 1 }, { closePrice: null })], NOW, closes({ "2026-10-08": 21_000 }));
    expect(r.rows).toEqual([]);
  });

  it("looks each day up once, at the same time, and at most 30 days (the newest)", async () => {
    const many = Array.from({ length: 40 }, (_, i) => put(`2026-09-${String(1 + (i % 28)).padStart(2, "0")}`, { credit: 4, closePrice: 1 }, { expiry: `2026-${i < 28 ? "08" : "07"}-${String(1 + (i % 28)).padStart(2, "0")}` }));
    const lookup = closes({});
    await hindsight([...many, ...many], NOW, lookup);
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(MAX_DAYS);
    expect(new Set(lookup.mock.calls.map((c) => c[1])).size).toBe(lookup.mock.calls.length);
  });

  it("a lookup that fails is just an unknown day", async () => {
    const r = await hindsight([put("2026-10-08", { credit: 4, closePrice: 1 })], NOW, async () => Promise.reject(new Error("x")));
    expect(r.unknown).toBe(1);
  });
});
