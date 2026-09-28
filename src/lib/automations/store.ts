import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { AlertConnection, AlertRule, AlertTriggerLog } from "./types";

/**
 * Tiny JSON-file-backed store, standing in for a real database. The app has
 * no backend persistence or multi-user auth anywhere else today (everything
 * is localStorage + a single mock user), so a full DB + auth layer would be
 * a much bigger addition than "add signal automations" asked for. Swap this
 * for a real database by replacing this file only - callers just see
 * all/get/insert/update/remove/query.
 */
const DATA_DIR = path.join(process.cwd(), "data", "automations");

class JsonStore<T extends { id: string }> {
  private file: string;
  private cache: T[] | null = null;

  constructor(name: string) {
    this.file = path.join(DATA_DIR, `${name}.json`);
  }

  private load(): T[] {
    if (this.cache) return this.cache;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, "utf8")) as T[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
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
}

export const connectionsStore = new JsonStore<AlertConnection>("connections");
export const rulesStore = new JsonStore<AlertRule>("rules");
export const triggerLogStore = new JsonStore<AlertTriggerLog>("trigger_log");

/** No real auth in this app - one local demo user, same id as MOCK_USER. */
export const DEMO_USER_ID = "me";
