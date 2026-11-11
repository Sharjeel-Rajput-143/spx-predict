import "server-only";
import { BTC_BOT_ID } from "./bots";
import { LIVE_BOT_ID } from "./bybitLiveLimits";
import { readLiveSettings } from "./liveSettings";
import { sharedExecutor } from "./sharedExecutor";
import type { SignalDirection } from "./types";
import { ingestWebhook } from "./webhookIngest";

/**
 * THE LIVE JOB (the "mirror"). The demo bot's TradingView hooks are also sent to the live bot, when the one setting `mirrorEnabled` is ON (it is ON only together with the Live trading toggle).
 *
 * INDEPENDENT FROM THE DEMO BOT (release 7). The webhook route does the shared steps ONCE (the hook, the alert text, the once-a-minute rule, the price) and then starts the demo job and this
 * live job AT THE SAME MOMENT. Neither waits for the other, neither can fail the other, and each has its own signal record, its own bot lock and its own try/catch. So a demo bot that is off,
 * tripped, in error, killed, slow or hung does not stop the live bot from getting the signal, and the other way round.
 *
 * What is kept from before:
 *   - It never runs before the answer: the route builds and returns TradingView's answer (from the demo result alone) first; this runs behind it, with the work the route already defers.
 *   - It can never fail the demo side: everything here is inside one try/catch, returns a promise that NEVER rejects, and every wait has a time limit.
 *   - It sends the live bot a signal of its own (its own record, its own bot lock, its own executor). The demo bot's signal, order and records are not shared with it.
 * With the live switch OFF the live bot is off too, and an off bot only closes (engine.ts: "Always On"): a mirrored signal can end a position it holds, never open one.
 */

export const MIRROR_TOTAL_CAP_MS = 60_000;

/** Waits for `p`, but never longer than `ms`. The timer is cleared and does not keep the process alive. */
function within(p: Promise<unknown> | undefined, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    (p ?? Promise.resolve()).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

export interface MirrorInput {
  /** The hook that fired, and which bot it belongs to. */
  hook: { name: string; botId?: string | null };
  direction: SignalDirection;
  /** The same price and bar time the demo bot was given. */
  price: number;
  barTime: string;
}

export interface MirrorDeps {
  ingest: typeof ingestWebhook;
  executor: Parameters<typeof ingestWebhook>[1]["executor"];
  settings: () => { mirrorEnabled: boolean };
  totalCapMs: number;
  log: (line: string, err?: unknown) => void;
}

const defaultDeps = (): MirrorDeps => ({
  ingest: ingestWebhook,
  executor: sharedExecutor,
  settings: readLiveSettings,
  totalCapMs: MIRROR_TOTAL_CAP_MS,
  log: (line, err) => console.error(line, err ?? ""),
});

/** Sends the live bot its own copy of the signal when the mirror is ON, at once (it does not wait for the demo bot). Resolves when done or given up; NEVER rejects and never throws. */
export async function runMirror(input: MirrorInput, overrides: Partial<MirrorDeps> = {}): Promise<void> {
  try {
    if (input.hook.botId !== BTC_BOT_ID) return; // only the BTC demo bot's hooks have a live twin
    const deps = { ...defaultDeps(), ...overrides };
    if (!deps.settings().mirrorEnabled) return;
    const result = deps.ingest(
      { bot: LIVE_BOT_ID, signal: input.direction, symbol: "BTC", price: input.price, bar_time: `${input.barTime}-live`, interval: "", webhook: input.hook.name, mirror: true },
      { executor: deps.executor, trusted: true, mirrorOf: BTC_BOT_ID },
    );
    if (result.status !== 200) deps.log(`[live] the mirrored signal was not accepted (${result.status}): ${JSON.stringify(result.body)}`);
    await within(result.processing, deps.totalCapMs);
  } catch (err) {
    try {
      (overrides.log ?? ((l: string, e?: unknown) => console.error(l, e ?? "")))("[live] the mirror failed; the demo bot is not affected", err);
    } catch {
      /* even logging must not throw */
    }
  }
}
