import { NextRequest, NextResponse } from "next/server";
import { getBotStaticConfig, isKnownBot } from "@/lib/automation/bots";
import { withBotLock } from "@/lib/automation/botLock";
import { processSignal, receiveAndSaveSignal } from "@/lib/automation/engine";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { sharedExecutor } from "@/lib/automation/sharedExecutor";
import { decisionsStore, signalsStore } from "@/lib/automation/store";
import { getLastTick } from "@/lib/marketData/tickStore";
import { withStorage } from "@/lib/automation/withStorage";

/** Runs the bot's logic once, as if that signal had just arrived by webhook.
 * It goes through the same lock, guards and decision log; the saved signal is
 * marked manual. Returns what the engine decided. */
async function handlePOST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  if (!isKnownBot(id)) return badRequest("Unknown bot.", 404);

  return guarded(async () => {
    const body = await readJson(req);
    const signal = body.signal;
    if (signal !== "bullish" && signal !== "bearish") return badRequest('signal must be "bullish" or "bearish".');

    // The signal carries the bot's own underlying (NDX bot -> NDX), and only SPX has a live quote to default to.
    let underlying = "SPX";
    try {
      underlying = getBotStaticConfig(id).underlying;
    } catch {
      /* no complete inputs yet: the engine logs config_error for it */
    }
    const lastSignalPrice = signalsStore.query((s) => s.botId === id && s.status === "accepted").at(-1)?.price;
    const price = typeof body.price === "number" && Number.isFinite(body.price) ? body.price : (getLastTick(underlying)?.price ?? lastSignalPrice);
    if (price === undefined || !Number.isFinite(price)) return badRequest("Enter a price - there's no live quote or earlier signal to default to.");

    const now = Date.now();
    const saved = receiveAndSaveSignal({
      botId: id,
      signal,
      price,
      barTime: `manual-${new Date(now).toISOString()}`,
      interval: "manual",
      raw: { source: "manual", symbol: underlying },
      now,
    });
    await withBotLock(id, () => processSignal(saved, { executor: sharedExecutor }));
    return NextResponse.json({ signalId: saved.id, decisions: decisionsStore.query((d) => d.signalId === saved.id) });
  });
}

export const POST = withStorage(handlePOST);
