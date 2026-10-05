import { newId, normalize, type AutomationDraft } from "./model";

/**
 * Where the builder keeps things: this browser's localStorage. Flows, which
 * ones are attached to which bot, and a bot's symbol-scan settings are all
 * designs - none of it reaches the engine. Every access is guarded: storage
 * can be blocked or full, and the UI must still work (just not remember).
 */
const KEYS = {
  library: "automation:ui:library",
  attached: (botId: string) => `automation:ui:attached:${botId}`,
  symbols: (botId: string) => `automation:ui:symbols:${botId}`,
  folders: "automation:ui:folders",
  helpHidden: "automation:ui:inputs-help-hidden",
  recentSymbols: "automation:ui:recent-symbols",
};

export const DEFAULT_FOLDER = "My Automations";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: nothing is remembered, nothing breaks */
  }
}

// --- library of saved flows -------------------------------------------------

export function loadLibrary(): AutomationDraft[] {
  return read<AutomationDraft[]>(KEYS.library, []);
}

export function saveDraft(draft: AutomationDraft): AutomationDraft[] {
  const next = [...loadLibrary().filter((d) => d.id !== draft.id), { ...draft, steps: normalize(draft.steps), updatedAt: Date.now() }];
  write(KEYS.library, next);
  return next;
}

export function deleteDraft(id: string): AutomationDraft[] {
  const next = loadLibrary().filter((d) => d.id !== id);
  write(KEYS.library, next);
  return next;
}

export const blankDraft = (): AutomationDraft => ({ id: newId("auto"), name: "New Automation", folder: DEFAULT_FOLDER, steps: [], inputs: [], updatedAt: Date.now() });

export function loadFolders(): string[] {
  return [...new Set([DEFAULT_FOLDER, ...read<string[]>(KEYS.folders, []), ...loadLibrary().map((d) => d.folder)])];
}

export function addFolder(name: string): string[] {
  const trimmed = name.trim();
  if (trimmed) write(KEYS.folders, [...new Set([...read<string[]>(KEYS.folders, []), trimmed])]);
  return loadFolders();
}

// --- automations attached to a bot ------------------------------------------

export interface Attachment {
  draftId: string;
  /** One of SCHEDULES. */
  schedule: string;
  enabled: boolean;
}

export const SCHEDULES = [
  "Every minute, market hours",
  "Every 5 minutes, market hours",
  "Every 15 minutes, market hours",
  "Once at the open (9:35am ET)",
  "Once at the close (3:55pm ET)",
];

export const loadAttached = (botId: string) => read<Attachment[]>(KEYS.attached(botId), []);

export function attach(botId: string, a: Attachment): Attachment[] {
  const next = [...loadAttached(botId).filter((x) => x.draftId !== a.draftId), a];
  write(KEYS.attached(botId), next);
  return next;
}

export function detach(botId: string, draftId: string): Attachment[] {
  const next = loadAttached(botId).filter((x) => x.draftId !== draftId);
  write(KEYS.attached(botId), next);
  return next;
}

export function setAttachmentEnabled(botId: string, draftId: string, enabled: boolean): Attachment[] {
  const next = loadAttached(botId).map((x) => (x.draftId === draftId ? { ...x, enabled } : x));
  write(KEYS.attached(botId), next);
  return next;
}

// --- symbol scan settings ---------------------------------------------------

export interface SymbolSettings {
  watchlist: string;
  sort: string;
  positionsFilter: { enabled: boolean; op: string };
  earningsFilter: { enabled: boolean; window: string };
  indicators: { id: string; indicator: string; cmp: string; value: string }[];
  limit: string;
  excluded: string[];
  notes: string;
}

export const DEFAULT_SYMBOL_SETTINGS: SymbolSettings = {
  watchlist: "",
  sort: "None",
  positionsFilter: { enabled: false, op: "1 or more" },
  earningsFilter: { enabled: false, window: "30 days" },
  indicators: [],
  limit: "10 symbols",
  excluded: [],
  notes: "",
};

export const loadSymbolSettings = (botId: string): SymbolSettings => ({ ...DEFAULT_SYMBOL_SETTINGS, ...read<Partial<SymbolSettings>>(KEYS.symbols(botId), {}) });

export function saveSymbolSettings(botId: string, s: SymbolSettings): void {
  write(KEYS.symbols(botId), s);
  const recents = read<string[]>(KEYS.recentSymbols, []);
  write(KEYS.recentSymbols, [...new Set([...s.excluded, ...recents])].slice(0, 20));
}

export const loadRecentSymbols = () => read<string[]>(KEYS.recentSymbols, []);

// --- small flags ------------------------------------------------------------

export const isInputsHelpHidden = () => read<boolean>(KEYS.helpHidden, false);
export const hideInputsHelp = () => write(KEYS.helpHidden, true);
