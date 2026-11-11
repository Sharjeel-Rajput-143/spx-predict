import { describe, expect, it } from "vitest";
import { API_KEY, API_SECRET, FakeBybit } from "../../src/lib/automation/bybitTestSupport.ts";
import { runHold } from "./hold-trade.mjs";

const env = { BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET, POSITION_SIZE: "0.001", STOP_LOSS_PERCENT: "0.3", TAKE_PROFIT_PERCENT: "0.6" };
const text = (r) => r.lines.join("\n");

describe("holding a demo trade open", () => {
  it("opens one order with its stops, shows it, then closes it reduce only and shows Bybit's closed PnL", async () => {
    const b = new FakeBybit();
    const r = await runHold({ env, fetch: b.fetch, seconds: 1, sleepMs: 0 });
    expect(r.ok).toBe(true);
    expect(b.created.map((c) => [c.params.side, c.params.reduceOnly ?? false])).toEqual([["Buy", false], ["Sell", true]]);
    expect(b.created[0].params).toMatchObject({ qty: "0.001", stopLoss: "75772.0", takeProfit: "76456.0", tpslMode: "Full" });
    expect(text(r)).toMatch(/OPENED.*automation\/bybit/);
    expect(text(r)).toMatch(/long 0.001 entry 76000 mark 76000 unrealised P\/L/);
    expect(text(r)).toMatch(/CLOSED \(reduce only\)/);
    expect(text(r)).toMatch(/Bybit's closed profit and loss: -?\d/);
    expect(b.position.size).toBe(0);
  });

  it("a short, mirrored", async () => {
    const b = new FakeBybit();
    await runHold({ env, fetch: b.fetch, seconds: 1, sleepMs: 0, side: "short" });
    expect(b.created[0].params).toMatchObject({ side: "Sell", stopLoss: "76228.0", takeProfit: "75544.0" });
    expect(b.created[1].params).toMatchObject({ side: "Buy", reduceOnly: true });
  });

  it("refuses, sending nothing, with a setting missing, a non-demo host, or something already held", async () => {
    const b = new FakeBybit();
    await expect(runHold({ env: { ...env, STOP_LOSS_PERCENT: "" }, fetch: b.fetch })).rejects.toThrow(/Missing settings: STOP_LOSS_PERCENT/);
    await expect(runHold({ env: { ...env, BYBIT_API_BASE: "https://api.bybit.com" }, fetch: b.fetch })).rejects.toThrow(/only ever talks to/);
    b.hold(0.002);
    await expect(runHold({ env, fetch: b.fetch })).rejects.toThrow(/already holds a position/);
    expect(b.created).toHaveLength(0);
  });

  it("if a stop fires while it is held it says so and sends no close", async () => {
    const b = new FakeBybit();
    const r = await runHold({ env, fetch: b.fetch, seconds: 1, sleepMs: 0, onClose: () => b.movePrice(75_000) });
    expect(r.ok).toBe(true);
  });

  it("never prints the key or the secret", async () => {
    const b = new FakeBybit();
    b.overrides.set("/v5/position/list", () => ({ ok: false, status: 401, text: async () => `bad ${API_KEY} ${API_SECRET}` }));
    await expect(runHold({ env, fetch: b.fetch })).rejects.toThrow(/refused/);
    try {
      await runHold({ env, fetch: b.fetch });
    } catch (e) {
      expect(String(e)).not.toContain(API_KEY);
      expect(String(e)).not.toContain(API_SECRET);
    }
  });
});
