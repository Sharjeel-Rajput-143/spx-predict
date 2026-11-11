import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, isValidSession, renewSession } from "@/lib/automation/session";
import { withStorage } from "@/lib/automation/withStorage";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The page calls this while the person is really using it (a click, a key, a scroll - never on a timer), and the sign-in
 * is extended: the idle timeout starts again, up to the 24 hour limit since the password was typed. Background refreshes
 * of the data do not call it, so a page left open and untouched still signs out. The proxy has already refused anyone
 * who is not signed in; the check here also refuses a token that was signed out.
 */
async function handlePOST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!isValidSession(token)) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  const renewed = renewSession(token);
  const res = NextResponse.json({ ok: true, renewed: renewed !== null }, { headers: NO_STORE });
  if (renewed) {
    res.cookies.set(SESSION_COOKIE_NAME, renewed.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      maxAge: renewed.maxAgeSeconds,
      path: "/",
    });
  }
  return res;
}

export const POST = withStorage(handlePOST);
