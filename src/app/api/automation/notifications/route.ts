import { NextRequest, NextResponse } from "next/server";
import { clearNotifications, listNotifications, markAllRead, markRead } from "@/lib/automation/notifications";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import type { CollectionName } from "@/lib/automation/storage/repository";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * The bell's list. Signed-in only, and each person sees only their own.
 *   GET     the newest 50 and how many are unread in all (the page asks every 20 seconds or so)
 *   PATCH   { "ids": [...] } marks those read, { "all": true } marks every one read
 *   DELETE  { "ids": [...] } removes those, { "all": true } clears the list
 * Nothing here can place, change or stop a trade.
 */
const LOAD = { load: ["notifications", "bots"] as CollectionName[] };

const MAX_IDS = 200;
function idsOf(body: Record<string, unknown>): string[] | null {
  if (!Array.isArray(body.ids)) return null;
  if (body.ids.length > MAX_IDS || !body.ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)) throw new Error("ids must be a list of notification ids.");
  return body.ids as string[];
}

async function handleGET(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(() => NextResponse.json({ ...listNotifications(), serverTime: Date.now() }));
}

async function handlePATCH(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const body = await readJson(req);
    const ids = idsOf(body);
    if (body.all === true) return NextResponse.json({ changed: markAllRead(), ...listNotifications() });
    if (!ids) return badRequest('Send {"ids": [...]} or {"all": true}.');
    return NextResponse.json({ changed: markRead(ids), ...listNotifications() });
  });
}

async function handleDELETE(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const body = await readJson(req);
    const ids = idsOf(body);
    // Clearing everything has to be asked for in so many words: an empty body never clears.
    if (body.all === true) return NextResponse.json({ removed: clearNotifications(), ...listNotifications() });
    if (!ids) return badRequest('Send {"ids": [...]} or {"all": true}.');
    return NextResponse.json({ removed: clearNotifications(ids), ...listNotifications() });
  });
}

export const GET = withStorage(handleGET, LOAD);
export const PATCH = withStorage(handlePATCH, LOAD);
export const DELETE = withStorage(handleDELETE, LOAD);
