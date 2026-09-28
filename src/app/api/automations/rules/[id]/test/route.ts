import { NextRequest, NextResponse } from "next/server";
import { decryptSecret } from "@/lib/automations/crypto";
import { describeRule } from "@/lib/automations/describe";
import { evaluateRule } from "@/lib/automations/engine";
import { checkRateLimit } from "@/lib/automations/rateLimit";
import { connectionsStore, DEMO_USER_ID, rulesStore } from "@/lib/automations/store";
import { sendTestWebhook } from "@/lib/automations/webhookQueue";
import { getServerBarsForced } from "@/lib/marketData/serverBars";
import { isLiveSymbol } from "@/lib/marketData/tickStore";

const BARS_NEEDED = 260; // enough warm-up room for the slowest default indicator settings

/**
 * Manually fires a rule's webhook once, so it can be validated without
 * waiting for market hours or a real signal - and without touching the
 * rule's lastTriggeredAt/lastEvaluatedBarTime bookkeeping the real
 * scheduler owns (spec: a test must never look like a real trigger).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rule = rulesStore.get(id);
  if (!rule || rule.userId !== DEMO_USER_ID) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (!checkRateLimit(DEMO_USER_ID, "test-alert", 20, 60 * 60_000)) {
    return NextResponse.json({ error: "Too many test alerts sent recently. Try again later." }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const source: "mock" | "live" = body.source === "live" ? "live" : "mock";
  if (source === "live" && !isLiveSymbol(rule.symbol)) {
    return NextResponse.json({ error: `${rule.symbol} has no live data source - test against mock instead.` }, { status: 400 });
  }

  const connection = connectionsStore.get(rule.connectionId);
  if (!connection) {
    return NextResponse.json({ error: "This rule's connection no longer exists." }, { status: 400 });
  }

  const bars = getServerBarsForced(rule.symbol, rule.timeframe, BARS_NEEDED, source);
  if (bars.length < 2) {
    return NextResponse.json(
      {
        error:
          source === "live"
            ? "No live price observed yet for this symbol - try again in a moment, or test against mock."
            : "Not enough bar history yet.",
      },
      { status: 400 },
    );
  }

  const result = evaluateRule(rule, bars);
  if (!result) {
    return NextResponse.json({ error: "Not enough data to compute this rule's indicators yet (warm-up period)." }, { status: 400 });
  }

  const url = decryptSecret(connection.webhookUrlEncrypted);
  const payload = {
    test: true,
    symbol: rule.symbol,
    timeframe: rule.timeframe,
    condition: describeRule(rule),
    message: rule.message,
    values: { a: result.valueA, b: result.valueB },
    firedAt: new Date(result.barTime).toISOString(),
  };

  const delivery = await sendTestWebhook({ ruleId: rule.id, url, payload });
  return NextResponse.json({
    ok: delivery.ok,
    statusCode: delivery.statusCode,
    error: delivery.error,
    source,
    conditionCurrentlyTrue: result.triggered,
  });
}
