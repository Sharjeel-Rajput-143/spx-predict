import { NextRequest, NextResponse } from "next/server";
import { loginConfigured } from "@/lib/auth/credentials";
import { isAuthOpenInProduction, isAuthRequired } from "@/lib/automation/config";
import { SESSION_COOKIE_NAME, isValidSession } from "@/lib/automation/session";
import { storageProblem } from "@/lib/automation/store";

/** Whether sign-in is in force and whether this browser is signed in - lets
 * the shell decide whether to show Log Out - plus whether this server is set up to sign anyone in. Reveals no secrets. */
export async function GET(req: NextRequest) {
  const signedIn = isValidSession(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  return NextResponse.json({
    authRequired: isAuthRequired(),
    // Sign-in is off in a production build (on purpose, or no password was set).
    authDisabled: isAuthOpenInProduction(),
    signedIn,
    // Lets the sign-in dialog say what's actually wrong when no password was ever set, or the host can't keep records.
    passwordConfigured: loginConfigured(),
    // Only to someone signed in: the text can name the server's folders.
    storageProblem: signedIn ? storageProblem() : null,
  });
}
