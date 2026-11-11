import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBotRecord } from "@/lib/automation/bots";
import type { BybitConfig } from "@/lib/automation/bybitExecutor";
import { LiveBybitExecutor } from "@/lib/automation/bybitLive";
import { LIVE_API_BASE, LIVE_BOT_ID } from "@/lib/automation/bybitLiveLimits";
import { API_KEY, API_SECRET, FakeBybit } from "@/lib/automation/bybitTestSupport";
import { __resetLastCheck } from "@/lib/automation/liveControl";
import { appLiveGuard } from "@/lib/automation/liveGuard";
import { __resetLiveSettings, readLiveSettings } from "@/lib/automation/liveSettings";
import { botsStore } from "@/lib/automation/store";
import { resetAutomationStores, setNdxTestEnv } from "@/lib/automation/testSupport";
import { POST as killPOST } from "../bots/[id]/kill/route";
import { POST as togglePOST } from "../bots/[id]/toggle/route";
import { POST as checkPOST } from "./check/route";
import { POST as openPOST } from "./open/route";
import { GET as statusGET } from "./route";
import { POST as settingsPOST } from "./settings/route";
import { POST as switchPOST } from "./switch/route";

setNdxTestEnv();
const base: Omit<BybitConfig, "apiBase"> = { apiKey: API_KEY, apiSecret: API_SECRET, symbol: "BTCUSDT", qty: 0.001, stopLossPercent: 1, takeProfitPercent: 2, dailyMaxLossUsd: 3, breakevenTriggerPercent: 0, breakevenLockPercent: 0, alwaysOn: true, hoursStart: "09:35", hoursEnd: "15:55", recvWindow: 5000, timeoutMs: 15_000 };
const g = globalThis as typeof globalThis & { __liveBybit?: { executor: LiveBybitExecutor | null; error: string | null }; __liveBootedApp?: boolean };

let fake: FakeBybit;
const url = "http://localhost/api/automation/live";
const get = (path = "") => new NextRequest(`${url}${path}`, { method: "GET" });
const post = (path: string, body: unknown) => new NextRequest(`${url}${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  __resetLiveSettings();
  __resetLastCheck();
  g.__liveBootedApp = true;
  fake = new FakeBybit();
  const live = new LiveBybitExecutor({ ...base, apiBase: LIVE_API_BASE }, appLiveGuard, fake.fetch, () => undefined);
  live.sleep = async () => undefined;
  g.__liveBybit = { executor: live, error: null };
  ensureBotRecord(LIVE_BOT_ID);
});
afterEach(() => vi.unstubAllEnvs());

const routes: [string, (r: NextRequest) => Promise<Response>, NextRequest][] = [
  ["GET /live", statusGET as never, get()],
  ["POST /live/check", checkPOST as never, post("/check", {})],
  ["POST /live/switch", switchPOST as never, post("/switch", { on: false })],
  ["POST /live/open", openPOST as never, post("/open", { direction: "up", confirm: true })],
  ["POST /live/settings", settingsPOST as never, post("/settings", { dailyLossUsd: 1 })],
];

describe("signed in only", () => {
  it.each(routes)("%s answers 401 to someone who is not signed in, and changes nothing", async (_n, handler, request) => {
    vi.stubEnv("APP_LOGIN_PASSWORD", "x-not-a-real-password");
    const res = await handler(request);
    expect(res.status).toBe(401);
    expect(fake.calls).toHaveLength(0);
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false, dailyLossUsd: 2 });
  });
  it("turning ON is refused to someone who is not signed in, even with the confirm sent", async () => {
    vi.stubEnv("APP_LOGIN_PASSWORD", "x-not-a-real-password");
    expect((await switchPOST(post("/switch", { on: true, confirm: true }) as never)).status).toBe(401);
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("GET /live", () => {
  it("gives the whole picture and no key", async () => {
    const res = await statusGET(get() as never);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(API_SECRET);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ switch: { on: false }, mirror: { on: false }, stage: 1, leverage: 10, dailyLossUsd: 2, key: { present: true }, bot: { exists: true, enabled: false }, limits: { maxQty: 0.001, dailyLossCeilingUsd: 3, maxTradesPerDay: 5, maxOpenPositions: 1 } });
    expect(body.gate.tests.total).toBe(6);
    expect(fake.calls).toHaveLength(0); // asks Bybit nothing
  });
});

describe("POST /live/switch", () => {
  it("refuses a body that is not exactly on:true or on:false", async () => {
    for (const bad of [{}, { on: "true", confirm: true }, { on: 1 }, { confirm: true }, []]) {
      const res = await switchPOST(post("/switch", bad) as never);
      expect(res.status).toBe(400);
    }
    expect((await switchPOST(post("/switch", "not json") as never)).status).toBe(400);
    expect(readLiveSettings().enabled).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
  it("turning ON needs confirm:true; a typed word, or anything else, is refused before Bybit is asked", async () => {
    for (const bad of [{ on: true }, { on: true, confirm: false }, { on: true, confirm: "true" }, { on: true, typed: "LIVE" }, { on: true, confirm: 1 }]) {
      const res = await switchPOST(post("/switch", bad) as never);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error).toMatch(/Confirm that real money/);
    }
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false });
    expect(fake.calls).toHaveLength(0);
  });
  it("turns ON (and the mirror with it) with the confirm and a passing check, and OFF with nothing", async () => {
    const on = await switchPOST(post("/switch", { on: true, confirm: true }) as never);
    expect(on.status).toBe(200);
    const body = await on.json();
    expect(body.status.switch.on).toBe(true);
    expect(body.status.mirror.on).toBe(true);
    expect(readLiveSettings()).toMatchObject({ enabled: true, mirrorEnabled: true, resume: true });
    expect(botsStore.get(LIVE_BOT_ID)?.enabled).toBe(true);
    fake.down = true;
    const down = await switchPOST(post("/switch", { on: false }) as never);
    expect(down.status).toBe(200);
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false });
    expect(botsStore.get(LIVE_BOT_ID)?.enabled).toBe(false);
  });
  it("OFF with no live position held turns the mirror OFF too; OFF while a position is held leaves it ON", async () => {
    await switchPOST(post("/switch", { on: true, confirm: true }) as never);
    await switchPOST(post("/switch", { on: false }) as never);
    await new Promise((r) => setTimeout(r, 50)); // the tidy runs behind the answer
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false });
    await switchPOST(post("/switch", { on: true, confirm: true }) as never);
    fake.position = { size: 0.001, avg: 76_000, stopLoss: 75_700, takeProfit: 76_600 };
    await switchPOST(post("/switch", { on: false }) as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: true });
  });
  it("is refused with the reason when the check fails, and nothing is ON", async () => {
    fake.keyInfo.permissions.Wallet = ["Withdraw"];
    const res = await switchPOST(post("/switch", { on: true, confirm: true }) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/move money/);
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false });
  });
  it("is refused when there is no live key", async () => {
    g.__liveBybit = { executor: null, error: "The live bot will not trade until these are set in .env.local: BYBIT_LIVE_API_KEY" };
    const res = await switchPOST(post("/switch", { on: true, confirm: true }) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no live key/);
    expect(readLiveSettings().enabled).toBe(false);
  });
});

describe("POST /live/open (the Open UP / Open DOWN buttons)", () => {
  it("refuses a bad direction, and a missing or wrong confirm, before Bybit is asked anything", async () => {
    expect((await openPOST(post("/open", { direction: "sideways", confirm: true }) as never)).status).toBe(400);
    for (const bad of [{ direction: "up" }, { direction: "up", confirm: false }, { direction: "up", confirm: "true" }, { direction: "up", typed: "LIVE" }]) {
      const res = await openPOST(post("/open", bad) as never);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error).toMatch(/Confirm that real money/);
    }
    expect((await openPOST(post("/open", "not json") as never)).status).toBe(400);
    expect(fake.calls).toHaveLength(0);
    expect(fake.created).toHaveLength(0);
  });
  it("with live trading OFF it is refused in words and nothing is sent", async () => {
    const res = await openPOST(post("/open", { direction: "down", confirm: true }) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Live trading is OFF/);
    expect(fake.created).toHaveLength(0);
    expect(readLiveSettings().enabled).toBe(false);
  });
});

describe("the live bot's pullback exit values (Settings tab of the Live page)", () => {
  it("are read from the live status, are the defaults to begin with, and are saved through the settings route to the LIVE bot only", async () => {
    const before = (await (await statusGET(get() as never)).json()).pullback;
    expect(before).toEqual({ enabled: true, fallUsd: 0.03, minPeakUsd: 0.12, chainEnabled: false, chainStopUsd: 0.03, chainMax: 10 });
    const res = await settingsPOST(post("/settings", { pullback: { minPeakUsd: 0.3, fallUsd: 0.05 } }) as never);
    expect(res.status).toBe(200);
    const after = await (await statusGET(get() as never)).json();
    expect(after.pullback).toMatchObject({ minPeakUsd: 0.3, fallUsd: 0.05, chainEnabled: false });
    expect(botsStore.get(LIVE_BOT_ID)?.pullback).toMatchObject({ minPeakUsd: 0.3, fallUsd: 0.05 });
    expect(botsStore.get("btc_bybit")?.pullback).toBeUndefined(); // the demo bot's record is untouched
  });
  it("can turn the chain on (OFF by default) and off, and then the status says whether a chain is running", async () => {
    await settingsPOST(post("/settings", { pullback: { chainEnabled: true } }) as never);
    expect((await (await statusGET(get() as never)).json()).pullback.chainEnabled).toBe(true);
    await settingsPOST(post("/settings", { pullback: { chainEnabled: false } }) as never);
    expect((await (await statusGET(get() as never)).json()).pullback.chainEnabled).toBe(false);
    expect((await (await statusGET(get() as never)).json()).chainRunning).toBeNull();
  });
  it("refuses nonsense in words (400) and changes nothing", async () => {
    for (const bad of [{ fallUsd: 0 }, { minPeakUsd: -1 }, { minPeakUsd: 11 }, { chainMax: 2.5 }, { chainStopUsd: "x" }]) {
      const res = await settingsPOST(post("/settings", { pullback: bad }) as never);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    for (const bad of ["x", 5, null, [1]]) expect((await settingsPOST(post("/settings", { pullback: bad }) as never)).status).toBe(400);
    expect(botsStore.get(LIVE_BOT_ID)?.pullback).toBeUndefined();
  });
  it("a request with only pullback in it does not touch the daily loss limit or the stage, and it turns nothing ON", async () => {
    await settingsPOST(post("/settings", { pullback: { enabled: false } }) as never);
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false, stage: 1, dailyLossUsd: 2 });
  });
  it("needs a signed-in session", async () => {
    vi.stubEnv("APP_LOGIN_PASSWORD", "x-not-a-real-password");
    expect((await settingsPOST(post("/settings", { pullback: { enabled: false } }) as never)).status).toBe(401);
    expect(botsStore.get(LIVE_BOT_ID)?.pullback).toBeUndefined();
  });
});

describe("there is no separate mirror switch any more", () => {
  it("the mirror route does not exist, so nothing can turn the mirror ON by itself", () => {
    expect(fs.existsSync(path.join(__dirname, "mirror"))).toBe(false);
  });
});

describe("POST /live/check", () => {
  it("runs the check, shows the result, and turns nothing ON", async () => {
    const res = await checkPOST(post("/check", {}) as never);
    expect(res.status).toBe(200);
    expect((await res.json()).status.check).toMatchObject({ ok: true, marginMode: "ISOLATED_MARGIN", leverage: 10 });
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false });
    expect(fake.created).toHaveLength(0);
  });
  it("says so when there is no live key", async () => {
    g.__liveBybit = { executor: null, error: "no key" };
    const res = await checkPOST(post("/check", {}) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no live key/);
  });
});

describe("POST /live/settings", () => {
  it("sets the daily loss limit up to the $3 ceiling and refuses more", async () => {
    expect((await settingsPOST(post("/settings", { dailyLossUsd: 1.25 }) as never)).status).toBe(200);
    expect(readLiveSettings().dailyLossUsd).toBe(1.25);
    const res = await settingsPOST(post("/settings", { dailyLossUsd: 3.5 }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\$3/);
    expect(readLiveSettings().dailyLossUsd).toBe(1.25);
  });
  it("stage 2 is refused until the gate passes (it has not)", async () => {
    const res = await settingsPOST(post("/settings", { stage: 2 }) as never);
    expect(res.status).toBe(409);
    expect(readLiveSettings().stage).toBe(1);
    expect((await settingsPOST(post("/settings", {}) as never)).status).toBe(400);
    expect((await settingsPOST(post("/settings", { stage: 7 }) as never)).status).toBe(400);
  });
});

describe("the other doors to the live bot are shut", () => {
  it("the generic bot toggle cannot turn the live bot on", async () => {
    const res = await togglePOST(new NextRequest("http://localhost/api/automation/bots/x/toggle", { method: "POST" }) as never, params(LIVE_BOT_ID) as never);
    expect(res.status).toBe(409);
    expect(botsStore.get(LIVE_BOT_ID)?.enabled).toBe(false);
  });
  it("the kill switch turns the live switch OFF the moment it goes ON", async () => {
    await switchPOST(post("/switch", { on: true, confirm: true }) as never);
    expect(readLiveSettings().enabled).toBe(true);
    const res = await killPOST(new NextRequest("http://localhost/api/automation/bots/x/kill", { method: "POST" }) as never, params(LIVE_BOT_ID) as never);
    expect(res.status).toBe(200);
    expect(readLiveSettings().enabled).toBe(false);
    expect(botsStore.get(LIVE_BOT_ID)).toMatchObject({ enabled: false, killSwitch: true });
    // and ON is refused while it is on
    expect((await switchPOST(post("/switch", { on: true, confirm: true }) as never)).status).toBe(409);
  });
});
