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
    for (let i = 0; i < 25 && tick == null; i++) {
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
