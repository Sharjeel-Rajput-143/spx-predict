import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActivityAlert, AppSettingsRow, Bot, Webhook, BotTemplate, Decision, ErrorRecord, Order, Position, Run, Signal } from "./types";

/**
 * Tiny JSON-file-backed store, same shape as automations/store.ts's JsonStore
 * but copied rather than imported - this module must not reach into the
 * (unrelated, outbound) automations feature, and vice versa. Swap this file
 * for a real database later; callers only ever see all/get/query/insert/update.
 */
export interface DataDirChoice {
  dir: string;
  /** True when the preferred folder wasn't writable and a temporary one is used instead. */
  temporary: boolean;
}

/** Where the records live: AUTOMATION_DATA_DIR (so tests never touch a running app's files), else ./data/automation.
 * If that can't be written to (a read-only host such as Vercel) the system's temp folder is used, so the pages still
 * work for a look around - with data that is temporary and not shared between instances. */
export function resolveDataDir(env: Record<string, string | undefined> = process.env, canWrite: (dir: string) => boolean = writable): DataDirChoice {
  const preferred = env.AUTOMATION_DATA_DIR ?? path.join(process.cwd(), "data", "automation");
  if (canWrite(preferred)) return { dir: preferred, temporary: false };
  const fallback = path.join(os.tmpdir(), "spx-predict-automation");
  return canWrite(fallback) ? { dir: fallback, temporary: true } : { dir: preferred, temporary: false };
}

function writable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

const CHOICE = resolveDataDir();
const DATA_DIR = CHOICE.dir;

/** Why this host can't run the engine with a BROKER, or null. A real broker needs a server that stays up with a writable
 * disk: the engine keeps its state in files and in memory and keeps working after it has answered an alert (placing orders,
 * waiting up to minutes for fills), which a serverless function may stop. With only the mock executor (a demo) none of that
 * matters, so nothing is reported - the pages simply run on a temporary folder when the disk is read-only. */
export function storageProblem(): string | null {
  const broker = process.env.EXECUTOR?.trim().toLowerCase() === "tradier";
  if (process.env.VERCEL && broker) {
    return "A broker can't be driven from Vercel: it is a serverless host, and the engine keeps working after it answers an alert (placing orders, waiting for fills), which a serverless function may stop. Run it on a server that stays up (see docs/deploying.md).";
  }
  if (!writable(DATA_DIR)) {
    return `This host can't write the bots' records to ${DATA_DIR}. The engine needs a writable disk.`;
  }
  if (broker && CHOICE.temporary) {
    return `A broker is configured but this host's disk is read-only, so the bots' records are in a temporary folder (${DATA_DIR}) that will be lost. Use a server with a writable disk.`;
  }
  return null;
}

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
export const webhooksStore = new JsonStore<Webhook>("webhooks");
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
  webhooksStore.__reset();
}
