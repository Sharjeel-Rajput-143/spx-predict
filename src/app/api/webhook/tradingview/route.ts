import { NextRequest, NextResponse } from "next/server";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { ingestWebhook } from "@/lib/automation/webhookIngest";
import { deferWork, withStorage } from "@/lib/automation/withStorage";

async function handlePOST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  // Return fast (TradingView gives up after about 3 seconds); the decision logic keeps running behind the answer.
  const result = ingestWebhook(body, { executor: sharedExecutor });
  return deferWork(NextResponse.json(result.body, { status: result.status }), result.processing);
}

export const POST = withStorage(handlePOST);
