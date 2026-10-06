import { NextRequest, NextResponse } from "next/server";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { executorStatus } from "@/lib/automation/sharedExecutor";
import { resetTestData } from "@/lib/automation/testing";

/** Wipes the recorded test data (signals, positions, orders, decisions, runs,
 * errors). Mock executor only: with a real broker selected, what's recorded
 * is not test data and this refuses. */
export async function POST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const body = await readJson(req);
    if (body.confirm !== true) return badRequest("Send {\"confirm\": true} to reset the test data.");
    if (executorStatus().venue !== "mock") return badRequest("Reset is only available on the mock executor.", 409);
    return NextResponse.json({ cleared: resetTestData() });
  });
}
