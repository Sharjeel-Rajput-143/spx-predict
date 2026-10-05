import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, isValidSession } from "./session";

/** Returns a 401 response when the request isn't signed in (or null to proceed). */
export function unauthorized(req: NextRequest): NextResponse | null {
  return isValidSession(req.cookies.get(SESSION_COOKIE_NAME)?.value) ? null : NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

export const badRequest = (message: string, status = 400) => NextResponse.json({ error: message }, { status });

/** Runs a handler body, turning a thrown Error into a 400 with its message. */
export async function guarded(fn: () => Promise<NextResponse> | NextResponse): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Malformed request body.");
  return body as Record<string, unknown>;
}
