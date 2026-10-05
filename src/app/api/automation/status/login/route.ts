import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getStatusPagePassword, isAuthRequired } from "@/lib/automation/config";
import { createSession, SESSION_COOKIE_NAME } from "@/lib/automation/session";

/** Plain-form POST (no client JS needed) - checks the password, then
 * redirects back to the status page, setting the session cookie on success. */
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const password = form?.get("password");
  // No password configured (local dev): nothing to sign in to.
  const expected = isAuthRequired() ? getStatusPagePassword() : "";

  const ok =
    !isAuthRequired() ||
    (typeof password === "string" &&
    password.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(password), Buffer.from(expected)));

  // Only ever send the user back to another automation page.
  const next = form?.get("next");
  const target = typeof next === "string" && /^\/(automations?|positions|settings)(\/[\w\-/]*)?(\?tab=\w+)?$/.test(next) ? next : "/automation/status";
  const redirectUrl = new URL(target, req.url);
  if (!ok) {
    redirectUrl.searchParams.set("error", "1");
    return NextResponse.redirect(redirectUrl, { status: 303 });
  }

  const res = NextResponse.redirect(redirectUrl, { status: 303 });
  res.cookies.set(SESSION_COOKIE_NAME, createSession(), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 12,
    path: "/",
  });
  return res;
}
