import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whose request is running. Inside `runAs(userId, ...)` the stores show and change only that user's records, and a record
 * saved there is saved as theirs. Outside it (a TradingView call, the clock) the code is the engine itself and sees every
 * record; it then works for one bot at a time under that bot's owner (see botLock.ts).
 */
const g = globalThis as typeof globalThis & { __userContext?: AsyncLocalStorage<{ userId: string | null }> };
const als = (g.__userContext ??= new AsyncLocalStorage<{ userId: string | null }>());

export const runAs = <T>(userId: string | null, fn: () => T): T => als.run({ userId }, fn);
export const currentUserId = (): string | null => als.getStore()?.userId ?? null;
