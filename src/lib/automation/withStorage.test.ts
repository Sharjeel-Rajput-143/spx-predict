import { beforeEach, describe, expect, it, vi } from "vitest";

// A remote storage whose loading takes as long as the test says: the shape of a function starting up and opening the database.
const fake = vi.hoisted(() => ({ remote: true, delayMs: 0, loaded: 0, flushed: 0, hydrateCollections: async (_n?: unknown) => {}, flush: async () => {}, hydrate: async () => {} }));
vi.mock("./store", () => ({ storage: fake }));

const { deferWork, withStorage } = await import("./withStorage");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const req = { method: "POST", cookies: { get: () => undefined } };

beforeEach(() => {
  fake.delayMs = 0;
  fake.loaded = 0;
  fake.flushed = 0;
  fake.hydrateCollections = async () => {
    await sleep(fake.delayMs);
    fake.loaded++;
  };
  fake.flush = async () => {
    fake.flushed++;
  };
});

const fallback = () => Response.json({ received: true, queued: "Being processed." }, { status: 200 });

describe("answering within a time", () => {
  it("a call that loads in time gets the handler's own answer", async () => {
    const ran: string[] = [];
    const run = withStorage(async (_r: unknown) => (ran.push("handler"), Response.json({ handled: true }, { status: 409 })), { load: ["webhooks"], answerWithin: { ms: 200, response: fallback } });
    fake.delayMs = 10;
    const res = await run(req as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ handled: true });
    expect(ran).toEqual(["handler"]);
  });

  it("a call that is slow to load is answered at once, and the handler and its deferred work still run behind the answer", async () => {
    const ran: string[] = [];
    const run = withStorage(
      async (_r: unknown) => {
        ran.push("handler");
        return deferWork(Response.json({ handled: true }), async () => void ran.push("deferred"));
      },
      { load: ["webhooks"], answerWithin: { ms: 40, response: fallback } },
    );
    fake.delayMs = 300;
    const t0 = Date.now();
    const res = await run(req as never);
    expect(Date.now() - t0).toBeLessThan(200); // answered at the deadline, not after the load
    expect(await res.json()).toEqual({ received: true, queued: "Being processed." });
    expect(ran).toEqual([]); // not yet: the records are still loading
    await sleep(500);
    expect(ran).toEqual(["handler", "deferred"]);
    expect(fake.flushed).toBeGreaterThan(0);
  });

  it("the next request waits for the one still working behind its answer, so two never overlap", async () => {
    const order: string[] = [];
    let counter = 0;
    const run = withStorage(
      async (_r: unknown) => {
        const id = ++counter;
        order.push(`start${id}`);
        await sleep(5);
        order.push(`end${id}`);
        return Response.json({ id });
      },
      { load: ["webhooks"], answerWithin: { ms: 20, response: fallback } },
    );
    fake.delayMs = 120;
    const first = await run(req as never); // slow: answered with the fallback
    expect(first.status).toBe(200);
    fake.delayMs = 0;
    await run(req as never);
    expect(order).toEqual(["start1", "end1", "start2", "end2"]);
  });

  it("a handler that fails behind a slow answer is not an unhandled error", async () => {
    const run = withStorage(
      async (_r: unknown) => {
        throw new Error("boom");
      },
      { load: ["webhooks"], answerWithin: { ms: 20, response: fallback } },
    );
    fake.delayMs = 100;
    const res = await run(req as never);
    expect(res.status).toBe(200);
    await sleep(250);
  });

  it("with no deadline set it behaves as before", async () => {
    const run = withStorage(async (_r: unknown) => Response.json({ ok: true }), { load: ["webhooks"] });
    fake.delayMs = 60;
    const res = await run(req as never);
    expect(await res.json()).toEqual({ ok: true });
    expect(fake.loaded).toBe(1);
  });
});
