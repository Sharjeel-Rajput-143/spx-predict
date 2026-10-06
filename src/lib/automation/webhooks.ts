import "server-only";
import crypto from "node:crypto";
import { getBotStaticConfig, isKnownBot } from "./bots";
import { webhooksStore } from "./store";
import type { SignalDirection, Webhook } from "./types";

/** A named webhook is one secret URL for one bot and one direction - how Option Alpha does it. TradingView
 * calls the URL; the call itself says which signal it is, so the alert's message only needs the price. */

/** Option Alpha ignores a webhook called again within a minute. */
export const WEBHOOK_MIN_INTERVAL_MS = 60_000;

const TOKEN_BYTES = 24;

/** The short URL TradingView is given (rewritten to /api/webhook/hook/<token>, which also works directly). */
export function webhookUrlPath(w: Pick<Webhook, "token">): string {
  return `/hook/${w.token}`;
}

export interface NewWebhook {
  name: string;
  botId: string;
  direction: SignalDirection;
}

export function createWebhook(input: NewWebhook, now: number = Date.now()): Webhook {
  const name = input.name.trim();
  if (!name) throw new Error("Give the webhook a name.");
  if (name.length > 60) throw new Error("Keep the name under 60 characters.");
  if (!isKnownBot(input.botId)) throw new Error("Pick a bot that exists.");
  if (input.direction !== "bullish" && input.direction !== "bearish") throw new Error('The signal must be "bullish" or "bearish".');
  if (webhooksStore.query((w) => w.name.toLowerCase() === name.toLowerCase()).length > 0) throw new Error(`A webhook named "${name}" already exists.`);

  const hook: Webhook = {
    id: `wh-${now}-${crypto.randomBytes(3).toString("hex")}`,
    name,
    token: crypto.randomBytes(TOKEN_BYTES).toString("hex"),
    botId: input.botId,
    direction: input.direction,
    active: true,
    createdAt: now,
    lastTriggeredAt: null,
    triggerCount: 0,
  };
  return webhooksStore.insert(hook);
}

/** Finds a webhook by the token in a URL. Compares every stored token in constant time, so a wrong guess
 * can't be told apart by how long the answer takes. */
export function findWebhookByToken(token: string): Webhook | undefined {
  const given = Buffer.from(token);
  let found: Webhook | undefined;
  for (const w of webhooksStore.all()) {
    const mine = Buffer.from(w.token);
    if (mine.length === given.length && crypto.timingSafeEqual(mine, given)) found = w;
  }
  return found;
}

export function updateWebhook(id: string, patch: { name?: string; active?: boolean }): Webhook {
  const existing = webhooksStore.get(id);
  if (!existing) throw new Error("Webhook not found.");
  const next: Partial<Webhook> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("Give the webhook a name.");
    if (webhooksStore.query((w) => w.id !== id && w.name.toLowerCase() === name.toLowerCase()).length > 0) throw new Error(`A webhook named "${name}" already exists.`);
    next.name = name;
  }
  if (patch.active !== undefined) next.active = !!patch.active;
  return webhooksStore.update(id, next)!;
}

export function deleteWebhook(id: string): void {
  if (!webhooksStore.remove(id)) throw new Error("Webhook not found.");
}

/** What a body from TradingView can tell us. The message is whatever the alert is set to send: JSON like
 * {"price":{{close}},"bar_time":"{{timenow}}","interval":"{{interval}}"}, or just text like 21003.7. */
export interface HookPayload {
  price: number | null;
  barTime: string | null;
  interval: string | null;
}

export function parseHookBody(raw: string): HookPayload {
  const text = raw.trim();
  const empty: HookPayload = { price: null, barTime: null, interval: null };
  if (!text) return empty;
  const asNumber = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(/,/g, "")) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  try {
    const json = JSON.parse(text) as unknown;
    if (typeof json === "number" || typeof json === "string") return { ...empty, price: asNumber(json) };
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const o = json as Record<string, unknown>;
      return {
        price: asNumber(o.price ?? o.close),
        barTime: typeof o.bar_time === "string" && o.bar_time ? o.bar_time : null,
        interval: typeof o.interval === "string" || typeof o.interval === "number" ? String(o.interval) : null,
      };
    }
  } catch {
    /* not JSON: it may just be a number */
  }
  return { ...empty, price: asNumber(text) };
}

export const webhookUnderlying = (botId: string): string | null => {
  try {
    return getBotStaticConfig(botId).underlying;
  } catch {
    return null;
  }
};
