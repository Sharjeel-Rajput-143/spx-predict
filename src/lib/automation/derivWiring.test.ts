import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountPill, liveChipTip, ordersFooter, routingNote } from "@/components/automation/executorLabels";
import { executorKind, isBrokerKind } from "./executorKind";
import { RoutedExecutor } from "./routedExecutor";
import { executorStatus, getExecutor, isPaperStatus, sharedExecutor } from "./sharedExecutor";

const SET = { DERIV_API_TOKEN: "pat-secret-VALUE-1234", DERIV_APP_ID: "app-id-VALUE-5678", DERIV_ACCOUNT_ID: "VRTC1234567" };
const useDeriv = (extra: Record<string, string> = {}) => {
  vi.stubEnv("BROKER", "deriv");
  vi.stubEnv("EXECUTOR", "");
  for (const [k, v] of Object.entries({ ...SET, ...extra })) vi.stubEnv(k, v);
};

beforeEach(() => {
  (globalThis as { __automationExecutor?: unknown }).__automationExecutor = undefined; // the app keeps one executor per process; each test builds its own
  vi.stubEnv("BROKER", "");
  vi.stubEnv("EXECUTOR", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("choosing Deriv", () => {
  it("BROKER=deriv (and the older EXECUTOR=deriv) select it; internal stays the default; IBKR is still accepted but not advertised", () => {
    expect(executorKind({})).toBe("mock");
    expect(executorKind({ BROKER: "deriv" })).toBe("deriv");
    expect(executorKind({ EXECUTOR: "deriv" })).toBe("deriv");
    expect(executorKind({ BROKER: "internal" })).toBe("mock");
    expect(executorKind({ BROKER: "ibkr" })).toBe("ibkr"); // hidden, not removed
    expect(isBrokerKind({ BROKER: "deriv" })).toBe(true);
  });

  it("an unknown value is an error that lists only the advertised choices", () => {
    expect(() => executorKind({ BROKER: "nope" })).toThrow('BROKER must be "internal", "deriv" or "bybit" (or "tradier"), got "nope".');
    expect(() => executorKind({ EXECUTOR: "nope" })).toThrow(/"mock" or "tradier" \(or "deriv" or "bybit"\)/);
    expect(() => executorKind({ BROKER: "nope" })).not.toThrow(/ibkr/i);
    expect(() => executorKind({ BROKER: "deriv", EXECUTOR: "mock" })).toThrow(/disagree/);
  });
});

describe("the executor the app builds", () => {
  it("is Deriv for NDX behind the router, with the simulation for any other underlying", () => {
    useDeriv();
    const ex = getExecutor();
    expect(ex).toBeInstanceOf(RoutedExecutor);
    expect(ex.venue).toBe("deriv");
    expect((ex as RoutedExecutor).venueFor("NDX")).toBe("deriv");
    expect((ex as RoutedExecutor).venueFor("SPX")).toBe("mock");
    expect(typeof ex.getUnderlyingQuote).toBe("function");
    expect(typeof ex.isPaperAccount).toBe("function");
    expect(executorStatus().error).toBeNull();
  });

  it("a Deriv that is selected but not configured FAILS LOUDLY, naming what is missing, never a value", () => {
    vi.stubEnv("BROKER", "deriv");
    const s = executorStatus();
    expect(s).toMatchObject({ kind: "deriv", venue: "deriv" });
    expect(s.error).toMatch(/DERIV_API_TOKEN, DERIV_APP_ID, DERIV_ACCOUNT_ID are not set/);
    expect(() => getExecutor()).toThrow(/DERIV_API_TOKEN/);
    expect(() => sharedExecutor.placeOpenOrder({} as never)).toThrow(/DERIV_API_TOKEN/);
  });

  it("the status says Deriv, demo-safe by default, and a real account only when it was allowed on purpose", () => {
    useDeriv();
    expect(executorStatus()).toMatchObject({ kind: "deriv", venue: "deriv", error: null, sandbox: true, baseUrl: "https://api.derivws.com", bridgeSymbols: ["NDX"] });
    expect(isPaperStatus(executorStatus())).toBe(true);
    useDeriv({ DERIV_ALLOW_REAL: "true" });
    expect(executorStatus().sandbox).toBe(false);
    expect(isPaperStatus(executorStatus())).toBe(false); // test alerts are never run against real money
  });

  it("the status never carries the token or the app id", () => {
    useDeriv();
    const text = JSON.stringify(executorStatus());
    expect(text).not.toContain(SET.DERIV_API_TOKEN);
    expect(text).not.toContain(SET.DERIV_APP_ID);
  });

  it("PRICE_SOURCE=broker is allowed for Deriv (its own live price), and still refused for the simulation", () => {
    useDeriv({ PRICE_SOURCE: "broker" });
    expect(executorStatus().error).toBeNull();
    expect(executorStatus().priceSource).toBe("broker");
    vi.stubEnv("BROKER", "internal");
    expect(executorStatus().error).toMatch(/PRICE_SOURCE=broker needs a broker that can quote prices \(BROKER=deriv\)/);
  });

});

describe("what the screens say", () => {
  const demo = { venue: "deriv" as const, sandbox: true, bridgeSymbols: ["NDX"] };
  it("names Deriv, as demo money, and says which bots go there", () => {
    expect(accountPill(demo)).toEqual({ text: "Paper · Deriv (demo)", tone: "ok" });
    expect(routingNote(demo)).toMatch(/Orders for NDX go to Deriv\. A bot on any other underlying \(SPX\) runs on the internal simulation/);
    expect(ordersFooter(demo)).toBe("NDX orders go to the Deriv paper account; other bots use the simulation");
    expect(liveChipTip(demo)).toBe("Deriv paper account: no real money is involved");
  });
  it("a real Deriv account is shown as LIVE", () => {
    expect(accountPill({ ...demo, sandbox: false })).toEqual({ text: "LIVE · Deriv", tone: "error" });
    expect(liveChipTip({ ...demo, sandbox: false })).toBe("Deriv LIVE account: real money");
  });
});
