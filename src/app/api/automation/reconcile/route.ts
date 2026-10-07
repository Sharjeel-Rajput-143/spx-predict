import { NextRequest, NextResponse } from "next/server";
import { badRequest, guarded, unauthorized } from "@/lib/automation/routeAuth";
import { flagMismatches, reconcile } from "@/lib/automation/reconcile";
import { executorStatus, sharedExecutor } from "@/lib/automation/sharedExecutor";
import { withStorage } from "@/lib/automation/withStorage";

/** "Check broker positions": reads what the broker holds and compares it with our open positions.
 * Reports and flags; never opens or closes anything. */
async function handlePOST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const status = executorStatus();
    if (status.venue !== "tradier") return badRequest("Nothing to check: the mock executor has no broker account.", 409);
    if (status.error) return badRequest(status.error, 409);
    const report = await reconcile(sharedExecutor);
    flagMismatches(report);
    return NextResponse.json({ report });
  });
}

export const POST = withStorage(handlePOST);
