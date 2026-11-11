import { NextRequest } from "next/server";
import { chooseStage, setDailyLoss, setLivePullback } from "@/lib/automation/liveControl";
import { respond } from "@/lib/automation/liveRespond";
import { guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * The live choices that are not switches: { pullback } (the live bot's own pullback exit / chain values, the same rules as the demo bot's), { dailyLossUsd } (above 0, at most the $3 ceiling in the code) and { stage } (1 = $10 at 10x isolated, 2 = up to $35 at 3x isolated,
 * only when the live gate has passed). Changing the stage turns the live switch OFF. These can never turn anything ON.
 */
async function handlePOST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const body = await readJson(req);
    if (body.dailyLossUsd === undefined && body.stage === undefined && body.pullback === undefined) throw new Error("Send dailyLossUsd, stage, pullback, or a mix.");
    if (body.pullback !== undefined) {
      const r = setLivePullback(body.pullback);
      if (!r.ok) return respond(r);
    }
    if (body.dailyLossUsd !== undefined) {
      const r = setDailyLoss(body.dailyLossUsd);
      if (!r.ok) return respond(r);
    }
    if (body.stage !== undefined) {
      const r = chooseStage(body.stage);
      if (!r.ok) return respond(r);
    }
    return respond({ ok: true });
  });
}

export const POST = withStorage(handlePOST);
