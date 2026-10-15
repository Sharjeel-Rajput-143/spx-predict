import { afterEach, describe, expect, it, vi } from "vitest";

describe("tickStore Google -> Yahoo fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("serves a tick from Yahoo when Google Finance keeps failing to parse", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("google.com/finance")) {
        // Empty body -> parsePrice() finds nothing -> fetchGoogleFinancePrice
        // retries once (cookie-jar refresh) and then gives up, per its own contract.
        return new Response("<html></html>", { status: 200 });
      }
      if (url.includes("query1.finance.yahoo.com")) {
        return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 123.45 } }] } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getLastTick, getFeedStatus } = await import("./tickStore");

    // The first poll is fire-and-forget (startPolling doesn't await it), so
    // give the microtask/macrotask queue a few turns to let it (and
    // Google's internal cookie-retry) settle before asserting.
    let tick = getLastTick("SPX");
    for (let i = 0; i < 100 && tick == null; i++) {
      await new Promise((r) => setTimeout(r, 20));
      tick = getLastTick("SPX");
    }

    expect(tick?.price).toBe(123.45);
    const status = getFeedStatus("SPX");
    expect(status.source).toBe("yahoo");
    expect(status.healthy).toBe(true);

    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("google.com/finance"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("query1.finance.yahoo.com"))).toBe(true);
  });
});

// A price lookup on a cold serverless instance: both sources at once, short limits, and never a stale price when a fresh one can be had.
describe("the live price lookup", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const googleBody = (price: string) => `<html><div class="gO24Ff">x</div><div jsname="Pdsbrc"><span>$${price}</span></div></html>`;
  const yahooBody = (price: number) => JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: price } }] } });
  /** Stubs both sources: how long each takes and what it says (null = a page with no price). */
  const feeds = (google: { ms: number; price: string | null }, yahoo: { ms: number; price: number | null }) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("google.com/finance")) {
        calls.push("google");
        await sleep(google.ms);
        return new Response(google.price ? googleBody(google.price) : "<html></html>", { status: 200 });
      }
      calls.push("yahoo");
      await sleep(yahoo.ms);
      return yahoo.price ? new Response(yahooBody(yahoo.price), { status: 200 }) : new Response("no", { status: 500 });
    }));
    return calls;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.useRealTimers();
  });

  it("Google's price is used when it answers promptly, even if Yahoo answers first", async () => {
    feeds({ ms: 150, price: "30,731.94" }, { ms: 10, price: 30_725.5 });
    const { fetchPrice } = await import("./tickStore");
    expect(await fetchPrice("NDX")).toEqual({ price: 30_731.94, source: "google" });
  });

  it("a slow Google does not hold the lookup up: Yahoo's answer is taken after a short head start, not after Google's 3-second limit", async () => {
    feeds({ ms: 5_000, price: "30,731.94" }, { ms: 50, price: 30_725.5 });
    const { fetchPrice } = await import("./tickStore");
    const t0 = Date.now();
    expect(await fetchPrice("NDX")).toEqual({ price: 30_725.5, source: "yahoo" });
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it("both sources are asked at the same time, not one after the other", async () => {
    const calls = feeds({ ms: 100, price: null }, { ms: 100, price: 30_725.5 });
    const { fetchPrice } = await import("./tickStore");
    const p = fetchPrice("NDX");
    await sleep(30);
    expect(calls.slice(0, 2).sort()).toEqual(["google", "yahoo"]); // both started within the first 30 ms
    await p;
  });

  it("when Google quickly has no price, Yahoo's is used at once, without waiting out the head start", async () => {
    feeds({ ms: 10, price: null }, { ms: 60, price: 30_725.5 });
    const { fetchPrice } = await import("./tickStore");
    const t0 = Date.now();
    expect(await fetchPrice("NDX")).toEqual({ price: 30_725.5, source: "yahoo" });
    expect(Date.now() - t0).toBeLessThan(600);
  });

  it("when neither gives a price the answer is null, and it is not slow", async () => {
    feeds({ ms: 20, price: null }, { ms: 20, price: null });
    const { fetchPrice } = await import("./tickStore");
    const t0 = Date.now();
    expect(await fetchPrice("NDX")).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it("a tick that is recent enough is returned at once, with no new lookup", async () => {
    const calls = feeds({ ms: 10, price: "100.00" }, { ms: 10, price: 100 });
    const { waitForTick } = await import("./tickStore");
    const first = await waitForTick("NDX", 2_000, 15_000); // nothing yet: looks the price up
    const callsAfterFirst = calls.length;
    const again = await waitForTick("NDX", 2_000, 15_000);
    expect(again).toEqual(first);
    expect(calls.length).toBe(callsAfterFirst); // the second was answered from the stored tick
  });

  it("an old tick is not used when a fresh one can be had: the feed is asked directly, not left to a poll timer that may have been asleep", async () => {
    feeds({ ms: 10, price: "100.00" }, { ms: 10, price: 100 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { waitForTick } = await import("./tickStore");
    const old = await waitForTick("NDX", 2_000, 15_000);
    expect(old?.price).toBe(100);
    feeds({ ms: 10, price: "250.00" }, { ms: 10, price: 250 });
    vi.setSystemTime(1_000_000 + 120_000); // two minutes later: the instance was asleep
    const next = await waitForTick("NDX", 2_000, 15_000);
    expect(next?.price).toBe(250);
    expect(next!.t).toBe(1_120_000);
  });

  it("with the feed unreachable, a tick under a minute old is still used and an older one never is", async () => {
    feeds({ ms: 10, price: "100.00" }, { ms: 10, price: 100 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    const { waitForTick } = await import("./tickStore");
    await waitForTick("NDX", 2_000, 15_000);
    feeds({ ms: 10, price: null }, { ms: 10, price: null }); // the feed goes down
    vi.setSystemTime(2_000_000 + 40_000);
    expect((await waitForTick("NDX", 300, 15_000))?.price).toBe(100); // 40 seconds old: acceptable as a last resort
    vi.setSystemTime(2_000_000 + 90_000);
    expect(await waitForTick("NDX", 300, 15_000)).toBeNull(); // 90 seconds old: no price rather than a stale one
  });

  it("with no limit on age, any tick counts, as before (the pages that only draw a price)", async () => {
    feeds({ ms: 10, price: "100.00" }, { ms: 10, price: 100 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(3_000_000);
    const { waitForTick } = await import("./tickStore");
    await waitForTick("NDX", 2_000);
    vi.setSystemTime(3_000_000 + 600_000);
    expect((await waitForTick("NDX", 2_000))?.price).toBe(100);
  });
});

describe("PRICE_SOURCE=broker only asks the bridge for the symbols it takes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.doUnmock("./brokerFeed");
    vi.resetModules();
  });

  async function setup() {
    const asked: string[] = [];
    vi.doMock("./brokerFeed", () => ({
      fetchBrokerPrice: async (symbol: string) => {
        asked.push(symbol);
        return { price: 21_000, source: "broker" as const };
      },
    }));
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("query1.finance.yahoo.com")) return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 5_800 } }] } }), { status: 200 });
      return new Response("<html></html>", { status: 200 });
    });
    vi.stubEnv("BROKER", "ibkr");
    vi.stubEnv("PRICE_SOURCE", "broker");
    const { fetchPrice } = await import("./tickStore");
    return { fetchPrice, asked, urls };
  }

  it("NDX goes to the bridge; SPX never does and takes the public feed's price", async () => {
    const { fetchPrice, asked } = await setup();
    expect(await fetchPrice("NDX")).toEqual({ price: 21_000, source: "broker" });
    expect(asked).toEqual(["NDX"]);
    expect(await fetchPrice("SPX")).toMatchObject({ price: 5_800, source: "yahoo" });
    expect(asked).toEqual(["NDX"]);
  });

  it("with BRIDGE_SYMBOLS=NDX,SPX both go to the bridge; a bad BRIDGE_SYMBOLS gives no price and asks nobody", async () => {
    const both = await setup();
    vi.stubEnv("BRIDGE_SYMBOLS", "NDX,SPX");
    await both.fetchPrice("SPX");
    expect(both.asked).toEqual(["SPX"]);
    vi.stubEnv("BRIDGE_SYMBOLS", "NDX;SPX");
    expect(await both.fetchPrice("NDX")).toBeNull();
    expect(both.asked).toEqual(["SPX"]);
  });
});
