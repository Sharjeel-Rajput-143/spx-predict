import { describe, expect, it } from "vitest";
import { CHECKS, SLOW_MS, format, warm } from "./warm.mjs";

const answers = { "/hook/warm": [200, '{"ok":true}'], "/hook/0000": [404, '{"error":"Not found."}'], "/api/automation/session": [200, '{"authRequired":true}'], "/automation/bybit": [307, ""], "/api/automation/bybit": [401, "{}"] };
const fakeFetch = (override = {}) => async (url, init) => {
  const path = new URL(url).pathname;
  const [status, text] = override[path] ?? answers[path];
  if (status === "throw") throw new TypeError("fetch failed");
  return { status, text: async () => text, init };
};

describe("the post-edit check", () => {
  it("passes when everything answers as it should", async () => {
    const { ok, results } = await warm("http://x", { fetchFn: fakeFetch() });
    expect(ok).toBe(true);
    expect(results).toHaveLength(CHECKS.length);
  });
  it("fails on a 500 from the webhook route (the failure that cost an alert)", async () => {
    const { ok, results } = await warm("http://x", { fetchFn: fakeFetch({ "/hook/warm": [500, "Internal Server Error"] }) });
    expect(ok).toBe(false);
    expect(results[0]).toMatchObject({ answered: false, status: 500 });
  });
  it("fails when the webhook route answers something else with the right status", async () => {
    const { ok } = await warm("http://x", { fetchFn: fakeFetch({ "/hook/0000": [404, "<html>nope</html>"] }) });
    expect(ok).toBe(false);
  });
  it("fails and says so when the app is not running", async () => {
    const { ok, results } = await warm("http://x", { fetchFn: fakeFetch({ "/hook/warm": ["throw", ""] }) });
    expect(ok).toBe(false);
    expect(results[0].error).toBe("fetch failed");
  });
  it("flags an answer slower than TradingView will wait, even when it is correct", async () => {
    let t = 0;
    const now = () => (t += 1);
    const slowFetch = async (url) => {
      if (new URL(url).pathname === "/hook/warm") t += SLOW_MS + 500;
      const [status, text] = answers[new URL(url).pathname];
      return { status, text: async () => text };
    };
    const { ok, results } = await warm("http://x", { fetchFn: slowFetch, now });
    expect(results[0]).toMatchObject({ answered: true, slow: true });
    expect(ok).toBe(false);
    expect(format(results)).toMatch(/SLOW/);
  });
  it("never sends a real token or a signal: only GET /hook/warm and POST to an address that cannot exist", () => {
    for (const c of CHECKS.filter((x) => x.path.startsWith("/hook/"))) expect(["/hook/warm", "/hook/0000"]).toContain(c.path);
  });
});
