import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionKeyOrNull } from "@/lib/auth/credentials";
import { ownerUserId, userIdForEmail } from "@/lib/auth/users";
import { signSession } from "@/lib/auth/sessionToken";
import { GET as listBots } from "@/app/api/automation/bots/route";
import { GET as getBot } from "@/app/api/automation/bots/[id]/route";
import { DELETE as deletePositionRoute } from "@/app/api/automation/positions/[id]/route";
import { DELETE as deleteLogRoute } from "@/app/api/automation/bots/[id]/log/[entry]/route";
import { POST as login } from "@/app/api/login/route";
import { withBotLock } from "./botLock";
import { createEmptyBot, listBotIds } from "./bots";
import { updateAppSettings, getAppSettings } from "./appSettings";
import { logDecision } from "./decisions";
import { deleteLogEntry } from "./logAdmin";
import { deletePosition, whyNotRemovable } from "./positionsAdmin";
import { decisionsStore, ordersStore, positionsStore, runsStore, signalsStore, usersStore, webhooksStore } from "./store";
import { BASE_NOW, NDX_BOT_ID, buildPosition, resetAutomationStores, setNdxTestEnv, setTestBotEnv } from "./testSupport";
import { recordSignIn } from "./userAccounts";
import { runAs, currentUserId } from "./userContext";
import { createWebhook } from "./webhooks";

// Whose records are whose: every record points at a user, and a signed-in user sees and changes only their own.

setTestBotEnv();
setNdxTestEnv();

const OWNER_EMAIL = "owner@example.com";
const OWNER = userIdForEmail(OWNER_EMAIL);
const B = userIdForEmail("b@example.com");

beforeEach(() => {
  vi.stubEnv("APP_LOGIN_EMAIL", OWNER_EMAIL);
  vi.stubEnv("APP_LOGIN_PASSWORD", "pw");
  vi.stubEnv("AUTH_SECRET", "s".repeat(48));
  resetAutomationStores();
  setNdxTestEnv();
});
afterEach(() => vi.unstubAllEnvs());

const basics = (name: string) => ({ name, accountId: "paper-1", allocationLimit: 1000 });
const cookieFor = (email: string) => `automation_session=${signSession(email, 60_000, sessionKeyOrNull()!)}`;
const req = (path: string, email: string, method = "GET") => new NextRequest(`http://localhost${path}`, { method, headers: { cookie: cookieFor(email) } });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

describe("a record points at its user", () => {
  it("is saved as the signed-in user's; with nobody signed in (the engine) it is the owner's, or its bot's owner's", () => {
    const mine = runAs(B, () => createWebhook({ name: "B hook", botId: null, direction: null }));
    expect(webhooksStore.get(mine.id)?.userId).toBe(B);
    const engine = createWebhook({ name: "Owner hook", botId: null, direction: null });
    expect(webhooksStore.get(engine.id)?.userId).toBe(OWNER);

    const bot = runAs(B, () => createEmptyBot(basics("B bot")));
    expect(bot.userId).toBe(B);
    // A position, a signal and a decision made for B's bot are B's, even when written by the engine (no one signed in).
    const position = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "open", botId: bot.id }));
    expect(position.userId).toBe(B);
    const order = ordersStore.insert({ id: "o1", positionId: position.id, kind: "open", status: "filled", limitPrice: 1, filledQuantity: 1, ref: "r", createdAt: 1, updatedAt: 1 });
    expect(order.userId).toBe(B);
    logDecision({ signalId: null, botId: bot.id, outcome: "opened", reason: "x", detail: {}, now: BASE_NOW });
    expect(decisionsStore.all().at(-1)?.userId).toBe(B);
  });

  it("the engine's work on a bot runs under that bot's owner; a signed-in user's keeps their own view", async () => {
    const bot = runAs(B, () => createEmptyBot(basics("B bot")));
    expect(await withBotLock(bot.id, async () => currentUserId())).toBe(B);
    expect(await withBotLock(NDX_BOT_ID, async () => currentUserId())).toBe(OWNER);
    // B asking for a lock on the owner's bot does not become the owner.
    expect(await runAs(B, () => withBotLock(NDX_BOT_ID, async () => currentUserId()))).toBe(B);
  });

  it("a user is recorded once at sign-in, with the time", async () => {
    recordSignIn(OWNER_EMAIL, 1000);
    recordSignIn(" Owner@Example.com ", 2000);
    expect(usersStore.all()).toEqual([{ id: OWNER, email: OWNER_EMAIL, createdAt: 1000, lastLoginAt: 2000 }]);
    resetAutomationStores();
    const res = await login(new NextRequest("http://localhost/api/login", { method: "POST", body: JSON.stringify({ email: OWNER_EMAIL, password: "pw" }), headers: { "Content-Type": "application/json", "x-forwarded-for": "9.9.9.9" } }));
    expect(res.status).toBe(200);
    expect(usersStore.get(ownerUserId())?.email).toBe(OWNER_EMAIL);
  });
});

describe("a user sees only their own", () => {
  it("bots, webhooks and positions of another user are not found, listed, edited or removed", () => {
    const hook = runAs(OWNER, () => createWebhook({ name: "Mine", botId: null, direction: null }));
    const bot = runAs(OWNER, () => createEmptyBot(basics("Mine")));
    const position = positionsStore.insert(buildPosition({ type: "short_put_spread", status: "closed", botId: bot.id }));

    runAs(B, () => {
      expect(webhooksStore.all()).toEqual([]);
      expect(webhooksStore.get(hook.id)).toBeUndefined();
      expect(webhooksStore.update(hook.id, { name: "Stolen" })).toBeUndefined();
      expect(webhooksStore.remove(hook.id)).toBe(false);
      expect(webhooksStore.removeWhere(() => true)).toBe(0);
      expect(positionsStore.query(() => true)).toEqual([]);
      expect(positionsStore.remove(position.id)).toBe(false);
      expect(listBotIds()).not.toContain(bot.id);
      expect(listBotIds()).not.toContain(NDX_BOT_ID); // the built-in bot is the owner's
    });
    runAs(OWNER, () => {
      expect(webhooksStore.get(hook.id)?.name).toBe("Mine");
      expect(listBotIds()).toContain(bot.id);
      expect(listBotIds()).toContain(NDX_BOT_ID);
    });
    expect(webhooksStore.all()).toHaveLength(1); // nothing was changed
  });

  it("a row with no user id (from before users existed) belongs to the owner", () => {
    positionsStore.insert({ ...buildPosition({ type: "short_put_spread", status: "closed" }), userId: undefined });
    const raw = positionsStore.all()[0];
    expect(raw.userId).toBe(OWNER); // stamped on the way in
    runAs(OWNER, () => expect(positionsStore.all()).toHaveLength(1));
    runAs(B, () => expect(positionsStore.all()).toHaveLength(0));
  });

  it("settings are one row per user", () => {
    runAs(OWNER, () => updateAppSettings({ sessionTimeoutMinutes: 30 }));
    runAs(B, () => {
      expect(getAppSettings().sessionTimeoutMinutes).toBe(1440); // B starts from the defaults
      updateAppSettings({ sessionTimeoutMinutes: 480 });
    });
    runAs(OWNER, () => expect(getAppSettings().sessionTimeoutMinutes).toBe(30));
    runAs(B, () => expect(getAppSettings().sessionTimeoutMinutes).toBe(480));
  });

  it("through the routes, with another user's cookie: their bots list is empty and the owner's bot is not found", async () => {
    const bot = runAs(OWNER, () => createEmptyBot(basics("Mine")));
    const mine = await (await listBots(req("/api/automation/bots", OWNER_EMAIL))).json();
    expect(mine.bots.map((b: { id: string }) => b.id)).toContain(bot.id);
    const theirs = await (await listBots(req("/api/automation/bots", "b@example.com"))).json();
    expect(theirs.bots).toEqual([]);
    expect((await getBot(req(`/api/automation/bots/${bot.id}`, "b@example.com"), ctx({ id: bot.id }))).status).toBe(404);
    expect((await getBot(req(`/api/automation/bots/${bot.id}`, OWNER_EMAIL), ctx({ id: bot.id }))).status).toBe(200);
  });
});

describe("removing positions", () => {
  const seed = (status: "open" | "closing" | "closed" | "expired" | "rejected", extra: Record<string, unknown> = {}) => {
    const p = positionsStore.insert({ ...buildPosition({ type: "short_put_spread", status, botId: NDX_BOT_ID }), ...extra });
    ordersStore.insert({ id: `o-${p.id}`, positionId: p.id, kind: "open", status: "filled", limitPrice: 1, filledQuantity: 1, ref: "r", createdAt: 1, updatedAt: 1 });
    return p;
  };

  it("a closed, expired or rejected position can be deleted, with its orders; an open or closing one can't", () => {
    for (const status of ["open", "closing"] as const) {
      const p = seed(status);
      expect(whyNotRemovable(p)).toMatch(/still tracking/);
      expect(() => deletePosition(p.id)).toThrow(/still tracking/);
      expect(positionsStore.get(p.id)).toBeDefined();
    }
    for (const status of ["closed", "expired", "rejected"] as const) {
      const p = seed(status);
      deletePosition(p.id);
      expect(positionsStore.get(p.id)).toBeUndefined();
      expect(ordersStore.query((o) => o.positionId === p.id)).toEqual([]);
    }
  });

  it("a test position can go whatever its state", () => {
    const p = seed("open", { test: true });
    deletePosition(p.id);
    expect(positionsStore.get(p.id)).toBeUndefined();
  });

  it("through the route: 409 for an open one, 200 for a closed one, 404 for someone else's", async () => {
    const open = seed("open");
    const closed = seed("closed");
    expect((await deletePositionRoute(req(`/api/automation/positions/${open.id}`, OWNER_EMAIL, "DELETE"), ctx({ id: open.id }))).status).toBe(409);
    expect((await deletePositionRoute(req(`/api/automation/positions/${closed.id}`, "b@example.com", "DELETE"), ctx({ id: closed.id }))).status).toBe(404);
    expect((await deletePositionRoute(req(`/api/automation/positions/${closed.id}`, OWNER_EMAIL, "DELETE"), ctx({ id: closed.id }))).status).toBe(200);
    expect(positionsStore.get(closed.id)).toBeUndefined();
  });
});

describe("removing log entries", () => {
  const seedSignal = (id: string, receivedAt: number) => {
    signalsStore.insert({ id, botId: NDX_BOT_ID, signal: "bullish", barTime: "t", price: 21000, interval: "5", receivedAt, status: "accepted", raw: {} });
    logDecision({ signalId: id, botId: NDX_BOT_ID, outcome: "opened", reason: "x", detail: {}, now: receivedAt });
    runsStore.insert({ id, botId: NDX_BOT_ID, signalId: id, source: "webhook", automation: "Bullish signal", trigger: "Webhook", startedAt: receivedAt, nodes: [] });
  };

  it("deletes the signal, its decisions and its run; a signal still inside the duplicate window stays", () => {
    seedSignal("old", BASE_NOW - 3_600_000);
    seedSignal("fresh", BASE_NOW - 30_000);
    expect(() => deleteLogEntry(NDX_BOT_ID, "fresh", BASE_NOW)).toThrow(/too recent/);
    expect(signalsStore.get("fresh")).toBeDefined();

    expect(deleteLogEntry(NDX_BOT_ID, "old", BASE_NOW)).toEqual({ removed: "signal" });
    expect(signalsStore.get("old")).toBeUndefined();
    expect(decisionsStore.query((d) => d.signalId === "old")).toEqual([]);
    expect(runsStore.get("old")).toBeUndefined();
    expect(decisionsStore.query((d) => d.signalId === "fresh")).toHaveLength(1); // the others are untouched
  });

  it("a manual entry (a decision with no signal) can be deleted too; an unknown one is not found", () => {
    logDecision({ signalId: null, botId: NDX_BOT_ID, outcome: "closed", reason: "by hand", detail: {}, now: BASE_NOW });
    const d = decisionsStore.all().at(-1)!;
    expect(deleteLogEntry(NDX_BOT_ID, d.id, BASE_NOW)).toEqual({ removed: "decision" });
    expect(() => deleteLogEntry(NDX_BOT_ID, "nope", BASE_NOW)).toThrow(/not found/);
  });

  it("through the route: another user can't, the owner can", async () => {
    seedSignal("old", Date.now() - 3_600_000);
    expect((await deleteLogRoute(req(`/api/automation/bots/${NDX_BOT_ID}/log/old`, "b@example.com", "DELETE"), ctx({ id: NDX_BOT_ID, entry: "old" }))).status).toBe(404);
    expect(signalsStore.get("old")).toBeDefined();
    expect((await deleteLogRoute(req(`/api/automation/bots/${NDX_BOT_ID}/log/old`, OWNER_EMAIL, "DELETE"), ctx({ id: NDX_BOT_ID, entry: "old" }))).status).toBe(200);
    expect(signalsStore.get("old")).toBeUndefined();
  });
});
