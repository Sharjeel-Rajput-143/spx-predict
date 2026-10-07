import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonFileBackend } from "./storage/jsonFileBackend";
import type { CollectionName, Repository, StorageBackend } from "./storage/repository";
import { TursoBackend } from "./storage/tursoBackend";
import type { ActivityAlert, AppSettingsRow, Bot, Webhook, BotTemplate, Decision, ErrorRecord, Order, Position, Run, Signal } from "./types";

/**
 * The engine's records. This module is the only place that knows where they live; everything else calls the
 * repositories exported at the bottom (all / get / query / insert / update / remove). It does not reach into the
 * (unrelated, outbound) automations feature, and that feature does not reach into this.
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

/** Turso (a hosted database) holds the records when it is asked for (AUTOMATION_STORAGE=turso) or, on Vercel, whenever
 * its credentials are set: a serverless host has no disk of its own. Otherwise (a laptop, a server with a disk) the records
 * are JSON files, whatever is in TURSO_*; AUTOMATION_STORAGE=files forces that. Null means: use the files. */
export function tursoChoice(env: Record<string, string | undefined> = process.env): { url: string; authToken: string } | null {
  const url = env.TURSO_DB_URL?.trim();
  const authToken = env.TURSO_DB_TOKEN?.trim();
  const wanted = env.AUTOMATION_STORAGE === "turso" || (env.AUTOMATION_STORAGE !== "files" && Boolean(env.VERCEL));
  if (!wanted || !url || !authToken) return null;
  return { url, authToken };
}

const TURSO = tursoChoice();
const CHOICE = resolveDataDir();
const DATA_DIR = CHOICE.dir;

/** Why this host can't run the engine with a BROKER, or null. A real broker needs a server that stays up with a writable
 * disk: the engine keeps its state in files and in memory and keeps working after it has answered an alert (placing orders,
 * waiting up to minutes for fills), which a serverless function may stop. With only the mock executor (a demo) none of that
 * matters, so nothing is reported - the pages simply run on a temporary folder when the disk is read-only. */
export function storageProblem(): string | null {
  if (TURSO) {
    // The records are in the database, so there is no folder to check. A broker still can't be driven from a serverless host.
    if (process.env.VERCEL && process.env.EXECUTOR?.trim().toLowerCase() === "tradier") {
      return "A broker can't be driven from Vercel: it is a serverless host, and the engine keeps working after it answers an alert (placing orders, waiting for fills), which a serverless function may stop. Run it on a server that stays up (see docs/deploying.md).";
    }
    return storage.check();
  }
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
  // A damaged, missing or too-new data file stops the engine with a message naming it - never an empty start.
  return storage.check();
}

/** The one storage backend: JSON files in DATA_DIR (storage/jsonFileBackend.ts). The engine, the routes and the pages
 * only use the repositories below - nothing else opens a file - so a database implementation of the same
 * Repository interface can replace this one later without any engine change. */
export const storage: StorageBackend = TURSO ? new TursoBackend({ url: TURSO.url, authToken: TURSO.authToken }) : new JsonFileBackend(DATA_DIR);

const repo = <T extends { id: string }>(name: CollectionName): Repository<T> => storage.repository<T>(name);

export const botsStore = repo<Bot>("bots");
export const signalsStore = repo<Signal>("signals");
export const positionsStore = repo<Position>("positions");
export const ordersStore = repo<Order>("orders");
export const decisionsStore = repo<Decision>("decisions");
export const errorsStore = repo<ErrorRecord>("errors");
export const templatesStore = repo<BotTemplate>("templates");
export const runsStore = repo<Run>("runs");
export const alertsStore = repo<ActivityAlert>("alerts");
export const webhooksStore = repo<Webhook>("webhooks");
/** One row (id "app"): the app-wide settings from the Settings page. */
export const settingsStore = repo<AppSettingsRow>("settings");

/** Test hook: forget what is in memory so the next read comes from the files, as after a restart. */
export function __simulateRestart(): void {
  storage.dropCaches?.();
}

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
