import { NextRequest, NextResponse } from "next/server";
import { getBotStaticConfig, listBotIds } from "@/lib/automation/bots";
import { SESSION_COOKIE_NAME, isValidSession } from "@/lib/automation/session";
import { botsStore, ordersStore, positionsStore, signalsStore } from "@/lib/automation/store";
import { settleExpiredFromClose } from "@/lib/automation/settleExpired";
import { deferWork, withStorage } from "@/lib/automation/withStorage";

/** Every position across every bot, newest first, plus what the drawer needs
 * (orders, the signals that opened/closed each one, each bot's name and the
 * credit estimate used until a fill reports a real one). */
async function handleGET(req: NextRequest) {
  if (!isValidSession(req.cookies.get(SESSION_COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const bots = listBotIds().map((id) => {
    try {
      const c = getBotStaticConfig(id);
      return { id, name: c.name, estimate: c.openingCreditEstimate, accountId: c.accountId as string | null, group: botsStore.get(id)?.group ?? null };
    } catch {
      const record = botsStore.get(id);
      return { id, name: record?.name ?? id, estimate: null, accountId: (record?.draftInputs?.accountId ?? null) as string | null, group: record?.group ?? null };
    }
  });

  const positions = positionsStore.all().sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
  const signalIds = new Set(positions.flatMap((p) => [p.openSignalId, p.closeSignalId]).filter((id): id is string => !!id));

  return NextResponse.json({
    now: Date.now(),
    bots,
    positions,
    orders: ordersStore.all(),
    signals: signalsStore.query((s) => signalIds.has(s.id)),
  });
}

// After the answer: expired positions with no result are settled from that day's closing price (shows on the next refresh).
export const GET = withStorage(async (req: NextRequest) => deferWork(await handleGET(req), () => settleExpiredFromClose().catch(() => 0)));
