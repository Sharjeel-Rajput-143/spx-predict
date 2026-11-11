import { describe, expect, it } from "vitest";
import { FakeBybit, API_KEY, API_SECRET } from "../../src/lib/automation/bybitTestSupport.ts";
import { blank, parseBybitEnv, runCheck } from "./check.mjs";

const env = { BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET, POSITION_SIZE: "0.001", STOP_LOSS_PERCENT: "1", TAKE_PROFIT_PERCENT: "2" };
const text = (r) => r.lines.join("\n");

describe("the Bybit connection check", () => {
  it("read-only: reads the clock, limits, price, balance, position and lists, and sends no order", async () => {
    const b = new FakeBybit();
    const r = await runCheck({ env, fetch: b.fetch, sleepMs: 0 });
    expect(r.ok).toBe(true);
    expect(text(r)).toMatch(/PASS .*server time/);
    expect(text(r)).toMatch(/min qty 0.001, step 0.001, min order value 5; your size 0.001 is worth about 76.00 USDT at 76000/);
    expect(text(r)).toMatch(/PASS .*wallet balance/);
    expect(b.created).toHaveLength(0);
    expect(text(r)).toMatch(/All calls passed/);
  });

  it("prints plain HELD POSITIONS / OPEN ORDERS lines from the full reply (the release tool reads them to decide the account is flat)", async () => {
    const b = new FakeBybit();
    const flat = text(await runCheck({ env, fetch: b.fetch, sleepMs: 0 }));
    expect(flat).toMatch(/HELD POSITIONS: 0/);
    expect(flat).toMatch(/OPEN ORDERS: 0/);
    b.hold(0.001);
    const held = text(await runCheck({ env, fetch: b.fetch, sleepMs: 0 }));
    expect(held).toMatch(/HELD POSITIONS: 1/);
  });

  it("--trade opens one small order, reads it back, closes it reduce only, shows both order ids and Bybit's closed PnL", async () => {
    const b = new FakeBybit();
    const r = await runCheck({ env, fetch: b.fetch, trade: true, sleepMs: 0 });
    expect(r.ok).toBe(true);
    expect(b.created.map((c) => [c.params.side, c.params.qty, c.params.reduceOnly ?? false])).toEqual([["Buy", "0.001", false], ["Sell", "0.001", true]]);
    expect(b.created[0].params).toMatchObject({ stopLoss: "75240.0", takeProfit: "77520.0", tpslMode: "Full" });
    expect(text(r)).toMatch(/stops on the position at Bybit: stop loss 75240, take profit 77520/);
    expect(text(r)).toMatch(/ORDER ID \(open\): 1001/);
    expect(text(r)).toMatch(/ORDER ID \(close\): 1002/);
    expect(text(r)).toMatch(/status Filled, filled 0.001 at average 76000/);
    expect(text(r)).toMatch(/flat again/);
    expect(text(r)).toMatch(/closed PnL for the close order: -?\d/);
    expect(b.position.size).toBe(0);
  });

  it("--trade refuses, sending nothing, unless the position size and both percents are set (they have no defaults)", async () => {
    const b = new FakeBybit();
    await expect(runCheck({ env: { BYBIT_DEMO_API_KEY: API_KEY, BYBIT_DEMO_API_SECRET: API_SECRET }, fetch: b.fetch, trade: true, sleepMs: 0 })).rejects.toThrow(/POSITION_SIZE, STOP_LOSS_PERCENT, TAKE_PROFIT_PERCENT must be set/);
    expect(b.calls).toEqual([]);
  });

  it("an empty demo account is called out, and --trade sends no order into it", async () => {
    const b = new FakeBybit();
    b.equity = "0";
    const r = await runCheck({ env, fetch: b.fetch, sleepMs: 0 });
    expect(text(r)).toMatch(/PROBLEM: the demo account has NO FUNDS.*retCode 110007/);
    await expect(runCheck({ env, fetch: b.fetch, trade: true, sleepMs: 0 })).rejects.toThrow(/no funds \(equity 0\).*Nothing was sent/);
    expect(b.created).toHaveLength(0);
  });

  it("--trade refuses, sending nothing, when the demo account already holds something", async () => {
    const b = new FakeBybit();
    b.hold(0.005);
    await expect(runCheck({ env, fetch: b.fetch, trade: true, sleepMs: 0 })).rejects.toThrow(/already holds Buy 0.005 BTCUSDT/);
    expect(b.created).toHaveLength(0);
  });

  it("a call the demo does not support is reported as FAILED with Bybit's own words, and the rest still runs", async () => {
    const b = new FakeBybit();
    b.closedPnlSupported = false;
    const r = await runCheck({ env, fetch: b.fetch, sleepMs: 0 });
    expect(r.ok).toBe(false);
    expect(text(r)).toMatch(/FAILED .*GET \/v5\/position\/closed-pnl/);
    expect(text(r)).toMatch(/FAILED .*closed profit and loss - HTTP 200, retCode 10001: This endpoint is not supported on demo trading/);
    expect(text(r)).toMatch(/PASS .*wallet balance/);
  });

  it("if the close fails it says in capitals that a position is still open, and how to close it", async () => {
    const b = new FakeBybit();
    // Let the open through, then refuse every reduce-only order.
    const real = b.fetch;
    b.fetch = async (url, init) => {
      if (init.method === "POST" && JSON.parse(init.body).reduceOnly === true) return { ok: true, status: 200, text: async () => JSON.stringify({ retCode: 110017, retMsg: "Reduce-only rule not satisfied", result: {} }) };
      return real(url, init);
    };
    const r = await runCheck({ env, fetch: b.fetch, trade: true, sleepMs: 0 });
    expect(r.ok).toBe(false);
    expect(text(r)).toMatch(/A SMALL BTCUSDT POSITION IS STILL OPEN/);
    expect(text(r)).toMatch(/retCode 110017: Reduce-only rule not satisfied/);
  });

  it("refuses a missing key, and any host but the demo one, before sending anything", async () => {
    const b = new FakeBybit();
    await expect(runCheck({ env: {}, fetch: b.fetch })).rejects.toThrow(/Missing settings: BYBIT_DEMO_API_KEY, BYBIT_DEMO_API_SECRET/);
    await expect(runCheck({ env: { ...env, BYBIT_API_BASE: "https://api.bybit.com" }, fetch: b.fetch })).rejects.toThrow(/DEMO host/);
    expect(b.calls).toEqual([]);
  });

  it("never prints the key or the secret, even when Bybit's reply echoes them", async () => {
    const b = new FakeBybit();
    b.overrides.set("/v5/position/list", () => ({ ok: false, status: 401, text: async () => `bad key ${API_KEY} and ${API_SECRET}` }));
    const r = await runCheck({ env, fetch: b.fetch, sleepMs: 0 });
    expect(text(r)).not.toContain(API_KEY);
    expect(text(r)).not.toContain(API_SECRET);
    expect(text(r)).toContain("***");
  });

  it("reads only the BYBIT_ names out of an env file", () => {
    const out = parseBybitEnv('# c\nAPP_LOGIN_PASSWORD=hunter2\nBYBIT_DEMO_API_KEY="abc123"\nexport POSITION_SIZE=0.002 # small\nDAILY_MAX_LOSS_USD=25\nOTHER=1\n');
    expect(out).toEqual({ BYBIT_DEMO_API_KEY: "abc123", POSITION_SIZE: "0.002", DAILY_MAX_LOSS_USD: "25" });
    expect(blank("a secret-1234 b", ["secret-1234", "ab"])).toBe("a *** b");
  });
});
