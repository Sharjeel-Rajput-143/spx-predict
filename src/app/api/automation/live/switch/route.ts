import { NextRequest } from "next/server";
import { tidyMirror, turnSwitchOff, turnSwitchOn } from "@/lib/automation/liveControl";
import { respond } from "@/lib/automation/liveRespond";
import { guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { withStorage } from "@/lib/automation/withStorage";

/**
 * The master toggle "Live trading". { on: false } turns it OFF at once (signed in is enough; one click, no confirm; the mirror stays ON only while a live position is held).
 * { on: true, confirm: true } turns it ON (and the mirror with it) only if a live key is present and the account check passes right now. Without confirm: true it is refused. There is no
 * typed word. Anything else is a refusal that says why. The ON state is saved and resumed by itself after a restart when nothing had tripped (see liveControl.ts).
 */
async function handlePOST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const body = await readJson(req);
    if (body.on === false) {
      const result = respond(turnSwitchOff());
      void tidyMirror(); // after the answer is built: turns the mirror OFF now if no live position is held
      return result;
    }
    if (body.on === true) return respond(await turnSwitchOn(body.confirm));
    throw new Error('Send { "on": true, "confirm": true } or { "on": false }.');
  });
}

export const POST = withStorage(handlePOST);
