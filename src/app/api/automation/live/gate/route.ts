import { NextRequest, NextResponse } from "next/server";
import { liveGate } from "@/lib/automation/ledger";
import { guarded, unauthorized } from "@/lib/automation/routeAuth";
import { withStorage } from "@/lib/automation/withStorage";

/** The live gate as numbers: failure tests on the real demo account out of 6, whether the partial fill is proven on the fake exchange, clean counted trades out of 5, and why not if not. Read-only; it cannot change anything, and nothing here can turn live trading on. */
async function handleGET(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => NextResponse.json(liveGate()));
}

export const GET = withStorage(handleGET);
