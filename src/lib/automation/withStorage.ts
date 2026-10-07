import "server-only";
import { storage } from "./store";

/**
 * Wraps a route handler so it works on a host whose records live in a database (Turso). Around the handler:
 * load the records, run it, save what it changed, then answer. Requests are taken one at a time within an instance, so one
 * can't load over another's unsaved changes. A database that can't be reached, or a save that fails, answers 503 with
 * the reason; it never carries on as if the records were empty.
 *
 * With the JSON files (the default) this returns the handler untouched: nothing changes there.
 */
const g = globalThis as typeof globalThis & { __storageQueue?: Promise<unknown> };

/** A page that polls may use records up to this old, so it doesn't load the whole database every few seconds. */
const READ_FRESH_MS = 2_000;

export function withStorage<A extends unknown[]>(handler: (...args: A) => Response | Promise<Response>): (...args: A) => Promise<Response> {
  if (!storage.remote) return async (...args: A) => handler(...args);
  const problem = (err: unknown) => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });

  return async (...args: A) => {
    const previous = g.__storageQueue ?? Promise.resolve();
    let release!: () => void;
    g.__storageQueue = new Promise<void>((r) => (release = r));
    await previous.catch(() => undefined);
    try {
      const method = (args[0] as { method?: string } | undefined)?.method ?? "GET";
      try {
        await storage.hydrate?.(method === "GET" ? READ_FRESH_MS : 0);
      } catch (err) {
        return problem(err);
      }
      let response: Response | undefined;
      let failure: unknown = null;
      try {
        response = await handler(...args);
      } catch (err) {
        failure = err;
      }
      // Saved before the answer leaves, whatever the handler did (a thrown error included).
      let saveError: unknown = null;
      try {
        await storage.flush?.();
      } catch (err) {
        saveError = err;
      }
      if (failure) throw failure;
      return saveError ? problem(saveError) : response!;
    } finally {
      release();
    }
  };
}

/** For a server-rendered page that reads records directly (not through a route): load them first. A page only reads. */
export async function loadStorage(): Promise<void> {
  if (!storage.remote) return;
  try {
    await storage.hydrate?.(READ_FRESH_MS);
  } catch {
    /* the page then shows what it has; the routes it calls report the problem */
  }
}
