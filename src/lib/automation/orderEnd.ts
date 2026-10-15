import type { OrderEvent, OrderState } from "./types";

/** How many of the broker's events are kept on an order, and how many are put in a Log entry. */
export const MAX_EVENTS_KEPT = 20;
export const EVENTS_IN_LOG = 3;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The broker's own account of an order's life (GET /order: ibkrStatus, permId, events), read defensively: whatever is not the right shape is dropped. */
export function readBrokerTrail(order: Record<string, unknown>): Pick<OrderState, "ibkrStatus" | "permId" | "events"> {
  const ibkrStatus = typeof order.ibkrStatus === "string" && order.ibkrStatus.trim() ? clip(order.ibkrStatus.trim(), 60) : undefined;
  const permId = typeof order.permId === "number" && Number.isFinite(order.permId) ? order.permId : typeof order.permId === "string" && order.permId.trim() ? clip(order.permId.trim(), 40) : undefined;
  const events: OrderEvent[] = [];
  if (Array.isArray(order.events)) {
    for (const e of order.events) {
      if (!e || typeof e !== "object") continue;
      const r = e as { time?: unknown; status?: unknown; code?: unknown; message?: unknown };
      const time = typeof r.time === "string" || typeof r.time === "number" ? clip(String(r.time), 40) : "";
      const status = typeof r.status === "string" ? clip(r.status, 60) : "";
      const code = typeof r.code === "number" && Number.isFinite(r.code) ? r.code : undefined;
      const message = typeof r.message === "string" && r.message ? clip(r.message, 300) : undefined;
      if (!status && code === undefined && !message) continue;
      events.push({ time, status, ...(code !== undefined ? { code } : {}), ...(message ? { message } : {}) });
    }
  }
  const kept = events.slice(-MAX_EVENTS_KEPT);
  return { ...(ibkrStatus ? { ibkrStatus } : {}), ...(permId !== undefined ? { permId } : {}), ...(kept.length > 0 ? { events: kept } : {}) };
}

const eventText = (e: OrderEvent) => [e.time, e.status, e.code !== undefined ? `[${e.code}]` : "", e.message ? `"${e.message}"` : ""].filter(Boolean).join(" ");

/** "IBKR status Cancelled (permId 7); last events: 14:02:11 Submitted; 14:02:12 Cancelled [202] "…"" - or "" when the broker gave no trail. */
export function trailText(state: Pick<OrderState, "ibkrStatus" | "permId" | "events">): string {
  const parts: string[] = [];
  if (state.ibkrStatus) parts.push(`IBKR status ${state.ibkrStatus}${state.permId !== undefined ? ` (permId ${state.permId})` : ""}`);
  else if (state.permId !== undefined) parts.push(`permId ${state.permId}`);
  const last = (state.events ?? []).slice(-EVENTS_IN_LOG);
  if (last.length > 0) parts.push(`last events: ${last.map(eventText).join("; ")}`);
  return parts.join("; ");
}

/** What a Log entry says about an order that ended canceled or rejected: its reason, then the trail; and plainly when the broker said nothing. */
export function brokerSaid(state: Pick<OrderState, "rejectReason" | "priceBand" | "ibkrStatus" | "permId" | "events">, brokerEnded: boolean): string {
  const words = state.rejectReason ? `The broker's words: ${state.rejectReason}` : "";
  const trail = trailText(state);
  const nothing = brokerEnded && !state.rejectReason && !state.priceBand && !trail ? "The broker gave no reason, price band or events." : "";
  return [words, trail ? `${trail}.` : "", nothing].filter(Boolean).join(" ").replace(/\.\./g, ".");
}
