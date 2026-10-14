import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_COOKIE_NAME } from "@/lib/automation/session";
import { logDecision } from "@/lib/automation/decisions";
import { ensureBotRecord } from "@/lib/automation/bots";
import { updateAppSettings } from "@/lib/automation/appSettings";
import { notificationsStore } from "@/lib/automation/store";
import { NDX_BOT_ID, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "@/lib/automation/testSupport";
import { DELETE, GET, PATCH } from "./route";

// The bell's list, through its route. Signed-in only, each person sees only their own, and nothing here touches a trade.

setTestBotEnv();
setNdxTestEnv();

const URL_ = "http://localhost/api/automation/notifications";
const req = (method: string, body?: unknown, cookie?: string) =>
  new NextRequest(URL_, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...(cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {}) } } : cookie ? { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } } : {}) });
const raise = (reason: string, at: number, outcome: "executor_error" | "close_rejected" = "executor_error") => logDecision({ signalId: null, botId: NDX_BOT_ID, outcome, reason, now: at });

beforeEach(() => {
  vi.stubEnv("APP_LOGIN_EMAIL", "owner@example.com"); // the owner, whose records these are, is the person who signs in below
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(NDX_BOT_ID);
  raise("First trouble", 1_000);
  raise("Second trouble", 2_000);
  raise("Third trouble", 3_000, "close_rejected");
});
afterEach(() => vi.unstubAllEnvs());

describe("GET: what the bell shows", () => {
  it("the newest first, with the bot's name, a link, the unread count and the total", async () => {
    const body = await (await GET(req("GET"))).json();
    expect(body.notifications.map((n: { message: string }) => n.message)).toEqual(["Third trouble", "Second trouble", "First trouble"]);
    expect(body.notifications[0]).toMatchObject({ severity: "error", botName: "NDX Bias Bot", read: false, repeats: 1, link: "/automation/bots/ndx_ema_bias?tab=log", outcome: "close_rejected" });
    expect(body).toMatchObject({ unread: 3, total: 3 });
    expect(typeof body.serverTime).toBe("number");
  });

  it("only what the settings ask for: a trade or a warning is not in the list unless ticked", async () => {
    logDecision({ signalId: "s1", botId: NDX_BOT_ID, outcome: "opened", reason: "Opened", now: 4_000 });
    expect((await (await GET(req("GET"))).json()).total).toBe(3);
    updateAppSettings({ notifications: { trades: true } });
    logDecision({ signalId: "s2", botId: NDX_BOT_ID, outcome: "closed", reason: "Closed", now: 5_000 });
    const body = await (await GET(req("GET"))).json();
    expect(body.notifications[0]).toMatchObject({ severity: "trade", message: "Closed" });
  });

  it("an empty list is a normal answer", async () => {
    notificationsStore.removeWhere(() => true);
    expect(await (await GET(req("GET"))).json()).toMatchObject({ notifications: [], unread: 0, total: 0 });
  });
});

describe("PATCH: mark as read", () => {
  it("marks the ids given and answers with the fresh list", async () => {
    const [newest] = (await (await GET(req("GET"))).json()).notifications;
    const body = await (await PATCH(req("PATCH", { ids: [newest.id] }))).json();
    expect(body).toMatchObject({ changed: 1, unread: 2 });
    expect(body.notifications[0].read).toBe(true);
  });

  it("marks everything read with { all: true }", async () => {
    const body = await (await PATCH(req("PATCH", { all: true }))).json();
    expect(body).toMatchObject({ changed: 3, unread: 0, total: 3 });
  });

  it("refuses a body with neither, or with bad ids, and changes nothing", async () => {
    for (const bad of [{}, { ids: "abc" }, { ids: [1, 2] }, { ids: [""] }, { ids: Array.from({ length: 201 }, (_, i) => `id-${i}`) }]) {
      const res = await PATCH(req("PATCH", bad));
      expect(res.status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect((await (await GET(req("GET"))).json()).unread).toBe(3);
  });

  it("ignores ids that don't exist", async () => {
    expect(await (await PATCH(req("PATCH", { ids: ["no-such-id"] }))).json()).toMatchObject({ changed: 0, unread: 3 });
  });
});

describe("DELETE: clear", () => {
  it("removes the ids given", async () => {
    const [newest] = (await (await GET(req("GET"))).json()).notifications;
    const body = await (await DELETE(req("DELETE", { ids: [newest.id] }))).json();
    expect(body).toMatchObject({ removed: 1, total: 2 });
    expect(body.notifications.map((n: { id: string }) => n.id)).not.toContain(newest.id);
  });

  it("clears the whole list only when told so in so many words", async () => {
    for (const bad of [{}, { all: "yes" }, { all: false }, { ids: undefined }]) expect((await DELETE(req("DELETE", bad))).status, JSON.stringify(bad)).toBe(400);
    expect((await DELETE(req("DELETE"))).status).toBe(400); // no body at all
    expect((await (await GET(req("GET"))).json()).total).toBe(3);
    expect(await (await DELETE(req("DELETE", { all: true }))).json()).toMatchObject({ removed: 3, total: 0, unread: 0, notifications: [] });
  });
});

describe("who may ask", () => {
  beforeEach(() => {
    vi.stubEnv("APP_LOGIN_PASSWORD", "correct horse");
    vi.stubEnv("AUTH_SECRET", "x".repeat(48));
  });

  it("with sign-in on, nobody who isn't signed in can read, mark or clear anything", async () => {
    expect((await GET(req("GET"))).status).toBe(401);
    expect((await PATCH(req("PATCH", { all: true }))).status).toBe(401);
    expect((await DELETE(req("DELETE", { all: true }))).status).toBe(401);
    expect(notificationsStore.all()).toHaveLength(3);
    expect(notificationsStore.all().every((n) => n.readAt === null)).toBe(true);
  });

  it("a signed-in person can", async () => {
    const cookie = createSession();
    const res = await GET(req("GET", undefined, cookie));
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(3);
  });

  it("a forged or expired cookie can't", async () => {
    expect((await GET(req("GET", undefined, "not-a-real-session"))).status).toBe(401);
  });
});
