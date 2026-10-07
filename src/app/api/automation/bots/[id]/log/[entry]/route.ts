import { NextRequest, NextResponse } from "next/server";
import { withBotLock } from "@/lib/automation/botLock";
import { deleteLogEntry } from "@/lib/automation/logAdmin";
import { badRequest, guarded, unauthorized } from "@/lib/automation/routeAuth";
import { withStorage } from "@/lib/automation/withStorage";

/** Delete one entry of the bot's Log from the records. */
async function handleDELETE(req: NextRequest, { params }: { params: Promise<{ id: string; entry: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id, entry } = await params;
  return guarded(async () => {
    try {
      return NextResponse.json({ ok: true, ...(await withBotLock(id, async () => deleteLogEntry(id, entry))) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return badRequest(message, /not found|Unknown/.test(message) ? 404 : /too recent/.test(message) ? 409 : 400);
    }
  });
}

export const DELETE = withStorage(handleDELETE);
