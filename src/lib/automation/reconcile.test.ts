import { beforeEach, describe, expect, it } from "vitest";
import { alertsStore, botsStore, decisionsStore, positionsStore } from "./store";
import { NDX_BOT_ID, TEST_BOT_ID, buildPosition, resetAutomationStores } from "./testSupport";
import { flagMismatches, reconcile } from "./reconcile";
import type { BrokerExecutor, BrokerPosition } from "./types";

// Comparing our records with the broker's, on a fake broker. Nothing here makes a request.
const broker = (positions: BrokerPosition[]) => ({ listBrokerPositions: async () => positions }) as unknown as BrokerExecutor;
const open = (over: Parameters<typeof buildPosition>[0]) => buildPosition({ botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", requestedQuantity: 1, filledQuantity: 1, ...over });
const NDX_PUT = { type: "short_put_spread" as const, status: "open" as const, shortStrike: 20_970, longStrike: 20_960 };
const LEGS = [{ symbol: "NDXP261006P20970000", quantity: -1 }, { symbol: "NDXP261006P20960000", quantity: 1 }];

beforeEach(() => resetAutomationStores());

describe("reconcile", () => {
  it("agrees when the broker holds exactly the legs our open positions say", async () => {
    positionsStore.insert(open(NDX_PUT));
    expect(await reconcile(broker(LEGS))).toMatchObject({ ok: true, expectedLegs: 2, brokerLegs: 2, problems: [] });
  });

  it("nothing open and nothing held is fine", async () => {
    expect(await reconcile(broker([]))).toMatchObject({ ok: true, expectedLegs: 0, problems: [] });
  });

  it("a leg we expect that the broker doesn't hold", async () => {
    positionsStore.insert(open(NDX_PUT));
    const r = await reconcile(broker([LEGS[0]]));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.objectContaining({ kind: "missing_at_broker", symbol: "NDXP261006P20960000", expected: 1, actual: 0, botId: NDX_BOT_ID })]);
  });

  it("a different quantity, e.g. a partial fill we didn't record", async () => {
    positionsStore.insert(open({ ...NDX_PUT, requestedQuantity: 2, filledQuantity: 2 }));
    const r = await reconcile(broker(LEGS));
    expect(r.problems.map((p) => [p.kind, p.expected, p.actual])).toEqual([["quantity_mismatch", -2, -1], ["quantity_mismatch", 2, 1]]);
  });

  it("a position on a series we trade that none of our positions explains", async () => {
    positionsStore.insert(open(NDX_PUT));
    const r = await reconcile(broker([...LEGS, { symbol: "NDXP261006C21040000", quantity: -1 }]));
    expect(r.problems).toEqual([expect.objectContaining({ kind: "unknown_at_broker", symbol: "NDXP261006C21040000", actual: -1 })]);
  });

  it("legs still held for a position our records have closed are noticed, even with nothing open (a close that never completed at the broker)", async () => {
    positionsStore.insert(open({ ...NDX_PUT, status: "closed", closedAt: 1 }));
    const r = await reconcile(broker(LEGS));
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => [p.kind, p.symbol, p.actual])).toEqual([["unknown_at_broker", "NDXP261006P20970000", -1], ["unknown_at_broker", "NDXP261006P20960000", 1]]);
  });

  it("the legs of an order still in flight are not called unknown (the close or open is not finished yet)", async () => {
    positionsStore.insert(open({ ...NDX_PUT, status: "closing" }));
    expect(await reconcile(broker(LEGS))).toMatchObject({ ok: true, problems: [] });
    positionsStore.insert(open({ ...NDX_PUT, status: "opening", shortStrike: 20_950, longStrike: 20_940 }));
    expect(await reconcile(broker([...LEGS, { symbol: "NDXP261006P20950000", quantity: -1 }, { symbol: "NDXP261006P20940000", quantity: 1 }]))).toMatchObject({ ok: true });
  });

  it("a series no position of ours was ever on is still none of our business", async () => {
    positionsStore.insert(open({ ...NDX_PUT, status: "closed", closedAt: 1 }));
    expect((await reconcile(broker([{ symbol: "SPXW261006P07700000", quantity: -1 }]))).ok).toBe(true);
  });

  it("other things in the account - stocks, other series - are none of our business", async () => {
    positionsStore.insert(open(NDX_PUT));
    const r = await reconcile(broker([...LEGS, { symbol: "AAPL", quantity: 100 }, { symbol: "SPY261016C00500000", quantity: -1 }]));
    expect(r.ok).toBe(true);
  });

  it("two bots' positions add up per leg", async () => {
    positionsStore.insert(open(NDX_PUT));
    positionsStore.insert(open({ ...NDX_PUT, botId: TEST_BOT_ID }));
    const r = await reconcile(broker(LEGS));
    expect(r.problems.every((p) => p.kind === "quantity_mismatch" && p.expected === 2 * (p.actual ?? 0))).toBe(true);
  });

  it("a position with no option root recorded can't be matched, and says so", async () => {
    positionsStore.insert(open({ ...NDX_PUT, optionRoot: undefined }));
    expect((await reconcile(broker([]))).problems.map((p) => p.kind)).toEqual(["no_option_root"]);
  });

  it("an executor that can't list positions has nothing to compare", async () => {
    await expect(reconcile({} as BrokerExecutor)).rejects.toThrow(/no broker account/);
  });

  it("closed and opening positions are not expected at the broker", async () => {
    positionsStore.insert(open({ ...NDX_PUT, status: "closed" }));
    positionsStore.insert(open({ ...NDX_PUT, status: "opening", shortStrike: 20_900, longStrike: 20_890 }));
    expect((await reconcile(broker([]))).ok).toBe(true);
  });
});

describe("flagMismatches", () => {
  it("flags the bot, writes an error decision (so an Error alert), and trades nothing", async () => {
    positionsStore.insert(open(NDX_PUT));
    const before = positionsStore.all().map((p) => p.status);
    flagMismatches(await reconcile(broker([])));
    expect(botsStore.get(NDX_BOT_ID)).toMatchObject({ needsAttention: true });
    expect(botsStore.get(NDX_BOT_ID)?.needsAttentionReason).toMatch(/Broker position mismatch/);
    expect(decisionsStore.all().map((d) => d.outcome)).toEqual(["executor_error"]);
    expect(alertsStore.all().map((a) => a.kind)).toEqual(["error"]);
    expect(positionsStore.all().map((p) => p.status)).toEqual(before);
  });

  it("does nothing when everything agrees", async () => {
    positionsStore.insert(open(NDX_PUT));
    flagMismatches(await reconcile(broker(LEGS)));
    expect(decisionsStore.all()).toHaveLength(0);
  });
});
