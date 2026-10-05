import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, destroySession } from "@/lib/automation/session";

export async function POST(req: NextRequest) {
  destroySession(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return res;
}
