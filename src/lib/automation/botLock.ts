import "server-only";

/**
 * Per-bot async mutex. The spec requires signals for the same bot to be
 * processed strictly one at a time ("automations never run at the same
 * moment"), while different bots are free to run independently. A promise
 * chain keyed by bot id is enough for a single Node process - no real lock
 * manager needed since this is the only writer.
 */
const chains = new Map<string, Promise<unknown>>();

export function withBotLock<T>(botId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(botId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // Swallow so one rejected signal never wedges the chain for the next one;
  // the real result/rejection still propagates to this call's own caller via `run`.
  chains.set(botId, run.then(
    () => undefined,
    () => undefined,
  ));
  return run;
}
