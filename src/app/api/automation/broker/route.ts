import { NextRequest, NextResponse } from "next/server";
import { guarded, unauthorized } from "@/lib/automation/routeAuth";
import { executorStatus, sharedExecutor } from "@/lib/automation/sharedExecutor";
import { withStorage } from "@/lib/automation/withStorage";

/** The broker account behind the executor: which one, and its balances (read-only). Nothing here can trade. */
async function handleGET(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const status = executorStatus();
    if (status.venue === "mock" || status.error || !sharedExecutor.getBalances) {
      return NextResponse.json({ venue: status.venue, sandbox: status.sandbox ?? null, error: status.error, balances: null });
    }
    try {
      return NextResponse.json({ venue: status.venue, sandbox: status.sandbox ?? null, error: null, balances: await sharedExecutor.getBalances() });
    } catch (err) {
      return NextResponse.json({ venue: status.venue, sandbox: status.sandbox ?? null, error: err instanceof Error ? err.message : String(err), balances: null });
    }
  });
}

export const GET = withStorage(handleGET);
