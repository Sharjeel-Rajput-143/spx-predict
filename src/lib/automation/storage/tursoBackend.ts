import type { Client, InStatement } from "@libsql/client";
import { COLLECTIONS, StorageError, type CollectionName, type Repository, type StorageBackend } from "./repository";

/**
 * The same storage, kept in a Turso (libSQL) database instead of JSON files, for a host with no disk of its own (Vercel):
 * a serverless instance forgets everything between requests and no two instances share a folder, so the records live in
 * one database all of them reach.
 *
 * The engine reads and writes its records synchronously, so a Repository still works on an in-memory copy. Around each
 * request (withStorage.ts) the copy is loaded from the database first (`hydrate`) and the changes made during the request
 * are written back before it answers (`flush`). The database holds one row per record, so two instances that change
 * different records never overwrite each other; a change is only lost if two change the very same record at once.
 *
 *  - A database that can't be reached, or a flush that fails, is an error: it is never turned into an empty collection.
 *  - Nothing here runs unless Turso is chosen (see store.ts); the JSON files stay the default.
 */

export interface TursoOptions {
  url: string;
  authToken?: string;
  /** Keeps two backends in one process apart (tests standing in for two serverless instances). */
  instance?: string;
}

/**
 * Opens the connection. A database over the network (Turso: libsql://, https://) is reached with libsql's HTTP-only client: the default
 * client loads a ~7 MB native binary the moment it is imported, and a serverless function that has just started pays for that, and for a
 * WebSocket handshake, out of the 3 seconds TradingView allows an alert. HTTP is one request per call and needs neither. A local file (a
 * laptop, the tests) needs the full client, which is only loaded then.
 */
async function openClient(options: TursoOptions): Promise<Client> {
  const url = options.url.trim();
  if (/^(libsql|https?):/i.test(url)) {
    const { createClient } = await import("@libsql/client/http");
    return createClient({ url: url.replace(/^libsql:/i, "https:"), authToken: options.authToken });
  }
  const { createClient } = await import("@libsql/client");
  return createClient({ url, authToken: options.authToken });
}

type Op = { kind: "put"; collection: CollectionName; id: string; json: string } | { kind: "del"; collection: CollectionName; id: string };

interface State {
  data: Map<CollectionName, unknown[]>;
  pending: Op[];
  ready: boolean;
  hydratedAt: number;
  lastError: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Saves run one after another, so two never race and write an older change over a newer one. */
  saving: Promise<unknown>;
}

// One copy per database and instance, shared by every module graph (as the JSON backend's caches are).
const g = globalThis as typeof globalThis & { __tursoStates?: Map<string, State> };
const states = (g.__tursoStates ??= new Map<string, State>());

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class TursoBackend implements StorageBackend {
  readonly remote = true;
  private connection: Promise<Client> | null = null;
  private readonly key: string;

  constructor(readonly options: TursoOptions) {
    this.key = `${options.url}|${options.instance ?? "main"}`;
  }

  /** Connects on first use, so a wrong address is reported as a failed load (503 with the reason), not as a crash at start-up. */
  private getClient(): Promise<Client> {
    const opening = (this.connection ??= openClient(this.options));
    // A connection that could not be opened is tried again by the next call, not remembered as failed.
    opening.catch(() => {
      if (this.connection === opening) this.connection = null;
    });
    return opening;
  }

  private get state(): State {
    let s = states.get(this.key);
    if (!s) {
      s = { data: new Map(), pending: [], ready: false, hydratedAt: 0, lastError: null, timer: null, saving: Promise.resolve() };
      for (const name of COLLECTIONS) s.data.set(name, []);
      states.set(this.key, s);
    }
    return s;
  }

  repository<T extends { id: string }>(name: CollectionName): Repository<T> {
    return new TursoRepository<T>(this, name);
  }

  /** Null unless the last load or save failed. (A database that has never been reached has no problem to report yet.) */
  check(): string | null {
    return this.state.lastError;
  }

  /** Forgets the in-memory copy, as a new serverless instance starts without one. */
  dropCaches(): void {
    states.delete(this.key);
  }

  // --- the in-memory copy, used by the repositories -------------------------------------------------------------

  rows<T>(name: CollectionName): T[] {
    return this.state.data.get(name) as T[];
  }

  set(name: CollectionName, rows: unknown[], op: Op | null): void {
    const s = this.state;
    s.data.set(name, rows);
    if (op) {
      s.pending.push(op);
      this.scheduleFlush();
    }
  }

  /** A change made outside any request (the engine finishing an order after it answered, on a server that stays up) is
   * still saved shortly after; inside a request, withStorage saves it before the answer. */
  private scheduleFlush(): void {
    const s = this.state;
    if (s.timer) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      void this.flush().catch(() => undefined);
    }, 250);
    s.timer.unref?.();
  }

  // --- the database -----------------------------------------------------------------------------------------

  private async ensureTable(): Promise<void> {
    const s = this.state;
    if (s.ready) return;
    await (await this.getClient()).execute("CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (collection, id))");
    s.ready = true;
  }

  /** Runs a database call, creating the table first only if the database says it isn't there (saves a round trip on every cold start). */
  private async withTable<T>(run: () => Promise<T>): Promise<T> {
    const s = this.state;
    if (s.ready) return run();
    try {
      const result = await run();
      s.ready = true;
      return result;
    } catch (err) {
      if (!/no such table/i.test(reason(err))) throw err;
      await this.ensureTable();
      return run();
    }
  }

  /**
   * Loads only some collections (one small query), leaving the others as they are. A TradingView call is answered with only what it needs
   * to be recognised (the webhooks and the bots); everything else is loaded after the answer has gone out (`hydrate`).
   */
  async hydrateCollections(names: CollectionName[]): Promise<void> {
    const s = this.state;
    try {
      if (s.pending.length > 0) await this.flush();
      const marks = names.map(() => "?").join(", ");
      const result = await this.withTable(async () => (await this.getClient()).execute({ sql: `SELECT collection, json FROM records WHERE collection IN (${marks}) ORDER BY rowid`, args: names }));
      const fresh = new Map<CollectionName, unknown[]>(names.map((n) => [n, []]));
      for (const row of result.rows) {
        const list = fresh.get(String(row.collection) as CollectionName);
        if (!list) continue;
        try {
          list.push(JSON.parse(String(row.json)));
        } catch {
          throw new StorageError("corrupt", `A ${String(row.collection)} record in the database is damaged (it is not valid JSON). Restore it from a backup; the engine will not carry on as if it were empty.`);
        }
      }
      for (const [name, list] of fresh) s.data.set(name, list);
      s.lastError = null;
    } catch (err) {
      const message = err instanceof StorageError ? err.message : `The database can't be reached (${reason(err)}). Check TURSO_DB_URL and TURSO_DB_TOKEN.`;
      s.lastError = message;
      throw err instanceof StorageError ? err : new StorageError("unwritable", message);
    }
  }

  /** Loads every record from the database into memory. `maxAgeMs`: keep a copy that is that fresh (for the page polling). */
  async hydrate(maxAgeMs = 0): Promise<void> {
    const s = this.state;
    if (maxAgeMs > 0 && s.ready && s.pending.length === 0 && Date.now() - s.hydratedAt < maxAgeMs) return;
    try {
      // What this instance has changed but not yet saved goes first, so loading can't throw it away.
      if (s.pending.length > 0) await this.flush();
      const result = await this.withTable(async () => (await this.getClient()).execute("SELECT collection, json FROM records ORDER BY rowid"));
      const data = new Map<CollectionName, unknown[]>();
      for (const name of COLLECTIONS) data.set(name, []);
      for (const row of result.rows) {
        const name = String(row.collection) as CollectionName;
        const list = data.get(name);
        if (!list) continue; // a collection a newer version added: not ours to read
        try {
          list.push(JSON.parse(String(row.json)));
        } catch {
          throw new StorageError("corrupt", `A ${name} record in the database is damaged (it is not valid JSON). Restore it from a backup; the engine will not carry on as if it were empty.`);
        }
      }
      s.data = data;
      s.hydratedAt = Date.now();
      s.lastError = null;
    } catch (err) {
      const message = err instanceof StorageError ? err.message : `The database can't be reached (${reason(err)}). Check TURSO_DB_URL and TURSO_DB_TOKEN.`;
      s.lastError = message;
      throw err instanceof StorageError ? err : new StorageError("unwritable", message);
    }
  }

  /** Writes every change made since the last save, in one transaction. On failure the changes are kept for the next try. */
  flush(): Promise<void> {
    const s = this.state;
    const run = s.saving.then(() => this.save());
    s.saving = run.catch(() => undefined);
    return run;
  }

  private async save(): Promise<void> {
    const s = this.state;
    if (s.pending.length === 0) return;
    const ops = s.pending.splice(0, s.pending.length);
    const statements: InStatement[] = ops.map((op) =>
      op.kind === "put"
        ? { sql: "INSERT INTO records (collection, id, json) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET json = excluded.json", args: [op.collection, op.id, op.json] }
        : { sql: "DELETE FROM records WHERE collection = ? AND id = ?", args: [op.collection, op.id] },
    );
    try {
      await this.withTable(async () => (await this.getClient()).batch(statements, "write"));
      s.lastError = null;
    } catch (err) {
      s.pending.unshift(...ops);
      const message = `The database couldn't save the changes (${reason(err)}). They are kept and will be tried again.`;
      s.lastError = message;
      throw new StorageError("unwritable", message);
    }
  }

  /** Test-only: removes every record from the database and the copy. */
  async __wipe(): Promise<void> {
    const s = this.state;
    s.pending.length = 0;
    await this.ensureTable();
    await (await this.getClient()).execute("DELETE FROM records");
    for (const name of COLLECTIONS) s.data.set(name, []);
  }
}

class TursoRepository<T extends { id: string }> implements Repository<T> {
  constructor(
    private readonly backend: TursoBackend,
    private readonly name: CollectionName,
  ) {}

  private rows(): T[] {
    return this.backend.rows<T>(this.name);
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
    this.backend.set(this.name, [...this.rows(), record], { kind: "put", collection: this.name, id: record.id, json: JSON.stringify(record) });
    return record;
  }

  update(id: string, patch: Partial<T>): T | undefined {
    const rows = this.rows();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return undefined;
    const next = { ...rows[idx], ...patch };
    const copy = [...rows];
    copy[idx] = next;
    this.backend.set(this.name, copy, { kind: "put", collection: this.name, id, json: JSON.stringify(next) });
    return next;
  }

  remove(id: string): boolean {
    const rows = this.rows();
    if (!rows.some((r) => r.id === id)) return false;
    this.backend.set(this.name, rows.filter((r) => r.id !== id), { kind: "del", collection: this.name, id });
    return true;
  }

  removeWhere(pred: (r: T) => boolean): number {
    const rows = this.rows();
    const gone = rows.filter(pred);
    if (gone.length === 0) return 0;
    const kept = rows.filter((r) => !pred(r));
    this.backend.set(this.name, kept, null);
    for (const row of gone) this.backend.set(this.name, kept, { kind: "del", collection: this.name, id: row.id });
    return gone.length;
  }

  __reset(): void {
    const rows = this.rows();
    this.backend.set(this.name, [], null);
    for (const row of rows) this.backend.set(this.name, [], { kind: "del", collection: this.name, id: row.id });
  }
}
