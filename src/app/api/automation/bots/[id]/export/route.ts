import { NextRequest, NextResponse } from "next/server";
import { getBotStaticConfig, isKnownBot } from "@/lib/automation/bots";
import { badRequest, unauthorized } from "@/lib/automation/routeAuth";
import { decisionsStore, ordersStore, positionsStore, signalsStore } from "@/lib/automation/store";
import { withStorage } from "@/lib/automation/withStorage";

function csv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    const text = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => cell(r[h])).join(","))].join("\n");
}

/** GET ?kind=all|positions|decisions|signals&format=json|csv (csv needs a single kind). */
async function handleGET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  if (!isKnownBot(id)) return badRequest("Unknown bot.", 404);

  const kind = req.nextUrl.searchParams.get("kind") ?? "all";
  const format = req.nextUrl.searchParams.get("format") ?? "json";
  const positions = positionsStore.query((p) => p.botId === id);
  const ids = new Set(positions.map((p) => p.id));
  const data = {
    positions,
    orders: ordersStore.query((o) => ids.has(o.positionId)),
    decisions: decisionsStore.query((d) => d.botId === id),
    signals: signalsStore.query((s) => s.botId === id),
  };

  const filename = `${id}-${kind}-${new Date().toISOString().slice(0, 10)}`;
  if (format === "csv") {
    if (kind === "all" || !(kind in data)) return badRequest("CSV export needs kind=positions, decisions or signals.");
    return new NextResponse(csv(data[kind as keyof typeof data] as unknown as Record<string, unknown>[]), {
      headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${filename}.csv"` },
    });
  }
  const payload = kind === "all" ? { bot: getBotStaticConfig(id), exportedAt: new Date().toISOString(), ...data } : { [kind]: data[kind as keyof typeof data] };
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${filename}.json"` },
  });
}

export const GET = withStorage(handleGET);
