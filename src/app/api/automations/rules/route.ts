import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { TICKERS, TIMEFRAMES } from "@/lib/config";
import { checkRateLimit } from "@/lib/automations/rateLimit";
import { startAutomationScheduler } from "@/lib/automations/scheduler";
import { connectionsStore, DEMO_USER_ID, rulesStore } from "@/lib/automations/store";
import { describeRule } from "@/lib/automations/describe";
import type { AlertRule, RuleOperand } from "@/lib/automations/types";
import { INDICATOR_DEFS, type IndicatorKind } from "@/lib/indicators/registry";

const CONDITIONS = new Set(["crossing_up", "crossing_down", "greater_than", "less_than", "crosses_value"]);

function parseOperand(raw: unknown): RuleOperand | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.mode === "value") {
    const value = Number(o.value);
    return Number.isFinite(value) ? { mode: "value", value } : null;
  }
  if (o.mode === "indicator") {
    const kind = o.kind as IndicatorKind;
    if (!(kind in INDICATOR_DEFS)) return null;
    const settings = typeof o.settings === "object" && o.settings ? (o.settings as Record<string, unknown>) : {};
    return { mode: "indicator", kind, settings, lineKey: typeof o.lineKey === "string" ? o.lineKey : undefined };
  }
  return null;
}

export async function GET() {
  startAutomationScheduler();
  const rules = rulesStore.query((r) => r.userId === DEMO_USER_ID).map((r) => ({ ...r, description: describeRule(r) }));
  return NextResponse.json({ rules });
}

export async function POST(req: NextRequest) {
  startAutomationScheduler();
  if (!checkRateLimit(DEMO_USER_ID, "create-rule", 30, 60 * 60_000)) {
    return NextResponse.json({ error: "Too many rules created recently. Try again later." }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });

  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  if (!TICKERS.some((t) => t.symbol === symbol)) return NextResponse.json({ error: "Unknown symbol." }, { status: 400 });

  const timeframe = body.timeframe;
  if (!TIMEFRAMES.some((t) => t.value === timeframe)) return NextResponse.json({ error: "Unknown timeframe." }, { status: 400 });

  if (!CONDITIONS.has(body.condition)) return NextResponse.json({ error: "Unknown condition." }, { status: 400 });

  const operandA = parseOperand(body.operandA);
  if (!operandA || operandA.mode !== "indicator") {
    return NextResponse.json({ error: "operandA must be an indicator." }, { status: 400 });
  }
  const operandB = parseOperand(body.operandB);
  if (!operandB) return NextResponse.json({ error: "operandB is invalid." }, { status: 400 });

  const connection = connectionsStore.get(body.connectionId);
  if (!connection || connection.userId !== DEMO_USER_ID) {
    return NextResponse.json({ error: "Unknown connection." }, { status: 400 });
  }

  const rule: AlertRule = {
    id: crypto.randomUUID(),
    userId: DEMO_USER_ID,
    connectionId: connection.id,
    symbol,
    timeframe,
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "",
    operandA,
    condition: body.condition,
    operandB,
    message: typeof body.message === "string" && body.message.trim() ? body.message.trim() : undefined,
    enabled: true,
    lastTriggeredAt: null,
    lastEvaluatedBarTime: null,
    createdAt: Date.now(),
  };
  if (!rule.name) rule.name = describeRule(rule);

  rulesStore.insert(rule);
  return NextResponse.json({ rule: { ...rule, description: describeRule(rule) } }, { status: 201 });
}
