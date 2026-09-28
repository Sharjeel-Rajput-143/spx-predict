import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { encryptSecret, maskWebhookUrl } from "@/lib/automations/crypto";
import { checkRateLimit } from "@/lib/automations/rateLimit";
import { connectionsStore, DEMO_USER_ID } from "@/lib/automations/store";
import type { AlertConnection, AlertConnectionView, AutomationPlatform } from "@/lib/automations/types";
import { isSafeWebhookUrl } from "@/lib/automations/urlValidation";

const PLATFORMS: AutomationPlatform[] = ["Option Alpha"];

function toView(c: AlertConnection): AlertConnectionView {
  const { webhookUrlEncrypted: _omit, ...view } = c;
  return view;
}

export async function GET() {
  const connections = connectionsStore.query((c) => c.userId === DEMO_USER_ID).map(toView);
  return NextResponse.json({ connections });
}

export async function POST(req: NextRequest) {
  if (!checkRateLimit(DEMO_USER_ID, "create-connection", 20, 60 * 60_000)) {
    return NextResponse.json({ error: "Too many connections created recently. Try again later." }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const platform = body?.platform;
  const webhookUrl = typeof body?.webhookUrl === "string" ? body.webhookUrl.trim() : "";

  if (!label) return NextResponse.json({ error: "Label is required." }, { status: 400 });
  if (!PLATFORMS.includes(platform)) return NextResponse.json({ error: "Unsupported platform." }, { status: 400 });

  const safety = await isSafeWebhookUrl(webhookUrl);
  if (!safety.ok) return NextResponse.json({ error: safety.reason }, { status: 400 });

  const connection: AlertConnection = {
    id: crypto.randomUUID(),
    userId: DEMO_USER_ID,
    platform,
    label,
    webhookUrlEncrypted: encryptSecret(webhookUrl),
    maskedUrl: maskWebhookUrl(webhookUrl),
    active: true,
    createdAt: Date.now(),
  };
  connectionsStore.insert(connection);
  // The plaintext URL is never in this response, not even once (spec 2.2).
  return NextResponse.json({ connection: toView(connection) }, { status: 201 });
}
