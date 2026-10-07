import "server-only";
import crypto from "node:crypto";
import { botDisplayName, getBotStaticConfig, isKnownBot } from "./bots";
import { logDecision } from "./decisions";
import { webhooksStore } from "./store";
import type { SignalDirection, TriggerOption, Webhook } from "./types";

/** A named webhook is one secret URL, attached to one trigger (a bot and a direction) - how Option Alpha does it.
 * TradingView calls the URL; the trigger it is attached to says which signal it is, so the alert's message only needs the price. */

/** Option Alpha ignores a webhook called again within a minute. */
export const WEBHOOK_MIN_INTERVAL_MS = 60_000;

const TOKEN_BYTES = 24;

/** The short URL TradingView is given (rewritten to /api/webhook/hook/<token>, which also works directly). */
export function webhookUrlPath(w: Pick<Webhook, "token">): string {
  return `/hook/${w.token}`;
}

export interface NewWebhook {
  name: string;
  /** Optional: attach it to a trigger right away. Without them it is created unattached and attached from the bot's trigger panel. */
  botId?: string | null;
  direction?: SignalDirection | null;
}

const DIRECTION_WORD = { bullish: "Bullish", bearish: "Bearish" } as const;

/** "the Bullish trigger of NDX Bias Bot" - how the log and the panels name a trigger. */
export function triggerLabel(botId: string, direction: SignalDirection): string {
  return `the ${DIRECTION_WORD[direction]} trigger of ${botDisplayName(botId)}`;
}

export function createWebhook(input: NewWebhook, now: number = Date.now()): Webhook {
  const name = input.name.trim();
  if (!name) throw new Error("Give the webhook a name.");
  if (name.length > 60) throw new Error("Keep the name under 60 characters.");
  if (webhooksStore.query((w) => w.name.toLowerCase() === name.toLowerCase()).length > 0) throw new Error(`A webhook named "${name}" already exists.`);
  const attach = !!input.botId || !!input.direction;
  if (attach) checkTrigger(input.botId, input.direction);

  const hook: Webhook = {
    id: `wh-${now}-${crypto.randomBytes(3).toString("hex")}`,
    name,
    token: crypto.randomBytes(TOKEN_BYTES).toString("hex"),
    botId: null,
    direction: null,
    active: true,
    createdAt: now,
    lastTriggeredAt: null,
    triggerCount: 0,
  };
  webhooksStore.insert(hook);
  return attach ? attachWebhook(hook.id, input.botId!, input.direction!, now).webhook : hook;
}

function checkTrigger(botId: string | null | undefined, direction: SignalDirection | null | undefined): asserts botId is string {
  if (!botId || !isKnownBot(botId)) throw new Error("Pick a bot that exists.");
  if (direction !== "bullish" && direction !== "bearish") throw new Error('The trigger must be "bullish" or "bearish".');
}

/** The webhook attached to a trigger, if any. */
export function webhookForTrigger(botId: string, direction: SignalDirection): Webhook | undefined {
  return webhooksStore.query((w) => w.botId === botId && w.direction === direction)[0];
}

export const isAttached = (w: Pick<Webhook, "botId" | "direction">): w is { botId: string; direction: SignalDirection } => !!w.botId && !!w.direction;

const record = (botId: string, outcome: "webhook_attached" | "webhook_changed" | "webhook_detached", reason: string, detail: Record<string, unknown>, now: number) =>
  // Names and ids only: the URL (the secret) is never written to a log.
  logDecision({ signalId: null, botId, outcome, reason, detail, now });

export interface AttachResult {
  webhook: Webhook;
  /** The webhook this one replaced on the trigger, if the trigger already had one. */
  replaced: Webhook | null;
  /** False when it was already attached to exactly this trigger (nothing changed, nothing logged). */
  changed: boolean;
}

/**
 * Attaches a webhook to a trigger and keeps it there until a person changes or detaches it.
 * One webhook, one trigger: a webhook attached to another trigger is refused, with the reason. A trigger holds one
 * webhook: attaching another one to it replaces (changes) the first, which becomes unattached. Logged. Callers hold the bot's lock.
 */
export function attachWebhook(webhookId: string, botId: string, direction: SignalDirection, now: number = Date.now()): AttachResult {
  checkTrigger(botId, direction);
  const hook = webhooksStore.get(webhookId);
  if (!hook) throw new Error("Webhook not found.");
  if (isAttached(hook)) {
    if (hook.botId === botId && hook.direction === direction) return { webhook: hook, replaced: null, changed: false };
    throw new Error(`"${hook.name}" is already attached to ${triggerLabel(hook.botId, hook.direction)}. One webhook, one trigger: detach it there first.`);
  }

  const previous = webhookForTrigger(botId, direction) ?? null;
  if (previous) webhooksStore.update(previous.id, { botId: null, direction: null });
  const attached = webhooksStore.update(hook.id, { botId, direction })!;
  if (previous) {
    record(botId, "webhook_changed", `${DIRECTION_WORD[direction]} trigger changed from webhook "${previous.name}" to "${hook.name}".`, { webhookId: hook.id, webhook: hook.name, previousWebhookId: previous.id, previousWebhook: previous.name, direction }, now);
  } else {
    record(botId, "webhook_attached", `Webhook "${hook.name}" attached to ${triggerLabel(botId, direction)}.`, { webhookId: hook.id, webhook: hook.name, direction }, now);
  }
  return { webhook: attached, replaced: previous, changed: true };
}

/** Detaches whatever webhook is on a trigger. Its URL stops working until it is attached again. Logged. Returns it, or null if there was none. */
export function detachTrigger(botId: string, direction: SignalDirection, now: number = Date.now(), why = "detached"): Webhook | null {
  checkTrigger(botId, direction);
  const hook = webhookForTrigger(botId, direction);
  if (!hook) return null;
  webhooksStore.update(hook.id, { botId: null, direction: null });
  record(botId, "webhook_detached", `Webhook "${hook.name}" ${why} from ${triggerLabel(botId, direction)}.`, { webhookId: hook.id, webhook: hook.name, direction }, now);
  return hook;
}

/** Every webhook, as the trigger's dropdown lists it: with its status, and why it can't be picked when it is attached elsewhere. */
export function optionsForTrigger(botId: string, direction: SignalDirection): TriggerOption[] {
  return webhooksStore
    .all()
    .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
    .map((w) => {
      const here = w.botId === botId && w.direction === direction;
      const elsewhere = isAttached(w) && !here;
      return {
        id: w.id,
        name: w.name,
        active: w.active,
        available: !elsewhere,
        attachedHere: here,
        reason: elsewhere ? `Already attached to ${triggerLabel(w.botId!, w.direction!)} (one webhook, one trigger)` : null,
      };
    });
}

/** The URL with its secret hidden: only the last four characters of the token show. For lists and panels; the full URL is fetched on demand. */
export function maskedWebhookPath(w: Pick<Webhook, "token">): string {
  return `/hook/${"•".repeat(12)}${w.token.slice(-4)}`;
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

export function deleteWebhook(id: string, now: number = Date.now()): void {
  const hook = webhooksStore.get(id);
  if (!hook) throw new Error("Webhook not found.");
  if (isAttached(hook)) detachTrigger(hook.botId, hook.direction, now, "deleted (it was detached)");
  webhooksStore.remove(id);
}

export const webhookUnderlying = (botId: string | null): string | null => {
  if (!botId) return null;
  try {
    return getBotStaticConfig(botId).underlying;
  } catch {
    return null;
  }
};

/** What the pages get about a webhook. The secret (the token, and the URL it is part of) is never in it: the path is
 * masked, and the full URL is fetched on demand from /api/automation/webhooks/[id]/url. */
export const webhookView = (w: Webhook) => {
  const { token: _token, ...rest } = w;
  return {
    ...rest,
    attached: isAttached(w),
    botName: w.botId ? botDisplayName(w.botId) : null,
    underlying: webhookUnderlying(w.botId),
    path: maskedWebhookPath(w),
  };
};
