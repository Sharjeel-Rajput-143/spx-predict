import "server-only";
import { NextResponse } from "next/server";
import type { ControlResult } from "./liveControl";
import { liveStatus } from "./liveControl";

/** Turns a control result into the route's answer: a refusal carries its status and its reason; success carries the fresh status for the page. */
export function respond(result: ControlResult<object>): NextResponse {
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, status: liveStatus() });
}
