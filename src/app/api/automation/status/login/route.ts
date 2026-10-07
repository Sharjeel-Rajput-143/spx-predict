import { NextRequest, NextResponse } from "next/server";
import { checkCredentials, clearFailures, loginConfigured, lockedOut, recordFailure, sessionKeyOrNull } from "@/lib/auth/credentials";
import { isAuthRequired } from "@/lib/automation/config";
import { createSession, SESSION_COOKIE_NAME } from "@/lib/automation/session";

/** Plain-form POST (no client JS needed) - checks the password, then
 * redirects back to the status page, setting the session cookie on success. */
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  // Sign-in is required but no password was ever set on this server: say so, instead of an opaque 500.
  const misconfigured = isAuthRequired() && (!loginConfigured() || !sessionKeyOrNull());
  if (misconfigured) {
    const back = new URL("/automation/status", req.url);
    back.searchParams.set("error", "config");
    return NextResponse.redirect(back, { status: 303 });
  }
  const who = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  // No password configured (local dev): nothing to sign in to.
  const ok = !isAuthRequired() || (!lockedOut(who) && checkCredentials(form?.get("email"), form?.get("password")));
  if (isAuthRequired()) (ok ? clearFailures : recordFailure)(who);

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
    sameSite: "strict",
    maxAge: 60 * 60 * 12,
    path: "/",
  });
  return res;
}
