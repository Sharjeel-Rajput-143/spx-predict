import "server-only";
import { after } from "next/server";
import type { CollectionName } from "./storage/repository";
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
export type Deferred = Promise<unknown> | (() => Promise<unknown>);
/** `work` is either a promise already running, or a function started only after the answer has gone out (and its changes were saved). */
export function deferWork<R extends Response>(response: R, work: Deferred | undefined): R {
  if (work) (response as unknown as Record<symbol, unknown>)[DEFERRED] = work;
  return response;
}
const deferredOf = (response: Response | undefined): Deferred | null => ((response as unknown as Record<symbol, Deferred | undefined> | undefined)?.[DEFERRED] ?? null);
const start = (work: Deferred): Promise<unknown> => (typeof work === "function" ? work() : work);

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

export interface WithStorageOptions {
  /** Load only these collections before the handler runs, instead of everything (the handler must `loadEverything()` before it touches the rest). For a call that has to be answered fast. */
  load?: CollectionName[];
  /**
   * For a call that must be answered in time (TradingView gives up after about 3 seconds): if loading the records and running the
   * handler hasn't finished within `ms`, answer with `response()` at once and let the handler carry on behind it, as it would
   * have (its checks, its saves, its deferred work). The handler's own answer is then not seen by the caller, which is the price of
   * not timing out: this is what happens on a function that has to start up and open the database first.
   */
  answerWithin?: { ms: number; response: () => Response };
}

export function withStorage<A extends unknown[]>(handler: (...args: A) => Response | Promise<Response>, options: WithStorageOptions = {}): (...args: A) => Promise<Response> {
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
      if (work && process.env.VERCEL) afterResponse(async () => void (await start(work).catch(() => undefined)));
      return response;
    };
  }
  const problem = (err: unknown) => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });

  /** Loads, runs the handler, and saves, in that order: the answer and the work still to do behind it. */
  const job = async (args: A, method: string, enteredAt: number): Promise<{ response: Response; work: Deferred | null }> => {
    const t0 = performance.now();
    const queued = t0 - enteredAt;
    try {
      if (options.load && storage.hydrateCollections) await storage.hydrateCollections(options.load);
      else await storage.hydrate?.(method === "GET" ? READ_FRESH_MS : 0);
    } catch (err) {
      return { response: problem(err), work: null };
    }
    const t1 = performance.now();
    let response: Response | undefined;
    let failure: unknown = null;
    try {
      response = await asUser(args);
    } catch (err) {
      failure = err;
    }
    const t2 = performance.now();
    // Saved before the answer leaves, whatever the handler did (a thrown error included).
    let saveError: unknown = null;
    try {
      await storage.flush?.();
    } catch (err) {
      saveError = err;
    }
    if (failure) throw failure;
    if (saveError) return { response: problem(saveError), work: null };
    const t3 = performance.now();
    // Where the time went, visible in the browser's network panel: waiting for the request ahead, loading records, the handler, saving.
    try {
      response!.headers.set("Server-Timing", `queue;dur=${queued.toFixed(0)}, load;dur=${(t1 - t0).toFixed(0)}, run;dur=${(t2 - t1).toFixed(0)}, save;dur=${(t3 - t2).toFixed(0)}`);
    } catch {
      /* a response whose headers can't be changed simply goes without */
    }
    return { response: response!, work: deferredOf(response) };
  };

  /** Everything that carries on after the answer: the handler's deferred work, a last save, and letting the next request in. */
  const finishBehind = (work: Deferred | null, release: () => void) =>
    afterResponse(async () => {
      try {
        if (work) await start(work);
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

  return async (...args: A) => {
    const previous = g.__storageQueue ?? Promise.resolve();
    let release!: () => void;
    g.__storageQueue = new Promise<void>((r) => (release = r));
    let held = false; // the work after the answer keeps the queue until it is done
    try {
      const method = (args[0] as { method?: string } | undefined)?.method ?? "GET";
      // Waiting for the request ahead counts toward the deadline: a call that is stuck behind slow work is answered in time too.
      const enteredAt = performance.now();
      const running = previous.catch(() => undefined).then(() => job(args, method, enteredAt));
      if (options.answerWithin) {
        // Too slow to answer in time (a cold start, a slow database): answer now, finish behind the answer.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const slow = new Promise<"slow">((r) => (timer = setTimeout(() => r("slow"), options.answerWithin!.ms)));
        const first = await Promise.race([running.then((out) => out, (err) => ({ failure: err })), slow]);
        clearTimeout(timer);
        if (first === "slow") {
          held = true;
          afterResponse(async () => {
            let work: Deferred | null = null;
            try {
              work = (await running).work;
            } catch {
              /* the handler failed after the answer: nothing to wait for */
            }
            try {
              if (work) await start(work);
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
          return options.answerWithin.response();
        }
        if ("failure" in first) throw first.failure;
        if (first.work) {
          held = true;
          finishBehind(first.work, release);
        }
        return first.response;
      }
      const out = await running;
      if (out.work) {
        held = true;
        finishBehind(out.work, release);
      }
      return out.response;
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

/** Loads every record. For work that carries on after a fast answer (it ran with only part of the records loaded). A no-op with files. */
export async function loadEverything(): Promise<void> {
  await storage.hydrate?.();
}
