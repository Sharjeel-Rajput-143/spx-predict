import { NextRequest, NextResponse } from "next/server";
import { ensureBotRecord, getBotStaticConfig, isKnownBot } from "@/lib/automation/bots";
import { LIVE_BOT_ID } from "@/lib/automation/bybitLiveLimits";
import { SESSION_COOKIE_NAME, isValidSession } from "@/lib/automation/session";
import { botsStore } from "@/lib/automation/store";
import { withStorage } from "@/lib/automation/withStorage";

async function handlePOST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!isValidSession(token)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { id } = await params;
  if (!isKnownBot(id)) return NextResponse.json({ error: "Unknown bot." }, { status: 404 });

  // The live bot follows the live switch and nothing else: it is turned on and off on the Live page, with the word LIVE typed.
  if (id === LIVE_BOT_ID) return NextResponse.json({ error: "The live bot is turned on and off on the Live page only." }, { status: 409 });

  const bot = ensureBotRecord(id);
  const enabled = !bot.enabled;
  // Never switch on a bot that can't trade yet: say what's missing instead.
  if (enabled) {
    try {
      getBotStaticConfig(id);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "This bot isn't set up yet." }, { status: 409 });
    }
  }
  // Re-enabling is the operator's acknowledgement of needs_attention - clear
  // it so it doesn't stay stuck after they've looked into it.
  const updated = botsStore.update(id, {
    enabled,
    ...(enabled ? { needsAttention: false, needsAttentionReason: null, archived: false } : {}),
  });

  return NextResponse.json({ bot: updated });
}

export const POST = withStorage(handlePOST);
