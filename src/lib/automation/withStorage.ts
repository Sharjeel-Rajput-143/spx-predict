import "server-only";
import { after } from "next/server";
import { storage } from "./store";
import { SESSION_COOKIE_NAME, sessionUserId } from "./session";
import { runAs } from "./userContext";

/**
 * Wraps a route handler. It runs the handler as the signed-in user (so it sees only that user's records), and on a host whose
 * records live in a database (Turso) it works around the handler like this:
 * load the records, run it, save what it changed, then answer. Requests are taken one at a time within an instance, so one
 * can't load over another's unsaved changes. A database that can't be reached, or a save that fails, answers 503 with
 * the reason; it never carries on as if the records were empty.
 *
 * With the JSON files (the default) there is nothing to load or save, only the user.
 */
const g = globalThis as typeof globalThis & { __storageQueue?: Promise<unknown> };

const DEFERRED = Symbol.for("spx.deferredWork");

/** Marks a response whose real work is still going on: the answer goes out now, and the host is asked to keep the function
 * alive until the work is done (TradingView gives up on an alert after about 3 seconds, so a call is answered at once). */
export function deferWork<R extends Response>(response: R, work: Promise<unknown> | undefined): R {
  if (work) (response as unknown as Record<symbol, unknown>)[DEFERRED] = work;
  return response;
}
const deferredOf = (response: Response | undefined): Promise<unknown> | null => ((response as unknown as Record<symbol, Promise<unknown> | undefined> | undefined)?.[DEFERRED] ?? null);

/** Runs `task` after the response, kept alive by the host where it can be (Next's after(); outside a request, just started). */
function afterResponse(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

/** A page that polls may use records up to this old, so it doesn't load the whole database every few seconds. */
const READ_FRESH_MS = 2_000;

export function withStorage<A extends unknown[]>(handler: (...args: A) => Response | Promise<Response>): (...args: A) => Promise<Response> {
  /** The handler, run as the signed-in user: it then sees and changes only that user's records. */
  const asUser = (args: A): Promise<Response> | Response => {
    const req = args[0] as { cookies?: { get(name: string): { value: string } | undefined } } | undefined;
    const userId = sessionUserId(req?.cookies?.get(SESSION_COOKIE_NAME)?.value);
    return userId ? runAs(userId, () => handler(...args)) : handler(...args);
  };
  if (!storage.remote) {
    return async (...args: A) => {
      const response = await asUser(args);
      const work = deferredOf(response);
      // Records in files or a temporary folder: nothing to save afterwards, but on Vercel the function must be kept alive for the work.
      if (work && process.env.VERCEL) afterResponse(async () => void (await work.catch(() => undefined)));
      return response;
    };
  }
  const problem = (err: unknown) => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });

  return async (...args: A) => {
    const previous = g.__storageQueue ?? Promise.resolve();
    let release!: () => void;
    g.__storageQueue = new Promise<void>((r) => (release = r));
    await previous.catch(() => undefined);
    let held = false; // the work after the answer keeps the queue until it is done
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
        response = await asUser(args);
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
      if (saveError) return problem(saveError);
      const work = deferredOf(response);
      if (work) {
        held = true;
        afterResponse(async () => {
          try {
            await work;
          } catch {
            /* the work records its own failures */
          }
          try {
            await storage.flush?.();
          } catch {
            /* kept and tried again by the next save */
          }
          release();
        });
      }
      return response!;
    } finally {
      if (!held) release();
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
