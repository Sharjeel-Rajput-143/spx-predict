import { NextRequest } from "next/server";
import { runAccountCheck } from "@/lib/automation/liveControl";
import { respond } from "@/lib/automation/liveRespond";
import { guarded, unauthorized } from "@/lib/automation/routeAuth";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * Runs the live account check now: asks Bybit what the live key may do, and (only while the account holds no position) sets isolated margin and the stage's leverage and
 * reads both back. Changes nothing else and turns nothing ON. Signed in only. With no live key it says so.
 */
async function handlePOST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => respond(await runAccountCheck()));
}

export const POST = withStorage(handlePOST);
