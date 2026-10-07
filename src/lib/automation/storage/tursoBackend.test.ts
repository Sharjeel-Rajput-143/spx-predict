import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TursoBackend } from "./tursoBackend";

// The database is a local SQLite file (the same client Turso uses over the network): nothing leaves this machine.

let dir: string;
let url: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "turso-test-"));
  url = `file:${path.join(dir, "db.sqlite")}`;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Row {
  id: string;
  name: string;
}
const instance = (name: string) => new TursoBackend({ url, instance: name });

describe("two serverless instances sharing one database", () => {
  it("a record saved by one is there for the other, once, until it is removed", async () => {
    const a = instance("a");
    const b = instance("b");
    await a.hydrate();
    a.repository<Row>("webhooks").insert({ id: "w1", name: "BullishNDX" });
    await a.flush();

    await b.hydrate();
    expect(b.repository<Row>("webhooks").all()).toEqual([{ id: "w1", name: "BullishNDX" }]);
    await b.hydrate(); // loading again never duplicates
    expect(b.repository<Row>("webhooks").all()).toHaveLength(1);

    b.repository<Row>("webhooks").update("w1", { name: "Renamed" });
    await b.flush();
    await a.hydrate();
    expect(a.repository<Row>("webhooks").get("w1")?.name).toBe("Renamed");

    a.repository<Row>("webhooks").remove("w1");
    await a.flush();
    await b.hydrate();
    expect(b.repository<Row>("webhooks").all()).toEqual([]);
  });

  it("two instances adding different records at the same time keep both", async () => {
    const a = instance("a");
    const b = instance("b");
    await Promise.all([a.hydrate(), b.hydrate()]);
    a.repository<Row>("webhooks").insert({ id: "bull", name: "BullishNDX" });
    b.repository<Row>("webhooks").insert({ id: "bear", name: "BearishNDX" });
    await Promise.all([a.flush(), b.flush()]);
    const c = instance("c");
    await c.hydrate();
    expect(c.repository<Row>("webhooks").all().map((r) => r.id).sort()).toEqual(["bear", "bull"]);
  });

  it("can load just some collections first, and everything afterwards, without losing a change made in between", async () => {
    const a = instance("a");
    await a.hydrate();
    a.repository<Row>("webhooks").insert({ id: "w", name: "hook" });
    a.repository<Row>("signals").insert({ id: "s", name: "signal" });
    a.repository<Row>("positions").insert({ id: "p", name: "position" });
    await a.flush();

    const b = instance("b");
    await b.hydrateCollections(["webhooks"]); // a fast first step: one small query
    expect(b.repository<Row>("webhooks").all().map((r) => r.id)).toEqual(["w"]);
    expect(b.repository<Row>("signals").all()).toEqual([]); // not loaded yet
    b.repository<Row>("webhooks").update("w", { name: "claimed" }); // a change made before the rest is loaded
    await b.hydrate(); // loads the rest; saves the change first
    expect(b.repository<Row>("signals").all().map((r) => r.id)).toEqual(["s"]);
    expect(b.repository<Row>("positions").all().map((r) => r.id)).toEqual(["p"]);
    expect(b.repository<Row>("webhooks").get("w")?.name).toBe("claimed");
    await a.hydrate();
    expect(a.repository<Row>("webhooks").get("w")?.name).toBe("claimed");
  });

  it("creates its table only when it finds none (no extra round trip on a cold start), and still works on an empty database", async () => {
    const fresh = new TursoBackend({ url: `file:${path.join(dir, "fresh.sqlite")}`, instance: "fresh" });
    await fresh.hydrateCollections(["webhooks"]); // the table does not exist yet: made, then read
    fresh.repository<Row>("webhooks").insert({ id: "x", name: "first" });
    await fresh.flush();
    const other = new TursoBackend({ url: `file:${path.join(dir, "fresh.sqlite")}`, instance: "other" });
    await other.hydrate();
    expect(other.repository<Row>("webhooks").all().map((r) => r.id)).toEqual(["x"]);
  });

  it("keeps the order records were added in, and keeps collections apart", async () => {
    const a = instance("a");
    await a.hydrate();
    for (const id of ["1", "2", "3"]) a.repository<Row>("signals").insert({ id, name: id });
    a.repository<Row>("bots").insert({ id: "bot", name: "bot" });
    a.repository<Row>("signals").update("1", { name: "changed" }); // an update doesn't move it
    await a.flush();
    const b = instance("b");
    await b.hydrate();
    expect(b.repository<Row>("signals").all().map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(b.repository<Row>("bots").all()).toHaveLength(1);
  });

  it("removeWhere and a reset are saved too", async () => {
    const a = instance("a");
    await a.hydrate();
    for (const id of ["1", "2", "3"]) a.repository<Row>("orders").insert({ id, name: id });
    await a.flush();
    expect(a.repository<Row>("orders").removeWhere((r) => r.id !== "2")).toBe(2);
    await a.flush();
    const b = instance("b");
    await b.hydrate();
    expect(b.repository<Row>("orders").all().map((r) => r.id)).toEqual(["2"]);
    b.repository<Row>("orders").__reset();
    await b.flush();
    await a.hydrate();
    expect(a.repository<Row>("orders").all()).toEqual([]);
  });
});

describe("a database that fails is an error, never an empty start", () => {
  it("an unreachable database fails to load and says so", async () => {
    const bad = new TursoBackend({ url: `file:${path.join(dir, "no", "such", "dir", "db.sqlite")}`, instance: "bad" });
    await expect(bad.hydrate()).rejects.toThrow(/database can't be reached/);
    expect(bad.check()).toMatch(/TURSO_DB_URL/);
  });

  it("a save that fails keeps the change for the next try", async () => {
    const a = instance("a");
    await a.hydrate();
    a.repository<Row>("webhooks").insert({ id: "w", name: "kept" });
    // Break the table under it.
    const { createClient } = await import("@libsql/client");
    await createClient({ url }).execute("DROP TABLE records");
    (a as unknown as { state: { ready: boolean } }).state.ready = true; // it believes the table is there
    await expect(a.flush()).rejects.toThrow(/couldn't save/);
    expect(a.check()).toMatch(/kept/);
    (a as unknown as { state: { ready: boolean } }).state.ready = false; // it checks again
    await a.flush();
    const b = instance("b");
    await b.hydrate();
    expect(b.repository<Row>("webhooks").get("w")?.name).toBe("kept");
  });
});

describe("through the app's own routes, as on Vercel", () => {
  const json = (method: string, body?: unknown) => new NextRequest("http://localhost/api/automation/webhooks", { method, body: body ? JSON.stringify(body) : undefined, headers: { "Content-Type": "application/json" } });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("webhooks created earlier are still listed after a new instance starts; rename and delete work", async () => {
    vi.resetModules();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("AUTOMATION_STORAGE", "");
    vi.stubEnv("TURSO_DB_URL", url);
    vi.stubEnv("TURSO_DB_TOKEN", "test-token");
    const { storage } = await import("../store");
    expect(storage.remote).toBe(true);
    const { GET, POST } = await import("@/app/api/automation/webhooks/route");
    const { PATCH, DELETE } = await import("@/app/api/automation/webhooks/[id]/route");
    const names = async () => ((await (await GET(json("GET"))).json()) as { webhooks: { id: string; name: string }[] }).webhooks;

    expect((await POST(json("POST", { name: "BullishNDX" }))).status).toBe(201);
    storage.dropCaches?.(); // the next request lands on a fresh instance
    expect((await POST(json("POST", { name: "BearishNDX" }))).status).toBe(201);
    storage.dropCaches?.();

    const list = await names();
    expect(list.map((w) => w.name).sort()).toEqual(["BearishNDX", "BullishNDX"]); // both are there, once each

    // Saved with its user, in the database, not just in memory.
    const { ownerUserId } = await import("@/lib/auth/users");
    expect(storage.repository<{ id: string; userId?: string }>("webhooks").all().every((w) => w.userId === ownerUserId())).toBe(true);

    storage.dropCaches?.();
    const bull = list.find((w) => w.name === "BullishNDX")!;
    expect((await PATCH(json("PATCH", { name: "BullishNDX2" }), ctx(bull.id))).status).toBe(200);
    storage.dropCaches?.();
    expect((await names()).map((w) => w.name).sort()).toEqual(["BearishNDX", "BullishNDX2"]);

    storage.dropCaches?.();
    expect((await DELETE(json("DELETE"), ctx(bull.id))).status).toBe(200);
    storage.dropCaches?.();
    expect((await names()).map((w) => w.name)).toEqual(["BearishNDX"]);
  });

  it("a TradingView call is answered at once, and the bot's work behind the answer is still saved", async () => {
    vi.resetModules();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("AUTOMATION_STORAGE", "");
    vi.stubEnv("TURSO_DB_URL", url);
    vi.stubEnv("TURSO_DB_TOKEN", "test-token");
    vi.doMock("@/lib/marketData/tickStore", () => ({ waitForTick: async () => ({ t: Date.now(), price: 21_050.5 }), getLastTick: () => null, isLiveSymbol: () => false }));
    const { storage } = await import("../store");
    const { POST: create, GET } = await import("@/app/api/automation/webhooks/route");
    const { POST: hook } = await import("@/app/api/webhook/hook/[token]/route");
    const { setNdxTestEnv } = await import("../testSupport");
    setNdxTestEnv();

    await create(json("POST", { name: "BullishNDX" }));
    const made = (storage.repository<{ id: string; token: string }>("webhooks").all())[0];
    // attach it to the bullish trigger of the NDX bot
    const { attachWebhook } = await import("../webhooks");
    attachWebhook(made.id, "ndx_ema_bias", "bullish");
    await GET(json("GET")); // saved

    const res = await hook(new NextRequest(`http://localhost/api/webhook/hook/${made.token}`, { method: "POST", body: "", headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token: made.token }) });
    expect(res.status).toBe(200);

    // Anything that asks next waits its turn behind the bot's work, then sees everything it did.
    await GET(json("GET"));
    const { createClient } = await import("@libsql/client");
    const rows = (await createClient({ url }).execute("SELECT collection, json FROM records WHERE collection IN ('signals','decisions','runs')")).rows;
    const count = (name: string) => rows.filter((r) => r.collection === name).length;
    expect(count("signals")).toBe(1);
    expect(count("decisions")).toBeGreaterThan(0);
    expect(count("runs")).toBe(1);
    vi.doUnmock("@/lib/marketData/tickStore");
  });

  it("answers a TradingView call BEFORE the live quote has arrived, then finishes behind the answer and saves it all", async () => {
    vi.resetModules();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("AUTOMATION_STORAGE", "");
    vi.stubEnv("TURSO_DB_URL", url);
    vi.stubEnv("TURSO_DB_TOKEN", "test-token");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The quote only arrives once the test lets it: a call that waited for it could not be answered first.
    vi.doMock("@/lib/marketData/tickStore", () => ({ waitForTick: async () => (await gate, { t: Date.now(), price: 21_050.5 }), getLastTick: () => null, isLiveSymbol: () => false }));
    const { storage } = await import("../store");
    const { POST: create, GET } = await import("@/app/api/automation/webhooks/route");
    const { POST: hook } = await import("@/app/api/webhook/hook/[token]/route");
    const { attachWebhook } = await import("../webhooks");
    const { setNdxTestEnv } = await import("../testSupport");
    setNdxTestEnv();

    await create(json("POST", { name: "BullishNDX" }));
    const made = storage.repository<{ id: string; token: string }>("webhooks").all()[0];
    attachWebhook(made.id, "ndx_ema_bias", "bullish");
    await GET(json("GET"));
    storage.dropCaches?.(); // a cold instance: nothing in memory

    const call = hook(new NextRequest(`http://localhost/api/webhook/hook/${made.token}`, { method: "POST", body: "", headers: { "Content-Type": "text/plain" } }), { params: Promise.resolve({ token: made.token }) });
    const first = await Promise.race([call.then((r) => r.status), new Promise<string>((r) => setTimeout(() => r("still waiting for the quote"), 3000))]);
    expect(first).toBe(200); // answered with the quote still on its way

    release(); // now the quote arrives, and the work behind the answer can finish
    await GET(json("GET")); // asks next, so waits its turn behind that work
    const { createClient } = await import("@libsql/client");
    const rows = (await createClient({ url }).execute("SELECT collection, json FROM records WHERE collection IN ('signals','decisions','runs','webhooks')")).rows;
    const count = (name: string) => rows.filter((r) => r.collection === name).length;
    expect(count("signals")).toBe(1);
    expect(count("runs")).toBe(1);
    expect(count("decisions")).toBeGreaterThan(0);
    const saved = rows.filter((r) => r.collection === "webhooks").map((r) => JSON.parse(String(r.json)))[0];
    expect(saved.triggerCount).toBe(1); // counted
    expect(saved.lastTriggeredAt).toBeGreaterThan(0); // the minute was taken and saved before the answer
    vi.doUnmock("@/lib/marketData/tickStore");
  });

  it("answers 503 with the reason when the database can't be reached", async () => {
    vi.resetModules();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("AUTOMATION_STORAGE", "");
    vi.stubEnv("TURSO_DB_URL", `file:${path.join(dir, "no", "such", "dir", "db.sqlite")}`);
    vi.stubEnv("TURSO_DB_TOKEN", "test-token");
    const { GET } = await import("@/app/api/automation/webhooks/route");
    const res = await GET(json("GET"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/can't be reached/);
  });
});

describe("which storage is used", () => {
  it("Turso only on Vercel with both credentials, or when asked for; the files otherwise", async () => {
    const { tursoChoice } = await import("../store");
    const creds = { TURSO_DB_URL: "libsql://x.turso.io", TURSO_DB_TOKEN: "t" };
    expect(tursoChoice({ ...creds })).toBeNull(); // a laptop with TURSO_* in .env.local keeps its files
    expect(tursoChoice({ ...creds, VERCEL: "1" })).toEqual({ url: "libsql://x.turso.io", authToken: "t" });
    expect(tursoChoice({ ...creds, AUTOMATION_STORAGE: "turso" })).not.toBeNull();
    expect(tursoChoice({ ...creds, VERCEL: "1", AUTOMATION_STORAGE: "files" })).toBeNull();
    expect(tursoChoice({ TURSO_DB_URL: "libsql://x.turso.io", VERCEL: "1" })).toBeNull(); // no token: not usable
  });
});
