import { NextRequest, NextResponse } from "next/server";
import { isAuthRequired } from "@/lib/automation/config";
import { SESSION_COOKIE_NAME, isValidSession } from "@/lib/automation/session";

/** Whether sign-in is in force and whether this browser is signed in - lets
 * the shell decide whether to show Log Out. Reveals nothing else. */
export async function GET(req: NextRequest) {
  return NextResponse.json({ authRequired: isAuthRequired(), signedIn: isValidSession(req.cookies.get(SESSION_COOKIE_NAME)?.value) });
}
