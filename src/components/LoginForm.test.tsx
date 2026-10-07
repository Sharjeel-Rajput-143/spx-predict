import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoginForm } from "./LoginForm";

describe("the sign-in page", () => {
  const html = renderToStaticMarkup(<LoginForm next="/automations" />);

  it("has labelled email and password fields, a show-password button and a Sign in button", () => {
    expect(html).toContain('for="login-email"');
    expect(html).toContain('id="login-password"');
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="Show password"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/); // nothing to send until both are filled in
  });

  it("tells what the app is, and promises nothing it doesn't do", () => {
    expect(html).toContain("TradingView in, trades out");
    expect(html).toContain("Testing mode and the mock executor run by default");
    expect(html).not.toMatch(/forgot password|sign up|google|facebook/i);
  });
});
