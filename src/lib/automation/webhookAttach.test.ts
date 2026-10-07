import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listRoute, POST as createRoute } from "@/app/api/automation/webhooks/route";
import { DELETE as deleteRoute } from "@/app/api/automation/webhooks/[id]/route";
import { GET as urlRoute } from "@/app/api/automation/webhooks/[id]/url/route";
import { POST as testRoute } from "@/app/api/automation/webhooks/[id]/test/route";
import { DELETE as detachRoute, GET as stateRoute, PUT as attachRoute } from "@/app/api/automation/bots/[id]/triggers/[dir]/route";
import { POST as hookRoute } from "@/app/api/webhook/hook/[token]/route";
import { SecretUrl } from "@/components/automation/SecretUrl";
import { WebhookAttachPanel, WebhookOptionList, optionLabel } from "@/components/automation/bot/WebhookAttachPanel";
import { WebhooksSection, type SettingsData, type WebhookView } from "@/components/automation/settings/sections";
import { alertsStore, decisionsStore, errorsStore, ordersStore, positionsStore, runsStore, signalsStore, storageProblem, webhooksStore, __simulateRestart } from "./store";
import { ensureBotRecord } from "./bots";
import { attachWebhook, createWebhook, detachTrigger, deleteWebhook, optionsForTrigger, webhookForTrigger } from "./webhooks";
import { NDX_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";

// The bot's own live quote, as the app's price feed would give it: a webhook call carries no price. No network.
vi.mock("@/lib/marketData/tickStore", () => ({
  waitForTick: async () => ({ t: Date.now(), price: 21_003.7 }),
  getLastTick: () => ({ t: Date.now(), price: 21_003.7 }),
  isLiveSymbol: () => false,
}));


// Attaching a webhook to the NDX Bias Bot's Bullish or Bearish trigger: attach, change, detach, one webhook one
// trigger, kept across a restart, logged, and the secret never shown, logged or returned in full.

setTestBotEnv();
setNdxTestEnv();

const TRIGGER = (dir: string) => `http://localhost/api/automation/bots/${NDX_BOT_ID}/triggers/${dir}`;
const ctx = (dir: string, id = NDX_BOT_ID) => ({ params: Promise.resolve({ id, dir }) });
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const send = (url: string, method: string, body?: unknown) => new NextRequest(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) });

const state = async (dir: string) => (await stateRoute(send(TRIGGER(dir), "GET"), ctx(dir))).json();
const attach = (dir: string, webhookId: string) => attachRoute(send(TRIGGER(dir), "PUT", { webhookId }), ctx(dir));
const detach = (dir: string) => detachRoute(send(TRIGGER(dir), "DELETE"), ctx(dir));
const botLog = () => decisionsStore.all().filter((d) => d.botId === NDX_BOT_ID && d.signalId === null).map((d) => d.outcome);
const tokenOf = (id: string) => webhooksStore.get(id)!.token;
const callHook = (token: string, body = '{"price":21003.7}') => hookRoute(new NextRequest(`http://localhost/api/webhook/hook/${token}`, { method: "POST", body }), { params: Promise.resolve({ token }) });
async function until(cond: () => boolean) {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
}

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(NDX_BOT_ID);
});
afterEach(() => vi.unstubAllEnvs());

describe("attach, change and detach", () => {
  it("a webhook is created without a trigger, then attached from the trigger's panel, and it stays attached", async () => {
    const made = await createRoute(send("http://localhost/api/automation/webhooks", "POST", { name: "BullishNDX" }));
    expect(made.status).toBe(201);
    const hook = (await made.json()).webhook;
    expect(hook).toMatchObject({ name: "BullishNDX", attached: false, botId: null, direction: null });

    expect(await state("bullish")).toMatchObject({ current: null });
    const res = await attach("bullish", hook.id);
    expect(res.status).toBe(200);
    expect((await res.json()).current).toMatchObject({ id: hook.id, name: "BullishNDX", attached: true, botId: NDX_BOT_ID, direction: "bullish" });
    expect(webhookForTrigger(NDX_BOT_ID, "bullish")?.id).toBe(hook.id);
    expect((await state("bullish")).current.id).toBe(hook.id); // and a later look finds it still there
    expect(await state("bearish")).toMatchObject({ current: null });
  });

  it("an attached webhook's URL runs that trigger's signal for that bot; an unattached one is refused", async () => {
    const bull = createWebhook({ name: "BullishNDX" });
    const loose = createWebhook({ name: "Loose" });
    await attach("bullish", bull.id);

    const ok = await callHook(tokenOf(bull.id));
    expect(ok.status).toBe(200);
    await until(() => decisionsStore.all().some((d) => d.signalId !== null));
    expect(signalsStore.all()[0]).toMatchObject({ botId: NDX_BOT_ID, signal: "bullish", status: "accepted" });

    const refused = await callHook(tokenOf(loose.id));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/isn't attached to a trigger/);
  });

  it("changing: attaching another webhook to the trigger replaces the first, which is unattached and refused", async () => {
    const a = createWebhook({ name: "A" });
    const b = createWebhook({ name: "B" });
    await attach("bullish", a.id);
    const res = await attach("bullish", b.id);
    expect(res.status).toBe(200);
    expect((await res.json()).current.id).toBe(b.id);
    expect(webhooksStore.get(a.id)).toMatchObject({ botId: null, direction: null });
    expect(webhooksStore.get(b.id)).toMatchObject({ botId: NDX_BOT_ID, direction: "bullish" });
    expect((await callHook(tokenOf(a.id))).status).toBe(409);
    expect((await callHook(tokenOf(b.id))).status).toBe(200);
    await until(() => decisionsStore.all().some((d) => d.signalId !== null));
  });

  it("detaching: the trigger has no webhook, and the webhook's URL is refused until it is attached again", async () => {
    const a = createWebhook({ name: "A" });
    await attach("bearish", a.id);
    const res = await detach("bearish");
    expect((await res.json()).current).toBeNull();
    expect(webhookForTrigger(NDX_BOT_ID, "bearish")).toBeUndefined();
    expect(webhooksStore.get(a.id)).toBeDefined(); // the webhook itself still exists
    expect((await callHook(tokenOf(a.id))).status).toBe(409);
    await attach("bearish", a.id);
    expect(webhookForTrigger(NDX_BOT_ID, "bearish")?.id).toBe(a.id);
  });

  it("saving the same webhook again changes nothing and logs nothing", async () => {
    const a = createWebhook({ name: "A" });
    await attach("bullish", a.id);
    await attach("bullish", a.id);
    expect(botLog()).toEqual(["webhook_attached"]);
  });

  it("the Bullish and the Bearish trigger each keep their own webhook", async () => {
    const bull = createWebhook({ name: "BullishNDX" });
    const bear = createWebhook({ name: "BearishNDX" });
    await attach("bullish", bull.id);
    await attach("bearish", bear.id);
    expect(webhookForTrigger(NDX_BOT_ID, "bullish")?.name).toBe("BullishNDX");
    expect(webhookForTrigger(NDX_BOT_ID, "bearish")?.name).toBe("BearishNDX");
  });

  it("an unknown bot, a bad trigger or a missing webhook is refused plainly", async () => {
    const a = createWebhook({ name: "A" });
    expect((await stateRoute(send(TRIGGER("sideways"), "GET"), ctx("sideways"))).status).toBe(404);
    expect((await stateRoute(send(TRIGGER("bullish"), "GET"), ctx("bullish", "nope"))).status).toBe(404);
    expect((await attachRoute(send(TRIGGER("bullish"), "PUT", {}), ctx("bullish"))).status).toBe(400);
    const missing = await attach("bullish", "wh-nope");
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/not found/i);
    expect(webhooksStore.get(a.id)?.botId).toBeNull();
  });
});

describe("one webhook, one trigger", () => {
  it("a webhook attached to one trigger shows as unavailable for the other, with the reason", async () => {
    const a = createWebhook({ name: "BullishNDX" });
    const free = createWebhook({ name: "Free" });
    await attach("bullish", a.id);

    const bearish = (await state("bearish")).options as ReturnType<typeof optionsForTrigger>;
    expect(bearish.find((o) => o.id === a.id)).toMatchObject({ available: false, attachedHere: false });
    expect(bearish.find((o) => o.id === a.id)?.reason).toBe("Already attached to the Bullish trigger of NDX Bias Bot (one webhook, one trigger)");
    expect(bearish.find((o) => o.id === free.id)).toMatchObject({ available: true, reason: null });

    const bullish = (await state("bullish")).options as ReturnType<typeof optionsForTrigger>;
    expect(bullish.find((o) => o.id === a.id)).toMatchObject({ available: true, attachedHere: true });
  });

  it("attaching it to the other trigger is refused, naming where it is, and nothing changes", async () => {
    const a = createWebhook({ name: "BullishNDX" });
    await attach("bullish", a.id);
    const res = await attach("bearish", a.id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('"BullishNDX" is already attached to the Bullish trigger of NDX Bias Bot. One webhook, one trigger: detach it there first.');
    expect(webhooksStore.get(a.id)).toMatchObject({ botId: NDX_BOT_ID, direction: "bullish" });
    expect(webhookForTrigger(NDX_BOT_ID, "bearish")).toBeUndefined();
    expect(() => attachWebhook(a.id, NDX_BOT_ID, "bearish")).toThrow(/One webhook, one trigger/);
  });

  it("after detaching it from one trigger it can be attached to the other", async () => {
    const a = createWebhook({ name: "A" });
    await attach("bullish", a.id);
    await detach("bullish");
    expect((await attach("bearish", a.id)).status).toBe(200);
    expect(webhooksStore.get(a.id)?.direction).toBe("bearish");
  });

  it("the dropdown label says status and, when it can't be picked, why", () => {
    expect(optionLabel({ id: "x", name: "A", active: true, available: true, attachedHere: false, reason: null })).toBe("A - on");
    expect(optionLabel({ id: "x", name: "B", active: false, available: false, attachedHere: false, reason: "Already attached to the Bearish trigger of NDX Bias Bot (one webhook, one trigger)" })).toBe(
      "B - off - unavailable: Already attached to the Bearish trigger of NDX Bias Bot (one webhook, one trigger)",
    );
  });
});

describe("every change is logged, without the URL", () => {
  it("attach, change and detach each write a line to the bot's log", async () => {
    const a = createWebhook({ name: "A" });
    const b = createWebhook({ name: "B" });
    await attach("bullish", a.id);
    await attach("bullish", b.id);
    await detach("bullish");

    const rows = decisionsStore.all().filter((d) => d.signalId === null && d.botId === NDX_BOT_ID);
    expect(rows.map((d) => d.outcome)).toEqual(["webhook_attached", "webhook_changed", "webhook_detached"]);
    expect(rows.map((d) => d.reason)).toEqual([
      'Webhook "A" attached to the Bullish trigger of NDX Bias Bot.',
      'Bullish trigger changed from webhook "A" to "B".',
      'Webhook "B" detached from the Bullish trigger of NDX Bias Bot.',
    ]);
  });

  it("deleting an attached webhook logs the detach", () => {
    const a = createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bullish" });
    deleteWebhook(a.id);
    expect(botLog()).toEqual(["webhook_attached", "webhook_detached"]);
    expect(decisionsStore.all().at(-1)?.reason).toContain("deleted");
    expect(webhooksStore.get(a.id)).toBeUndefined();
  });

  it("they use the engine's own log (the bot's Log tab), so no new place to look", () => {
    createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bearish" });
    detachTrigger(NDX_BOT_ID, "bearish");
    expect(decisionsStore.query((d) => d.botId === NDX_BOT_ID).map((d) => d.outcome)).toEqual(["webhook_attached", "webhook_detached"]);
  });
});

describe("persistence across a restart", () => {
  it("the attachment, its name and its secret are read back from the files after the memory is dropped", async () => {
    const a = createWebhook({ name: "BullishNDX" });
    const token = tokenOf(a.id);
    await attach("bullish", a.id);

    __simulateRestart();

    expect(webhookForTrigger(NDX_BOT_ID, "bullish")).toMatchObject({ id: a.id, name: "BullishNDX", token });
    expect((await state("bullish")).current.id).toBe(a.id);
    expect(botLog()).toEqual(["webhook_attached"]);
    expect((await callHook(token)).status).toBe(200); // the URL still works
    await until(() => decisionsStore.all().some((d) => d.signalId !== null));
  });

  it("a detach and a change also survive it", async () => {
    const a = createWebhook({ name: "A" });
    const b = createWebhook({ name: "B" });
    await attach("bullish", a.id);
    await attach("bullish", b.id);
    await attach("bearish", a.id);
    await detach("bearish");
    __simulateRestart();
    expect(webhookForTrigger(NDX_BOT_ID, "bullish")?.id).toBe(b.id);
    expect(webhookForTrigger(NDX_BOT_ID, "bearish")).toBeUndefined();
    expect(webhooksStore.get(a.id)).toMatchObject({ botId: null });
  });

  it("the files hold the schema version and the secret (the data folder is the only place the secret is)", () => {
    const a = createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bullish" });
    const file = path.join(process.env.AUTOMATION_DATA_DIR!, "webhooks.json");
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(json).toMatchObject({ schemaVersion: 1, collection: "webhooks" });
    expect(json.items[0]).toMatchObject({ id: a.id, token: a.token, botId: NDX_BOT_ID, direction: "bullish" });
  });
});

describe("a damaged data file stops the engine with a clear message", () => {
  const dir = () => process.env.AUTOMATION_DATA_DIR!;

  it("a corrupted webhooks file: the webhook route answers 503 with the reason, and nothing is rewritten as empty", async () => {
    const a = createWebhook({ name: "A", botId: NDX_BOT_ID, direction: "bullish" });
    const token = tokenOf(a.id);
    const file = path.join(dir(), "webhooks.json");
    const good = fs.readFileSync(file, "utf8");
    try {
      fs.writeFileSync(file, '{"schemaVersion":1,"collection":"webhooks","items":[{"id":');
      __simulateRestart();

      expect(storageProblem()).toContain(file);
      const res = await callHook(token);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/damaged/);
      expect(fs.readFileSync(file, "utf8")).toBe('{"schemaVersion":1,"collection":"webhooks","items":[{"id":');
    } finally {
      fs.writeFileSync(file, good);
      __simulateRestart();
    }
    expect(storageProblem()).toBeNull();
  });
});

describe("secrets", () => {
  it(".gitignore keeps the data folder (and env files) out of git", () => {
    const ignore = fs.readFileSync(path.join(process.cwd(), ".gitignore"), "utf8").split("\n").map((l) => l.trim());
    expect(ignore).toContain("data/");
    expect(ignore).toContain(".env.*");
  });

  it("the list, create, trigger and url-less answers never include the secret; only the on-demand URL does", async () => {
    const created = await (await createRoute(send("http://localhost/api/automation/webhooks", "POST", { name: "BullishNDX" }))).json();
    const id = created.webhook.id;
    const token = tokenOf(id);
    await attach("bullish", id);

    const answers = [JSON.stringify(created), JSON.stringify(await (await listRoute(send("http://localhost/api/automation/webhooks", "GET"))).json()), JSON.stringify(await state("bullish")), JSON.stringify(await state("bearish"))];
    for (const text of answers) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(token.slice(0, 16));
    }
    expect(answers[1]).toMatch(/"path":"\/hook\/•{12}[0-9a-f]{4}"/);

    const reveal = await urlRoute(send(`http://localhost/api/automation/webhooks/${id}/url`, "GET"), idCtx(id));
    expect(await reveal.json()).toEqual({ path: `/hook/${token}` }); // asked for on purpose
    expect(reveal.headers.get("Cache-Control")).toBe("no-store");
  });

  it("the full URL needs a signed-in person", async () => {
    const a = createWebhook({ name: "A" });
    vi.stubEnv("AUTOMATION_STATUS_PASSWORD", "a-password");
    const res = await urlRoute(send(`http://localhost/api/automation/webhooks/${a.id}/url`, "GET"), idCtx(a.id));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(tokenOf(a.id));
  });

  it("the secret never reaches a log, an alert, a run trace, a signal, an error, an order, a position or the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const bull = createWebhook({ name: "BullishNDX" });
    const bear = createWebhook({ name: "BearishNDX" });
    const tokens = [tokenOf(bull.id), tokenOf(bear.id)];
    await attach("bullish", bull.id);
    await attach("bullish", bear.id); // a change
    await detach("bullish");
    await attach("bearish", bear.id);
    await attach("bullish", bull.id);

    await callHook(tokens[0]);
    await callHook(tokens[1]); // a call to the bearish hook too
    await callHook("not-a-real-token-at-all");
    await until(() => decisionsStore.all().filter((d) => d.signalId !== null).length >= 2);
    await testRoute(send(`http://localhost/api/automation/webhooks/${bull.id}/test`, "POST", { price: 21003.7 }), idCtx(bull.id));
    await deleteRoute(send(`http://localhost/api/automation/webhooks/${bear.id}`, "DELETE"), idCtx(bear.id));

    const everything = JSON.stringify({
      decisions: decisionsStore.all(),
      alerts: alertsStore.all(),
      runs: runsStore.all(),
      signals: signalsStore.all(),
      errors: errorsStore.all(),
      orders: ordersStore.all(),
      positions: positionsStore.all(),
      console: spies.flatMap((s) => s.mock.calls),
    });
    for (const token of tokens) {
      expect(everything).not.toContain(token);
      expect(everything).not.toContain(token.slice(0, 16));
    }
    spies.forEach((s) => s.mockRestore());
  });

  it("the Settings list and the trigger panel show the URL masked; Reveal and Copy fetch it on demand", () => {
    const hooks: WebhookView[] = [
      { id: "wh-1", name: "BullishNDX", path: `/hook/${"•".repeat(12)}c0de`, attached: true, botId: NDX_BOT_ID, botName: "NDX Bias Bot", underlying: "NDX", direction: "bullish", active: true, createdAt: 1, lastTriggeredAt: null, triggerCount: 0 },
      { id: "wh-2", name: "Spare", path: `/hook/${"•".repeat(12)}beef`, attached: false, botId: null, botName: null, underlying: null, direction: null, active: true, createdAt: 2, lastTriggeredAt: null, triggerCount: 0 },
    ];
    const settings = { webhook: { path: "/api/webhook/tradingview", secretSet: true, bots: [{ id: NDX_BOT_ID, name: "NDX Bias Bot", underlying: "NDX" }] }, executor: { venue: "mock" } } as unknown as SettingsData;
    const out = renderToStaticMarkup(createElement(WebhooksSection, { data: settings, origin: "http://localhost:3000", hooks }));
    expect(out).toContain("http://localhost:3000/hook/••••••••••••c0de");
    expect(out).toContain(">Reveal<");
    expect(out).toContain('aria-label="Copy webhook URL"');
    expect(out).toContain("Attached to the Bullish trigger of NDX Bias Bot");
    expect(out).toContain("0 bots"); // the spare, attached to nothing
    expect(out).not.toMatch(/[0-9a-f]{32}/); // no token-sized hex string anywhere in the page

    const url = renderToStaticMarkup(createElement(SecretUrl, { webhookId: "wh-1", maskedPath: "/hook/••••••••••••c0de", origin: "https://example.test" }));
    expect(url).toContain("https://example.test/hook/••••••••••••c0de");
    expect(url).toContain(">Reveal<");
  });
});

describe("the trigger panel (laid out like Option Alpha's Edit Settings)", () => {
  const options = [
    { id: "a", name: "BullishNDX", active: true, available: true, attachedHere: true, reason: null },
    { id: "b", name: "BearishNDX", active: true, available: false, attachedHere: false, reason: "Already attached to the Bearish trigger of NDX Bias Bot (one webhook, one trigger)" },
    { id: "c", name: "Spare", active: false, available: true, attachedHere: false, reason: null },
  ];
  const noop = () => undefined;
  const panel = (over: Partial<Parameters<typeof WebhookAttachPanel>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(WebhookAttachPanel, {
        triggerName: "Bullish trigger",
        automationName: "Bullish signal",
        otherAutomationName: "Bearish signal",
        current: { id: "a", name: "BullishNDX", active: true },
        options,
        selected: "a",
        onSelect: noop,
        alwaysOn: true,
        onAlwaysOn: noop,
        onSave: noop,
        saveDisabled: false,
        onDetach: noop,
        onCreate: async () => null,
        onCopy: noop,
        busy: false,
        urlSlot: "URL-SLOT",
        testSlot: "TEST-SLOT",
        ...over,
      }),
    );

  it("has the same sections as Option Alpha: Automation (with New), Schedule (Webhook), Webhook (with +), Always On, Save", () => {
    const out = panel();
    for (const t of ["Automation", "Bullish signal", ">New<", "Schedule", ">Webhook<", "Always On", "Run even if automations are turned off", ">Save<", 'aria-label="Create a webhook"']) expect(out, t).toContain(t);
    expect(out).toContain("Attached:");
    expect(out).toContain("BullishNDX");
    expect(out).toContain("URL-SLOT");
    expect(out).toContain("TEST-SLOT");
    expect(out).toContain(">Detach webhook<");
  });

  it("says Always On is copied only for closes", () => {
    expect(panel()).toContain("closes only");
    expect(panel()).toContain("it never opens one");
  });

  it("the webhook list shows each webhook with its status and a copy icon; one on the other trigger is disabled with the reason", () => {
    const out = renderToStaticMarkup(createElement(WebhookOptionList, { options, selected: "a", onPick: noop, onCopy: noop }));
    expect(out).toContain("BullishNDX");
    expect((out.match(/aria-label="Copy URL of /g) ?? []).length).toBe(3);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?BearishNDX[^]*?Unavailable: Already attached to the Bearish trigger of NDX Bias Bot \(one webhook, one trigger\)/);
    expect(out).toMatch(/Spare <span[^>]*>off</);
  });

  it("with nothing attached it says so, and the Detach button is disabled; URL and test hook are not shown", () => {
    const out = panel({ current: null, selected: "" });
    expect(out).toContain("No webhook attached");
    expect(out).toContain("Choose a webhook...");
    expect(out).not.toContain("URL-SLOT");
    expect(out).not.toContain("TEST-SLOT");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Detach webhook<\/button>/);
  });

  it("Save is only enabled for a change", () => {
    expect(panel({ saveDisabled: true })).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    expect(panel({ saveDisabled: false })).not.toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
  });

  it("with no webhooks at all the list points to +", () => {
    expect(renderToStaticMarkup(createElement(WebhookOptionList, { options: [], selected: "", onPick: noop, onCopy: noop }))).toContain("Use + to create one");
  });

  it("the dropdown label helper still says status and why", () => {
    expect(optionLabel(options[0])).toBe("BullishNDX - on");
    expect(optionLabel(options[1])).toContain("unavailable: Already attached to the Bearish trigger");
  });
});

describe("a test call needs no price, like the real call", () => {
  it("runs on the live quote; with no fresh quote it says so; a price sent in the body is ignored", async () => {
    vi.resetModules();
    const feed = { tick: null as { t: number; price: number } | null };
    vi.doMock("@/lib/marketData/tickStore", () => ({ waitForTick: async () => feed.tick, getLastTick: () => feed.tick, isLiveSymbol: () => false }));
    const { POST: test } = await import("@/app/api/automation/webhooks/[id]/test/route");
    const { createWebhook: create } = await import("./webhooks");
    const { resetAutomationStores: reset, NDX_BOT_ID: bot } = await import("./testSupport");
    reset();
    const hook = create({ name: "T", botId: bot, direction: "bullish" });
    const ask = (body: unknown) => test(send(`http://localhost/api/automation/webhooks/${hook.id}/test`, "POST", body), idCtx(hook.id));

    expect((await ask({})).status).toBe(409); // no quote yet
    feed.tick = { t: Date.now(), price: 21_050.5 };
    const res = await ask({});
    expect(res.status).toBe(200);
    expect((await res.json()).price).toBe(21_050.5);
    expect((await (await ask({ price: 21_000 })).json()).price).toBe(21_050.5); // not read
    vi.doUnmock("@/lib/marketData/tickStore");
  });
});
