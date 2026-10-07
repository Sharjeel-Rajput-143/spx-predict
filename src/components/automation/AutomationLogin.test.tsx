import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AutomationLogin, loginNotices } from "./AutomationLogin";

describe("what the sign-in dialog says", () => {
  it("says nothing extra when sign-in is set up and the host can keep records", () => {
    expect(loginNotices({ authRequired: true, signedIn: false, passwordConfigured: true, storageProblem: null })).toEqual({ blocked: false, messages: [] });
    expect(loginNotices(null)).toEqual({ blocked: false, messages: [] });
  });

  it("with no password set it blocks the form and says how to fix it", () => {
    const r = loginNotices({ authRequired: true, signedIn: false, passwordConfigured: false });
    expect(r.blocked).toBe(true);
    expect(r.messages[0]).toMatch(/APP_LOGIN_PASSWORD is not set/);
    expect(r.messages[0]).toMatch(/Environment Variables/);
  });

  it("a host that can't keep records says so, even with a password", () => {
    const r = loginNotices({ authRequired: true, signedIn: false, passwordConfigured: true, storageProblem: "This host can't write the bots' records" });
    expect(r.blocked).toBe(false);
    expect(r.messages[0]).toMatch(/can't run the engine/);
  });

  it("local development (no password required) is never blocked", () => {
    expect(loginNotices({ authRequired: false, signedIn: true, passwordConfigured: false }).blocked).toBe(false);
  });

  it("the form itself still renders, and shows a wrong password or a config error from the redirect", () => {
    const base = renderToStaticMarkup(<AutomationLogin next="/automations" />);
    expect(base).toContain("Sign in");
    expect(base).toContain('name="password"');
    expect(renderToStaticMarkup(<AutomationLogin next="/automations" error />)).toContain("Wrong email or password.");
    expect(renderToStaticMarkup(<AutomationLogin next="/automations" error="config" />)).toContain("APP_LOGIN_PASSWORD is not set");
  });
});
