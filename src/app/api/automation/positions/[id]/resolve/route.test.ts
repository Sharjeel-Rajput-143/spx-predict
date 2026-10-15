import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_COOKIE_NAME } from "@/lib/automation/session";
import { ensureBotRecord } from "@/lib/automation/bots";
import { botsStore, decisionsStore, positionsStore } from "@/lib/automation/store";
import { NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv } from "@/lib/automation/testSupport";
import { GET, POST } from "./route";

// The Resolve routes, on the internal simulation (a simulated position has no broker to ask). The broker answers are tested in
// positionResolve.test.ts; this is what the route itself guarantees: who may ask, what is accepted, and that it runs under the bot's lock.

setNdxTestEnv();

const url = "http://localhost/api/automation/positions/pos-1/resolve";
const ctx = (id = "pos-1") => ({ params: Promise.resolve({ id }) });
const get = (id?: string, cookie?: string) => GET(new NextRequest(url, { headers: cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {} }), ctx(id));
const post = (body: unknown, id?: string, cookie?: string) =>
  POST(new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...(cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {}) } }), ctx(id));

beforeEach(() => {
  vi.stubEnv("APP_LOGIN_EMAIL", "owner@example.com");
  vi.stubEnv("EXECUTOR", "mock");
  vi.stubEnv("BROKER", "");
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(NDX_BOT_ID);
  positionsStore.insert(buildPosition({ id: "pos-1", botId: NDX_BOT_ID, underlying: "NDX", optionRoot: "NDXP", type: "short_put_spread", status: "closing", shortStrike: 20_970, longStrike: 20_960, requestedQuantity: 1, filledQuantity: 1, credit: 3.3, venue: "mock" }));
  botsStore.update(NDX_BOT_ID, { needsAttention: true, needsAttentionReason: "Close order ended without filling." });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET: asks, and writes nothing", () => {
  it("answers with what can be done for a simulated position", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const { assessment } = await res.json();
    expect(assessment).toMatchObject({ positionId: "pos-1", verdict: "no_broker", noBroker: true, actions: ["return_to_open", "mark_closed"] });
    expect(positionsStore.get("pos-1")?.status).toBe("closing");
    expect(decisionsStore.all()).toHaveLength(0);
  });

  it("404 for a position that does not exist", async () => {
    expect((await get("nope")).status).toBe(404);
  });
});

describe("POST: does one offered action, once confirmed", () => {
  it("returns the position to open, logs it, clears the flag, and answers with the position's new state", async () => {
    const res = await post({ action: "return_to_open", confirm: true });
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result).toMatchObject({ action: "return_to_open", position: { status: "open" }, assessment: { resolvable: false } });
    expect(decisionsStore.all().at(-1)).toMatchObject({ outcome: "position_resolved" });
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(false);
  });

  it("marks closed with a typed price in range", async () => {
    const res = await post({ action: "mark_closed", confirm: true, price: 2.4 });
    expect(res.status).toBe(200);
    expect(positionsStore.get("pos-1")).toMatchObject({ status: "closed", closePrice: 2.4 });
  });

  it("refuses, changing nothing: no confirmation, an unknown action, a price that isn't a number, an impossible price, an action not on offer", async () => {
    const cases: [unknown, RegExp][] = [
      [{ action: "return_to_open" }, /Confirm/],
      [{ action: "return_to_open", confirm: "yes" }, /Confirm/],
      [{ action: "delete_everything", confirm: true }, /offered actions/],
      [{ confirm: true }, /offered actions/],
      [{ action: "mark_closed", confirm: true, price: "2" }, /number/],
      [{ action: "mark_closed", confirm: true, price: 99 }, /above 0 and below/],
      [{ action: "cancel_orders", confirm: true }, /isn't available now/],
      [{ action: "mark_open", confirm: true, price: 2 }, /isn't available now/],
    ];
    for (const [body, message] of cases) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toMatch(message);
    }
    expect(positionsStore.get("pos-1")?.status).toBe("closing");
    expect(decisionsStore.all()).toHaveLength(0);
    expect(botsStore.get(NDX_BOT_ID)?.needsAttention).toBe(true);
  });

  it("a body that isn't JSON is refused, and a position that isn't there is a 404", async () => {
    expect((await POST(new NextRequest(url, { method: "POST", body: "not json" }), ctx())).status).toBe(400);
    expect((await post({ action: "return_to_open", confirm: true }, "nope")).status).toBe(404);
  });

  it("two clicks at once cannot both change the position: the second finds it already resolved", async () => {
    const [a, b] = await Promise.all([post({ action: "return_to_open", confirm: true }), post({ action: "return_to_open", confirm: true })]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(decisionsStore.all().filter((d) => d.outcome === "position_resolved")).toHaveLength(1);
  });
});

describe("who may use it", () => {
  beforeEach(() => {
    vi.stubEnv("APP_LOGIN_PASSWORD", "correct horse");
    vi.stubEnv("AUTH_SECRET", "x".repeat(48));
  });

  it("with sign-in on, someone who isn't signed in can neither ask nor change anything", async () => {
    expect((await get()).status).toBe(401);
    expect((await post({ action: "return_to_open", confirm: true })).status).toBe(401);
    expect(positionsStore.get("pos-1")?.status).toBe("closing");
  });

  it("a signed-in person can", async () => {
    const cookie = createSession();
    expect((await get("pos-1", cookie)).status).toBe(200);
    expect((await post({ action: "return_to_open", confirm: true }, "pos-1", cookie)).status).toBe(200);
  });
});
