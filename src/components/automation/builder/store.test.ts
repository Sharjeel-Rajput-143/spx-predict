import { beforeEach, describe, expect, it } from "vitest";
import { newStep } from "./model";
import {
  DEFAULT_FOLDER,
  DEFAULT_SYMBOL_SETTINGS,
  addFolder,
  attach,
  blankDraft,
  deleteDraft,
  detach,
  hideInputsHelp,
  isInputsHelpHidden,
  loadAttached,
  loadFolders,
  loadLibrary,
  loadRecentSymbols,
  loadSymbolSettings,
  saveDraft,
  saveSymbolSettings,
  setAttachmentEnabled,
} from "./store";

function installStorage(broken = false) {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => {
      if (broken) throw new Error("blocked");
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error("blocked");
      data.set(k, v);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

beforeEach(() => installStorage());

describe("library", () => {
  it("saves, updates in place, and deletes drafts", () => {
    const d = { ...blankDraft(), name: "Opening bias" };
    saveDraft(d);
    saveDraft({ ...d, name: "Opening bias v2" });
    expect(loadLibrary().map((x) => x.name)).toEqual(["Opening bias v2"]);
    deleteDraft(d.id);
    expect(loadLibrary()).toEqual([]);
  });

  it("starts in the default folder and remembers new folders", () => {
    expect(blankDraft().folder).toBe(DEFAULT_FOLDER);
    addFolder("  Experiments ");
    saveDraft({ ...blankDraft(), folder: "Imported" });
    expect(loadFolders()).toEqual([DEFAULT_FOLDER, "Experiments", "Imported"]);
  });

  it("strips empty lanes when saving", () => {
    const step = newStep("open_position");
    saveDraft({ ...blankDraft(), steps: [{ ...step, yes: undefined }] });
    expect(JSON.stringify(loadLibrary()[0].steps[0])).not.toContain("yes");
  });
});

describe("attachments", () => {
  it("attaches with a schedule, toggles, and detaches per bot", () => {
    attach("bot_a", { draftId: "d1", schedule: "Once at the open (9:35am ET)", enabled: true });
    attach("bot_b", { draftId: "d2", schedule: "Every minute, market hours", enabled: true });
    expect(loadAttached("bot_a")).toHaveLength(1);
    setAttachmentEnabled("bot_a", "d1", false);
    expect(loadAttached("bot_a")[0].enabled).toBe(false);
    detach("bot_a", "d1");
    expect(loadAttached("bot_a")).toEqual([]);
    expect(loadAttached("bot_b")).toHaveLength(1);
  });
});

describe("symbol settings", () => {
  it("defaults, then round-trips, and feeds the recents list", () => {
    expect(loadSymbolSettings("bot_a")).toEqual(DEFAULT_SYMBOL_SETTINGS);
    saveSymbolSettings("bot_a", { ...DEFAULT_SYMBOL_SETTINGS, watchlist: "Indexes", excluded: ["TSLA", "GME"] });
    expect(loadSymbolSettings("bot_a")).toMatchObject({ watchlist: "Indexes", excluded: ["TSLA", "GME"] });
    expect(loadRecentSymbols()).toEqual(["TSLA", "GME"]);
  });
});

describe("flags", () => {
  it("remembers that the Inputs help was hidden", () => {
    expect(isInputsHelpHidden()).toBe(false);
    hideInputsHelp();
    expect(isInputsHelpHidden()).toBe(true);
  });
});

describe("blocked storage", () => {
  it("never throws - it just doesn't remember", () => {
    installStorage(true);
    expect(() => saveDraft(blankDraft())).not.toThrow();
    expect(loadLibrary()).toEqual([]);
    expect(() => attach("b", { draftId: "d", schedule: "x", enabled: true })).not.toThrow();
    expect(loadSymbolSettings("b")).toEqual(DEFAULT_SYMBOL_SETTINGS);
    expect(isInputsHelpHidden()).toBe(false);
  });
});
