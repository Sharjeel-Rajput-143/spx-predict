import { NextResponse, type NextRequest } from "next/server";
import { SECRET_MISSING, loginConfigured, loginSwitchedOff, sessionKeyOrNull } from "@/lib/auth/credentials";
import { verifySession } from "@/lib/auth/sessionToken";

/**
 * The gate in front of the whole app: with a login configured, nothing opens without being signed in. A page sends you
 * to /login (and back to where you were); an API call gets 401. It also refuses a request that another website made
 * with your browser (see sameSite below), and fails closed when the server has no AUTH_SECRET.
 *
 * Open on purpose: the login page and its API, and the webhook URLs TradingView calls (/hook/<token> and
 * /api/webhook/...). Those have no cookie to send; each is protected by its own secret in the URL instead, and a
 * wrong one gets "not found".
 */
const OPEN = ["/login", "/api/login", "/api/automation/session", "/api/automation/status/login", "/api/automation/logout", "/hook/", "/api/webhook/"];
const WEBHOOKS = ["/hook/", "/api/webhook/"];
const startsWith = (pathname: string, list: string[]) => list.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`));

/** A write that comes from another website: the browser says where it came from (Origin), or that it is cross-site. */
function crossSite(req: NextRequest): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return false;
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    try {
      return new URL(origin).host !== host;
    } catch {
      return true;
    }
  }
  return req.headers.get("sec-fetch-site") === "cross-site";
}

export function proxy(req: NextRequest) {
  if (!loginConfigured() || loginSwitchedOff()) return NextResponse.next();
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  // TradingView's calls come from a server with no Origin: they are checked by their secret, not by where they came from.
  if (startsWith(pathname, WEBHOOKS)) return NextResponse.next();
  if (crossSite(req)) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  if (startsWith(pathname, OPEN)) return NextResponse.next();

  const key = sessionKeyOrNull();
  if (!key) return isApi ? NextResponse.json({ error: SECRET_MISSING }, { status: 503 }) : new NextResponse(SECRET_MISSING, { status: 503 });
  if (verifySession(req.cookies.get("automation_session")?.value, key)) return NextResponse.next();

  if (isApi) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const login = new URL("/login", req.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

// Everything except Next's own files and static assets.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|gif|css|js|txt|webmanifest)$).*)"] };
