import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { ActivityAlert, AppSettingsRow, Bot, BotTemplate, Decision, ErrorRecord, Order, Position, Run, Signal } from "./types";

/**
 * Tiny JSON-file-backed store, same shape as automations/store.ts's JsonStore
 * but copied rather than imported - this module must not reach into the
 * (unrelated, outbound) automations feature, and vice versa. Swap this file
 * for a real database later; callers only ever see all/get/query/insert/update.
 */
// Overridable so the test suite never reads/writes the same files a running
// dev/prod process uses (see vitest.setup.ts).
const DATA_DIR = process.env.AUTOMATION_DATA_DIR ?? path.join(process.cwd(), "data", "automation");

/**
 * One in-memory cache per file, shared by every copy of this module. Next
 * bundles route handlers and server-rendered pages as separate module graphs,
 * so a plain per-instance cache would let a page keep serving what it read
 * before a route wrote something new (e.g. a bot just created through the API
 * 404ing on its own page).
 */
const globalForStores = globalThis as typeof globalThis & { __automationStoreCaches?: Map<string, unknown[]> };
const caches = (globalForStores.__automationStoreCaches ??= new Map<string, unknown[]>());

class JsonStore<T extends { id: string }> {
  private file: string;

  constructor(name: string) {
    this.file = path.join(DATA_DIR, `${name}.json`);
  }

  private get cache(): T[] | null {
    return (caches.get(this.file) as T[] | undefined) ?? null;
  }

  private set cache(rows: T[] | null) {
    if (rows) caches.set(this.file, rows);
    else caches.delete(this.file);
  }

  private load(): T[] {
    const cached = this.cache;
    if (cached) return cached;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let rows: T[];
    try {
      rows = JSON.parse(fs.readFileSync(this.file, "utf8")) as T[];
    } catch {
      rows = [];
    }
    this.cache = rows;
    return rows;
  }

  private persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write-then-rename so a crash mid-write can't leave a truncated file
    // (which load() would read as "empty" and silently forget every position).
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
    fs.renameSync(tmp, this.file);
  }

  all(): T[] {
    return [...this.load()];
  }

  get(id: string): T | undefined {
    return this.load().find((r) => r.id === id);
  }

  query(pred: (r: T) => boolean): T[] {
    return this.load().filter(pred);
  }

  insert(record: T): T {
    const rows = this.load();
    rows.push(record);
    this.persist();
    return record;
  }

  update(id: string, patch: Partial<T>): T | undefined {
    const rows = this.load();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return undefined;
    rows[idx] = { ...rows[idx], ...patch };
    this.persist();
    return rows[idx];
  }

  remove(id: string): boolean {
    const rows = this.load();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    rows.splice(idx, 1);
    this.persist();
    return true;
  }

  removeWhere(pred: (r: T) => boolean): number {
    const rows = this.load();
    const kept = rows.filter((r) => !pred(r));
    const removed = rows.length - kept.length;
    if (removed > 0) {
      this.cache = kept;
      this.persist();
    }
    return removed;
  }

  /** Test-only escape hatch: resets this store to empty, in memory and on disk. */
  __reset(): void {
    this.cache = [];
    this.persist();
  }
}

export const botsStore = new JsonStore<Bot>("bots");
export const signalsStore = new JsonStore<Signal>("signals");
export const positionsStore = new JsonStore<Position>("positions");
export const ordersStore = new JsonStore<Order>("orders");
export const decisionsStore = new JsonStore<Decision>("decisions");
export const errorsStore = new JsonStore<ErrorRecord>("errors");
export const templatesStore = new JsonStore<BotTemplate>("templates");
export const runsStore = new JsonStore<Run>("runs");
export const alertsStore = new JsonStore<ActivityAlert>("alerts");
/** One row (id "app"): the app-wide settings from the Settings page. */
export const settingsStore = new JsonStore<AppSettingsRow>("settings");

export function __resetAllStores(): void {
  botsStore.__reset();
  signalsStore.__reset();
  positionsStore.__reset();
  ordersStore.__reset();
  decisionsStore.__reset();
  errorsStore.__reset();
  templatesStore.__reset();
  runsStore.__reset();
  alertsStore.__reset();
  settingsStore.__reset();
}
