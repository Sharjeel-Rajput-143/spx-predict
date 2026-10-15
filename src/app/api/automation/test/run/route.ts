import { NextRequest, NextResponse } from "next/server";
import { badRequest, unauthorized } from "@/lib/automation/routeAuth";
import { decisionsStore, runsStore, signalsStore } from "@/lib/automation/store";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * How a test alert is getting on: GET ?signalId=... says whether its run has finished (the run is written when it ends) and what was decided
 * so far. A test call answers after at most 45 seconds, but an order walking a price ladder can take about 2.5 minutes, so the screen asks
 * again here until the run is over, instead of leaving "(still working…)" up for good. Read-only; signed-in only.
 */
async function handleGET(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const signalId = req.nextUrl.searchParams.get("signalId");
  if (!signalId || signalId.length > 200) return badRequest("signalId is required.");
  if (!signalsStore.get(signalId)) return badRequest("Unknown test alert.", 404);
  const finished = runsStore.query((r) => r.signalId === signalId).length > 0;
  const decisions = decisionsStore.query((d) => d.signalId === signalId).sort((a, b) => a.createdAt - b.createdAt).map((d) => ({ outcome: d.outcome, reason: d.reason }));
  return NextResponse.json({ finished, decisions });
}

export const GET = withStorage(handleGET);
