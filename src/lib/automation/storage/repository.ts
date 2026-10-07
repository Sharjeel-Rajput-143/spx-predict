/**
 * The storage the engine sees. The engine, the routes and the pages only ever call a Repository: they never open a
 * file. Today the one implementation keeps JSON files in a folder (jsonFileBackend.ts); a database implementation
 * of the same interface can replace it later without touching the engine.
 */
export interface Repository<T extends { id: string }> {
  all(): T[];
  get(id: string): T | undefined;
  query(pred: (row: T) => boolean): T[];
  insert(row: T): T;
  update(id: string, patch: Partial<T>): T | undefined;
  remove(id: string): boolean;
  removeWhere(pred: (row: T) => boolean): number;
  /** Test-only escape hatch: empties this collection. */
  __reset(): void;
}

/** Every collection the engine keeps. A backend sets all of them up together. */
export const COLLECTIONS = ["bots", "signals", "positions", "orders", "decisions", "errors", "templates", "runs", "alerts", "webhooks", "settings"] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

/** The version written into every file. Raise it (and add a step to the migration) when the shape of a file changes. */
export const SCHEMA_VERSION = 1;

export interface StorageBackend {
  repository<T extends { id: string }>(name: CollectionName): Repository<T>;
  /** Null when every collection reads cleanly; otherwise the first problem, in words a person can act on. */
  check(): string | null;
}

export type StorageErrorCode = "corrupt" | "missing" | "schema" | "unwritable";

/** A storage problem that must stop the engine: it is never swallowed and never turned into an empty collection. */
export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly file?: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}
