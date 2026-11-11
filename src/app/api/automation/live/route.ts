import { NextRequest, NextResponse } from "next/server";
import { liveStatus } from "@/lib/automation/liveControl";
import { guarded, unauthorized } from "@/lib/automation/routeAuth";
import { withStorage } from "@/lib/automation/withStorage";

/** Everything the Live page shows: the switch, the mirror, the limits, the last account check, the gate numbers, the live bot and its trades. Read only; asks Bybit nothing; never returns a key. */
async function handleGET(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => NextResponse.json(liveStatus()));
}

export const GET = withStorage(handleGET);
