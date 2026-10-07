import { NextRequest, NextResponse } from "next/server";
import { SECRET_MISSING, checkCredentials, clearFailures, loginConfigured, lockedOut, recordFailure, safeNext, sessionKeyOrNull } from "@/lib/auth/credentials";
import { SESSION_COOKIE_NAME, createSession } from "@/lib/automation/session";
import { getAppSettings } from "@/lib/automation/appSettings";

const NO_STORE = { "Cache-Control": "no-store" };
const who = (req: NextRequest) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";

/** The sign-in form posts here: email and password, checked against the login set in the environment. On success the
 * session cookie is set (signed, HttpOnly, expires with the session timeout) and the page to open next is returned. */
export async function POST(req: NextRequest) {
  if (!loginConfigured()) {
    return NextResponse.json({ error: "Sign-in isn't set up on this server: APP_LOGIN_EMAIL and APP_LOGIN_PASSWORD are not set." }, { status: 503, headers: NO_STORE });
  }
  if (!sessionKeyOrNull()) return NextResponse.json({ error: SECRET_MISSING }, { status: 503, headers: NO_STORE });
  const body = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown; next?: unknown } | null;
  const key = who(req);
  if (lockedOut(key)) {
    console.warn(`[auth] sign-in refused (too many wrong tries) from ${key}`);
    return NextResponse.json({ error: "Too many wrong tries. Wait 15 minutes and try again." }, { status: 429, headers: { ...NO_STORE, "Retry-After": "900" } });
  }

  if (!checkCredentials(body?.email, body?.password)) {
    recordFailure(key);
    console.warn(`[auth] wrong sign-in from ${key}`);
    // A short, fixed pause on every wrong answer slows guessing down further.
    await new Promise((r) => setTimeout(r, process.env.NODE_ENV === "test" ? 0 : 400));
    return NextResponse.json({ error: "Wrong email or password." }, { status: 401, headers: NO_STORE });
  }
  console.info(`[auth] signed in from ${key}`);
  clearFailures(key);
  const res = NextResponse.json({ ok: true, next: safeNext(body?.next) }, { headers: NO_STORE });
  res.cookies.set(SESSION_COOKIE_NAME, createSession(), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: getAppSettings().sessionTimeoutMinutes * 60,
    path: "/",
  });
  return res;
}
