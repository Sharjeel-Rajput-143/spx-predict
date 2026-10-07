import { NextRequest, NextResponse } from "next/server";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { ingestWebhook, settleIfServerless } from "@/lib/automation/webhookIngest";
import { withStorage } from "@/lib/automation/withStorage";

async function handlePOST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  // Return fast; the decision logic keeps running in the background.
  const result = ingestWebhook(body, { executor: sharedExecutor });
  await settleIfServerless(result);
  return NextResponse.json(result.body, { status: result.status });
}

export const POST = withStorage(handlePOST);
