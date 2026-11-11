import { describe, expect, it } from "vitest";
import { FakeDeriv, ACCOUNT, APP_ID, TOKEN } from "../../src/lib/automation/derivTestSupport.ts";
import { blank, runCheck } from "./check.mjs";

const env = { DERIV_API_TOKEN: TOKEN, DERIV_APP_ID: APP_ID, DERIV_ACCOUNT_ID: ACCOUNT };
// The fake's socket is a factory; the script wants a class: wrap it.
const wsClass = (d) => class { constructor(url) { return d.socketFactory(url); } };

describe("the Deriv connection check", () => {
  it("read-only: signs in, connects, gets a price and a proposal, and buys nothing", async () => {
    const d = new FakeDeriv();
    const lines = await runCheck({ env, fetch: d.fetch, WebSocket: wsClass(d) });
    expect(lines.join("\n")).toMatch(/Signed in to account VRTC1234567: .* DEMO one/);
    expect(lines.join("\n")).toMatch(/latest price: 29284\.55/);
    expect(lines.join("\n")).toMatch(/Proposal for a CALL.*ask price 10/);
    expect(d.calls("buy")).toHaveLength(0);
  });

  it("--trade buys one demo CALL, logs the CONTRACT ID, and sells it", async () => {
    const d = new FakeDeriv();
    d.saleValue = 11;
    const lines = (await runCheck({ env, fetch: d.fetch, WebSocket: wsClass(d), trade: true })).join("\n");
    expect(lines).toMatch(/CONTRACT ID 987654321/);
    expect(lines).toMatch(/Sold contract 987654321 for 11/);
    expect(d.calls("sell")[0]).toMatchObject({ sell: 987654321, price: 0 });
    expect(lines).toMatch(/All steps passed/);
  });

  it("fails loudly on a missing setting, a refused sign-in, and a real account - and never prints a secret", async () => {
    await expect(runCheck({ env: {}, fetch: () => {}, WebSocket: class {} })).rejects.toThrow(/Missing settings: DERIV_API_TOKEN, DERIV_APP_ID, DERIV_ACCOUNT_ID/);
    const d = new FakeDeriv();
    const err = await runCheck({ env: { ...env, DERIV_API_TOKEN: "wrong-VALUE-9" }, fetch: d.fetch, WebSocket: wsClass(d) }).catch((e) => e);
    expect(err.message).toMatch(/1\. FAILED: Deriv refused the sign-in \(HTTP 401, InvalidToken\)/);
    expect(err.message).not.toContain("wrong-VALUE-9");
    const real = new FakeDeriv();
    real.otpUrl = "wss://api.derivws.com/trading/v1/options/ws/real?otp=otp-1";
    const r = await runCheck({ env, fetch: real.fetch, WebSocket: wsClass(real), trade: true }).catch((e) => e);
    expect(r.message).toMatch(/not a demo account/);
    expect(real.sent).toEqual([]);
  });

  it("blanks secrets in text, skipping empty ones", () => {
    expect(blank("a TOKEN b", ["TOKEN", ""])).toBe("a *** b");
    expect(blank("HTTP 401", ["0"])).toBe("HTTP 401"); // a short value would blank ordinary digits
  });
});
