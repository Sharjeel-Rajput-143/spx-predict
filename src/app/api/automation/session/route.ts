import { NextRequest, NextResponse } from "next/server";
import { isAuthOpenInProduction, isAuthRequired } from "@/lib/automation/config";
import { SESSION_COOKIE_NAME, isValidSession } from "@/lib/automation/session";
import { storageProblem } from "@/lib/automation/store";

/** Whether sign-in is in force and whether this browser is signed in - lets
 * the shell decide whether to show Log Out - plus whether this server is set up to sign anyone in. Reveals no secrets. */
export async function GET(req: NextRequest) {
  return NextResponse.json({
    authRequired: isAuthRequired(),
    // Sign-in is off in a production build (on purpose, or no password was set): the app warns on every page.
    authDisabled: isAuthOpenInProduction(),
    signedIn: isValidSession(req.cookies.get(SESSION_COOKIE_NAME)?.value),
    // Lets the sign-in dialog say what's actually wrong when no password was ever set, or the host can't keep records.
    passwordConfigured: Boolean(process.env.AUTOMATION_STATUS_PASSWORD),
    storageProblem: storageProblem(),
  });
}
