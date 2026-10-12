import { NextRequest, NextResponse } from "next/server";
import { hindsight } from "@/lib/automation/hindsight";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { positionsStore } from "@/lib/automation/store";
import { withStorage } from "@/lib/automation/withStorage";
import { fetchYahooDailyClose } from "@/lib/marketData/yahooFinance";

/** The Hindsight Report for the positions the Analyze view is showing (their ids): what holding them to expiry would have made,
 * from each expiry day's official close. Reads only; nothing is changed or sent. */
async function handlePOST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const body = await readJson(req);
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length > 10_000 || ids.some((x) => typeof x !== "string")) return badRequest("Send {\"ids\": [position ids]} (at most 10,000).");
    const wanted = new Set(ids as string[]);
    const report = await hindsight(positionsStore.query((p) => wanted.has(p.id)), Date.now(), (symbol, dateKey) => fetchYahooDailyClose(symbol, dateKey));
    return NextResponse.json(report);
  });
}

export const POST = withStorage(handlePOST);
