import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAutomationStores, setTestBotEnv, TEST_BOT_ID } from "@/lib/automation/testSupport";
import { botsStore } from "@/lib/automation/store";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { GET as list, POST as create } from "./route";
import { POST as toggle } from "./[id]/toggle/route";
import { DELETE as remove, GET as detail, PATCH as patch } from "./[id]/route";
import { POST as clone } from "./[id]/clone/route";
import { POST as saveTemplateRoute } from "./[id]/template/route";
import { POST as run } from "./[id]/run/route";
import { POST as openPosition } from "./[id]/positions/route";
import { POST as closePosition } from "../positions/[id]/close/route";
import { GET as exportData } from "./[id]/export/route";
import { DELETE as clearLog } from "./[id]/log/route";
import { PATCH as patchPosition } from "../positions/[id]/route";
import { POST as movePositionRoute } from "../positions/[id]/move/route";
import { positionsStore } from "@/lib/automation/store";
import { buildPosition } from "@/lib/automation/testSupport";

// Wide-open hours so the manual/run actions don't depend on when the suite runs
// (the window comes from env at import time, so it's set before the first import below).
setTestBotEnv();

const url = "http://localhost/api/automation/bots";
const req = (method: string, body?: unknown, path = url) =>
  new NextRequest(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const newBotBody = {
  inputs: {
    name: "API Bot",
    accountId: "paper-9",
    underlying: "SPX",
    quantity: 1,
    widthPoints: 5,
    strikeIncrement: 5,
    putShortOffset: -20,
    callShortOffset: 20,
    allocationLimit: 5000,
    openingCreditEstimate: 2,
  },
  tags: ["api"],
  group: "Tests",
};

beforeEach(() => resetAutomationStores());

describe("creating bots the three ways", () => {
  it("empty: three fields in, a Setup-needed bot out that refuses to switch on", async () => {
    const res = await create(req("POST", { mode: "empty", name: "Blank", accountId: "paper-1", allocationLimit: 1000 }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()).bot as { id: string };

    const row = (await (await list(req("GET"))).json()).bots.find((b: { id: string }) => b.id === id);
    expect(row).toMatchObject({ name: "Blank", enabled: false, configError: expect.stringMatching(/no trading inputs/), allocation: 1000 });

    const d = await (await detail(req("GET"), ctx(id))).json();
    expect(d.config).toBeNull();
    expect(d.bot).toMatchObject({ accountId: "paper-1", allocation: 1000, draft: { allocationLimit: 1000 } });

    const on = await toggle(req("POST"), ctx(id));
    expect(on.status).toBe(409);
    expect((await on.json()).error).toMatch(/Bot inputs/);

    // Entering the inputs makes it a normal bot that can be switched on.
    const inputs = { ...newBotBody.inputs, name: "Blank", accountId: "paper-1", allocationLimit: 1000 };
    expect((await patch(req("PATCH", { inputs }), ctx(id))).status).toBe(200);
    expect((await toggle(req("POST"), ctx(id))).status).toBe(200);
  });

  it("empty: rejects a bad allocation", async () => {
    expect((await create(req("POST", { mode: "empty", name: "x", accountId: "p", allocationLimit: -5 }))).status).toBe(400);
    expect((await create(req("POST", { mode: "empty", name: "x", accountId: "p" }))).status).toBe(400);
  });

  it("clone: copies a bot's inputs under a new name", async () => {
    const res = await create(req("POST", { mode: "clone", sourceId: TEST_BOT_ID, name: "My copy", accountId: "paper-3", allocationLimit: 4000 }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()).bot as { id: string };
    const d = await (await detail(req("GET"), ctx(id))).json();
    expect(d.config).toMatchObject({ name: "My copy", accountId: "paper-3", allocationLimit: 4000, quantity: 3 });
    expect((await create(req("POST", { mode: "clone", sourceId: "nope", name: "x" }))).status).toBe(404);
  });

  it("template: a bot from a saved template", async () => {
    const tpl = await (await saveTemplateRoute(req("POST", { name: "Mine" }), ctx(TEST_BOT_ID))).json();
    const res = await create(req("POST", { mode: "template", templateId: tpl.template.id, name: "From it", accountId: "paper-1", allocationLimit: 1500 }));
    expect(res.status).toBe(201);
    expect((await create(req("POST", { mode: "template", templateId: "gone", name: "x", accountId: "p", allocationLimit: 1 }))).status).toBe(400);
  });
});

describe("bot lifecycle through the API", () => {
  it("creates, lists, edits, clones and deletes a bot", async () => {
    const bad = await create(req("POST", { inputs: { ...newBotBody.inputs, putShortOffset: undefined } }));
    expect(bad.status).toBe(400);

    const created = await create(req("POST", newBotBody));
    expect(created.status).toBe(201);
    const { id } = (await created.json()).bot as { id: string };

    const listed = await (await list(req("GET"))).json();
    expect(listed.bots.find((b: { id: string }) => b.id === id)).toMatchObject({ name: "API Bot", enabled: false, group: "Tests", tags: ["api"], closedPL: null });

    const edited = await patch(req("PATCH", { notes: "hello", tags: ["x", "y"], triggers: { bullish: false, bearish: true } }), ctx(id));
    expect(edited.status).toBe(200);
    const d = await (await detail(req("GET"), ctx(id))).json();
    expect(d.bot).toMatchObject({ notes: "hello", tags: ["x", "y"], triggers: { bullish: false, bearish: true } });

    const badPatch = await patch(req("PATCH", { safeguards: { dailyNewPositionLimit: -1 } }), ctx(id));
    expect(badPatch.status).toBe(400);

    const cloned = await clone(req("POST"), ctx(id));
    const cloneId = (await cloned.json()).bot.id as string;
    expect(cloneId).not.toBe(id);

    expect((await remove(req("DELETE"), ctx(cloneId))).status).toBe(200);
    expect((await detail(req("GET"), ctx(cloneId))).status).toBe(404);
    expect((await remove(req("DELETE"), ctx(TEST_BOT_ID))).status).toBe(400); // built-in
  });

  it("clear log hides entries but keeps the data in the export", async () => {
    botsStore.insert({ id: TEST_BOT_ID, enabled: true, needsAttention: false, needsAttentionReason: null, createdAt: 0 });
    await run(req("POST", { signal: "bullish", price: 7720 }), ctx(TEST_BOT_ID)); // outcome depends on the hour; it logs either way
    expect(((await (await detail(req("GET"), ctx(TEST_BOT_ID))).json()).signals as unknown[]).length).toBe(1);

    await clearLog(req("DELETE"), ctx(TEST_BOT_ID));
    const d = await (await detail(req("GET"), ctx(TEST_BOT_ID))).json();
    expect(d.bot.logClearedAt).toBeGreaterThan(0);
    const exported = JSON.parse(await (await exportData(req("GET", undefined, `${url}/x/export`), ctx(TEST_BOT_ID))).text());
    expect(exported.signals).toHaveLength(1);

    const csv = await exportData(req("GET", undefined, `${url}/x/export?kind=signals&format=csv`), ctx(TEST_BOT_ID));
    expect(csv.headers.get("content-type")).toBe("text/csv");
    expect((await csv.text()).split("\n")[0]).toContain("botId");
  });

  it("rejects bad input to the run and new-position actions", async () => {
    expect((await run(req("POST", { signal: "sideways" }), ctx(TEST_BOT_ID))).status).toBe(400);
    expect((await openPosition(req("POST", { type: "nope", shortStrike: 7700 }), ctx(TEST_BOT_ID))).status).toBe(400);
    expect((await openPosition(req("POST", { type: "short_put_spread" }), ctx(TEST_BOT_ID))).status).toBe(400);
    expect((await closePosition(req("POST"), ctx("missing"))).status).toBe(404);
    expect(sharedExecutor).toBeDefined();
  });
});

describe("position tags, notes and Move through the API", () => {
  it("edits tags and notes, and rejects an empty patch", async () => {
    const p = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open" }));
    const ok = await patchPosition(req("PATCH", { tags: ["a", "b"], notes: "hi" }), ctx(p.id));
    expect(ok.status).toBe(200);
    expect((await ok.json()).position).toMatchObject({ tags: ["a", "b"], notes: "hi" });
    expect((await patchPosition(req("PATCH", {}), ctx(p.id))).status).toBe(400);
    expect((await patchPosition(req("PATCH", { notes: "x" }), ctx("missing"))).status).toBe(400);
  });

  it("moves an open position to another bot on the same account, and refuses sensibly otherwise", async () => {
    const created = await create(req("POST", { inputs: { ...newBotBody.inputs, accountId: "test-account", name: "Target" } }));
    const targetId = (await created.json()).bot.id as string;
    const p = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open" }));

    expect((await movePositionRoute(req("POST", {}), ctx(p.id))).status).toBe(400); // botId required
    // Same bot: refused up front - it must not wait on its own lock.
    expect((await movePositionRoute(req("POST", { botId: TEST_BOT_ID }), ctx(p.id))).status).toBe(400);
    expect((await movePositionRoute(req("POST", { botId: "ghost" }), ctx(p.id))).status).toBe(400);
    expect((await movePositionRoute(req("POST", { botId: targetId }), ctx("missing"))).status).toBe(404);

    const moved = await movePositionRoute(req("POST", { botId: targetId }), ctx(p.id));
    expect(moved.status).toBe(200);
    expect(positionsStore.get(p.id)?.botId).toBe(targetId);
  });
});
