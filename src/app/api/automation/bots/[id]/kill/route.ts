import { NextRequest, NextResponse } from "next/server";
import { ensureBotRecord, isKnownBot } from "@/lib/automation/bots";
import { SESSION_COOKIE_NAME, isValidSession } from "@/lib/automation/session";
import { botsStore } from "@/lib/automation/store";
import { withStorage } from "@/lib/automation/withStorage";

/** The kill switch: while on, a webhook run for this bot does nothing at all (no close, no open). Only a person
 * turns it on or off. The end-of-day sweep and the Close position button are never blocked by it. */
async function handlePOST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!isValidSession(token)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { id } = await params;
  if (!isKnownBot(id)) return NextResponse.json({ error: "Unknown bot." }, { status: 404 });

  const bot = ensureBotRecord(id);
  const updated = botsStore.update(id, { killSwitch: !bot.killSwitch });
  return NextResponse.json({ bot: updated });
}

export const POST = withStorage(handlePOST);
