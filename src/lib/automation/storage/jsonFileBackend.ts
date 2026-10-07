import fs from "node:fs";
import path from "node:path";
import { COLLECTIONS, SCHEMA_VERSION, StorageError, type CollectionName, type Repository, type StorageBackend } from "./repository";

/**
 * JSON files in one folder, one file per collection: `<dir>/bots.json`, `positions.json`, `webhooks.json`...
 *
 *  - Every file is `{ "schemaVersion": 1, "collection": "...", "items": [...] }`, and `meta.json` marks the folder as set up.
 *  - Writes are atomic: the new content goes to a temp file, is flushed to disk, then renamed over the real file, so a
 *    crash can never leave a half-written file.
 *  - A file that is missing (in a folder that was set up), unreadable, not valid JSON, or in an unexpected shape is
 *    an error naming the file. It is never treated as "empty": silently starting empty would forget every position.
 *  - A fresh folder is set up on first use. A folder from before schema versions (bare arrays) is upgraded in place.
 *
 * One process writes at a time (the per-bot lock in botLock.ts orders the engine's writes). Run a single instance.
 */

/** The file operations used, so a test can make one of them fail halfway. */
export interface FileOps {
  existsSync(file: string): boolean;
  mkdirSync(dir: string): void;
  readFileSync(file: string): string;
  /** Writes `content` to `file` and flushes it to disk. */
  writeFileSyncDurable(file: string, content: string): void;
  renameSync(from: string, to: string): void;
  rmSync(file: string): void;
}

export const nodeFileOps: FileOps = {
  existsSync: (file) => fs.existsSync(file),
  mkdirSync: (dir) => void fs.mkdirSync(dir, { recursive: true }),
  readFileSync: (file) => fs.readFileSync(file, "utf8"),
  writeFileSyncDurable: (file, content) => {
    const fd = fs.openSync(file, "w");
    try {
      fs.writeSync(fd, content);
      // Flushed to disk before the rename, so a power cut can't leave the renamed file empty. AUTOMATION_STORAGE_FSYNC=false
      // skips it (the test suite does, to stay fast); never do that on a real host.
      if (process.env.AUTOMATION_STORAGE_FSYNC !== "false") fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  },
  renameSync: (from, to) => fs.renameSync(from, to),
  rmSync: (file) => fs.rmSync(file, { force: true }),
};

interface FileShape<T> {
  schemaVersion: number;
  collection: string;
  items: T[];
}

// One in-memory copy per file, shared by every module graph (Next compiles route handlers, pages and the
// instrumentation hook separately), and one record of which folders are already set up.
const g = globalThis as typeof globalThis & { __automationStoreCaches?: Map<string, unknown[]>; __automationStoreReady?: Set<string> };
const caches = (g.__automationStoreCaches ??= new Map<string, unknown[]>());
const ready = (g.__automationStoreReady ??= new Set<string>());

export class JsonFileBackend implements StorageBackend {
  constructor(
    readonly dir: string,
    private readonly ops: FileOps = nodeFileOps,
  ) {}

  fileOf(name: CollectionName): string {
    return path.join(this.dir, `${name}.json`);
  }

  private get metaFile(): string {
    return path.join(this.dir, "meta.json");
  }

  repository<T extends { id: string }>(name: CollectionName): Repository<T> {
    return new JsonRepository<T>(this, name);
  }

  check(): string | null {
    try {
      this.ensureReady();
      for (const name of COLLECTIONS) this.read(name);
      return null;
    } catch (err) {
      if (err instanceof StorageError) return err.message;
      throw err;
    }
  }

  /** Forgets what is in memory, so the next read comes from the files - what a restart does. */
  dropCaches(): void {
    for (const name of COLLECTIONS) caches.delete(this.fileOf(name));
    ready.delete(this.dir);
  }

  // --- setup -------------------------------------------------------------------------------------------------

  /** Sets up a fresh folder, upgrades an old one, and refuses a damaged one. Runs once per folder per process. */
  ensureReady(): void {
    if (ready.has(this.dir)) return;
    try {
      this.ops.mkdirSync(this.dir);
    } catch (err) {
      throw new StorageError("unwritable", `The data folder ${this.dir} can't be created or written to (${reason(err)}). The engine needs a writable disk.`, this.dir);
    }

    if (this.ops.existsSync(this.metaFile)) {
      const meta = this.parse(this.metaFile, this.ops.readFileSync(this.metaFile));
      const version = (meta as { schemaVersion?: unknown } | null)?.schemaVersion;
      if (typeof version !== "number") throw new StorageError("corrupt", `${this.metaFile} is damaged (it has no schema version). Restore it from a backup; the engine will not start from an empty folder by itself.`, this.metaFile);
      if (version > SCHEMA_VERSION) throw new StorageError("schema", `${this.dir} was written by a newer version of this app (schema ${version}; this one reads ${SCHEMA_VERSION}). Update the app, or restore an older backup.`, this.metaFile);
      ready.add(this.dir);
      return;
    }

    // No meta.json: a brand new folder, or one from before schema versions. Anything that is already there is read
    // first (a damaged file stops the setup, untouched), then every file is written in the versioned shape.
    const existing = new Map<CollectionName, unknown[]>();
    for (const name of COLLECTIONS) {
      const file = this.fileOf(name);
      if (this.ops.existsSync(file)) existing.set(name, this.readItems(name, file, this.ops.readFileSync(file)));
    }
    for (const name of COLLECTIONS) this.write(name, existing.get(name) ?? []);
    this.writeMeta();
    ready.add(this.dir);
  }

  private writeMeta(): void {
    this.atomicWrite(this.metaFile, JSON.stringify({ schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString() }, null, 2));
  }

  // --- reading and writing one collection -----------------------------------------------------------------

  read<T>(name: CollectionName): T[] {
    const file = this.fileOf(name);
    const cached = caches.get(file) as T[] | undefined;
    if (cached) return cached;
    this.ensureReady();
    if (!this.ops.existsSync(file)) {
      throw new StorageError("missing", `${file} is missing, but the rest of the data folder is there. Restore it from a backup. The engine will not carry on as if it were empty.`, file);
    }
    let text: string;
    try {
      text = this.ops.readFileSync(file);
    } catch (err) {
      throw new StorageError("corrupt", `${file} can't be read (${reason(err)}).`, file);
    }
    const items = this.readItems(name, file, text) as T[];
    caches.set(file, items);
    return items;
  }

  write(name: CollectionName, items: unknown[]): void {
    const file: FileShape<unknown> = { schemaVersion: SCHEMA_VERSION, collection: name, items };
    this.atomicWrite(this.fileOf(name), JSON.stringify(file, null, 2));
    caches.set(this.fileOf(name), items);
  }

  private parse(file: string, text: string): unknown {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new StorageError("corrupt", `${file} is damaged: it is not valid JSON (${reason(err)}). Restore it from a backup, or move it aside to start that collection fresh. The engine will not start empty by itself.`, file);
    }
  }

  private readItems(name: CollectionName, file: string, text: string): unknown[] {
    const json = this.parse(file, text);
    // A bare array is the format from before schema versions: valid data, rewritten in the versioned shape on the next write.
    const items = Array.isArray(json) ? json : (json as Partial<FileShape<unknown>> | null)?.items;
    if (!Array.isArray(items)) throw new StorageError("corrupt", `${file} is damaged: it doesn't have the expected shape (a list of items). Restore it from a backup.`, file);
    if (!Array.isArray(json)) {
      const version = (json as FileShape<unknown>).schemaVersion;
      if (typeof version !== "number") throw new StorageError("corrupt", `${file} is damaged: it has no schema version. Restore it from a backup.`, file);
      if (version > SCHEMA_VERSION) throw new StorageError("schema", `${file} was written by a newer version of this app (schema ${version}; this one reads ${SCHEMA_VERSION}).`, file);
      const collection = (json as FileShape<unknown>).collection;
      if (collection !== name) throw new StorageError("corrupt", `${file} says it holds "${String(collection)}" but should hold "${name}". Restore it from a backup.`, file);
    }
    for (const row of items) {
      if (!row || typeof row !== "object" || typeof (row as { id?: unknown }).id !== "string") {
        throw new StorageError("corrupt", `${file} is damaged: an item in it has no id. Restore it from a backup.`, file);
      }
    }
    return items;
  }

  /** Temp file, flushed, then renamed over the real file: readers see the old content or the new, never half of either. */
  private atomicWrite(file: string, content: string): void {
    const tmp = `${file}.tmp`;
    try {
      this.ops.mkdirSync(this.dir);
      this.ops.writeFileSyncDurable(tmp, content);
      this.ops.renameSync(tmp, file);
    } catch (err) {
      try {
        this.ops.rmSync(tmp);
      } catch {
        /* nothing to clean up */
      }
      throw new StorageError("unwritable", `Couldn't write ${file} (${reason(err)}). The previous content is untouched.`, file);
    }
  }
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class JsonRepository<T extends { id: string }> implements Repository<T> {
  constructor(
    private readonly backend: JsonFileBackend,
    private readonly name: CollectionName,
  ) {}

  private rows(): T[] {
    return this.backend.read<T>(this.name);
  }

  private persist(rows: T[]): void {
    this.backend.write(this.name, rows);
  }

  all(): T[] {
    return [...this.rows()];
  }

  get(id: string): T | undefined {
    return this.rows().find((r) => r.id === id);
  }

  query(pred: (r: T) => boolean): T[] {
    return this.rows().filter(pred);
  }

  insert(record: T): T {
    const rows = this.rows();
    this.persist([...rows, record]);
    return record;
  }

  update(id: string, patch: Partial<T>): T | undefined {
    const rows = this.rows();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return undefined;
    const next = { ...rows[idx], ...patch };
    const copy = [...rows];
    copy[idx] = next;
    this.persist(copy);
    return next;
  }

  remove(id: string): boolean {
    const rows = this.rows();
    if (!rows.some((r) => r.id === id)) return false;
    this.persist(rows.filter((r) => r.id !== id));
    return true;
  }

  removeWhere(pred: (r: T) => boolean): number {
    const rows = this.rows();
    const kept = rows.filter((r) => !pred(r));
    const removed = rows.length - kept.length;
    if (removed > 0) this.persist(kept);
    return removed;
  }

  __reset(): void {
    this.backend.ensureReady();
    this.persist([]);
  }
}
