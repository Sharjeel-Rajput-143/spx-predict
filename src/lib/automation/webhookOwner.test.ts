import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as hookRoute } from "@/app/api/webhook/hook/[token]/route";
import { userIdForEmail } from "@/lib/auth/users";
import { ensureBotRecord } from "./bots";
import { storage, webhooksStore } from "./store";
import { NDX_BOT_ID, resetAutomationStores, setNdxTestEnv } from "./testSupport";
import { runAs } from "./userContext";
import { createWebhook } from "./webhooks";

/**
 * Why the Settings page showed no webhooks after they had been created from outside the app (seen on the real app). Records belong to an OWNER, taken from APP_LOGIN_EMAIL at
 * the moment they are written; a signed-in page shows a person only their own. A webhook written by a process that did not know APP_LOGIN_EMAIL belonged to the fallback owner
 * ("operator"), so the webhook route (which sees everything, as TradingView has no login) found it while the signed-in Settings page did not.
 */
vi.mock("@/lib/marketData/tickStore", () => ({ waitForTick: async () => ({ t: Date.now(), price: 29_310.4 }), getLastTick: () => null, isLiveSymbol: () => false }));

const ME = "me@example.com";
const myId = userIdForEmail(ME);
const mine = () => runAs(myId, () => webhooksStore.all().map((w) => w.name));

beforeEach(() => {
  resetAutomationStores();
  setNdxTestEnv();
  ensureBotRecord(NDX_BOT_ID);
  vi.stubEnv("AUTOMATION_TEST_MODE", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("whose webhook it is", () => {
  it("one made by a process that does not know the owner belongs to the fallback owner: the owner's signed-in pages do not list it, but the webhook route still finds it", async () => {
    vi.stubEnv("APP_LOGIN_EMAIL", ""); // the other process: no owner known
    const hook = createWebhook({ name: "Bybit bullish", botId: NDX_BOT_ID, direction: "bullish" });
    expect(hook.userId).toBe(userIdForEmail("operator"));
    vi.stubEnv("APP_LOGIN_EMAIL", ME); // the app, as the signed-in owner sees it
    expect(mine()).toEqual([]); // the empty Settings list
    const res = await hookRoute(new NextRequest(`http://localhost/api/webhook/hook/${hook.token}`, { method: "POST", body: "bullish" }), { params: Promise.resolve({ token: hook.token }) });
    expect(res.status).not.toBe(404); // TradingView's call still finds it: no login, so it sees every record
  });

  it("the same webhook made while the owner IS known belongs to the owner and is listed", async () => {
    vi.stubEnv("APP_LOGIN_EMAIL", ME);
    createWebhook({ name: "Bybit bullish", botId: NDX_BOT_ID, direction: "bullish" });
    expect(mine()).toEqual(["Bybit bullish"]);
  });

  it("restamping it to the owner (what the repair does) makes it appear", () => {
    vi.stubEnv("APP_LOGIN_EMAIL", "");
    const hook = createWebhook({ name: "Bybit bullish", botId: NDX_BOT_ID, direction: "bullish" });
    vi.stubEnv("APP_LOGIN_EMAIL", ME);
    expect(mine()).toEqual([]);
    storage.repository<{ id: string; userId?: string }>("webhooks").update(hook.id, { userId: myId });
    expect(mine()).toEqual(["Bybit bullish"]);
  });
});
