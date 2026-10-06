import { NextRequest, NextResponse } from "next/server";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { ingestWebhook } from "@/lib/automation/webhookIngest";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  // Return fast; the decision logic keeps running in the background.
  const result = ingestWebhook(body, { executor: sharedExecutor });
  return NextResponse.json(result.body, { status: result.status });
}
