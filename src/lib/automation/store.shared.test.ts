import { describe, expect, it, vi } from "vitest";

// Two copies of the store module - like a Next route handler and a server-rendered
// page, which are bundled separately - must see each other's writes immediately.
describe("store cache is shared across module copies", () => {
  it("a read in one copy sees a write made later through another", async () => {
    vi.resetModules();
    const page = await import("./store");
    expect(page.botsStore.get("shared-bot")).toBeUndefined(); // the page has read (and cached) the store

    vi.resetModules();
    const route = await import("./store");
    expect(route).not.toBe(page);
    route.botsStore.insert({ id: "shared-bot", enabled: false, needsAttention: false, needsAttentionReason: null, createdAt: 1 });

    expect(page.botsStore.get("shared-bot")?.id).toBe("shared-bot");
    route.botsStore.remove("shared-bot");
    expect(page.botsStore.get("shared-bot")).toBeUndefined();
  });
});


describe("where the records live", () => {
  it("uses AUTOMATION_DATA_DIR when it can be written, else ./data/automation", async () => {
    const { resolveDataDir } = await import("./store");
    expect(resolveDataDir({ AUTOMATION_DATA_DIR: "/somewhere" }, () => true)).toEqual({ dir: "/somewhere", temporary: false });
    expect(resolveDataDir({}, () => true).dir).toMatch(/data[/\\]automation$/);
  });

  it("falls back to a temporary folder on a read-only host, and says so", async () => {
    const { resolveDataDir } = await import("./store");
    const choice = resolveDataDir({}, (dir) => dir.includes("spx-predict-automation"));
    expect(choice.temporary).toBe(true);
    expect(choice.dir).toMatch(/spx-predict-automation$/);
  });

  it("with nothing writable it keeps the preferred folder (the problem is then reported)", async () => {
    const { resolveDataDir } = await import("./store");
    expect(resolveDataDir({ AUTOMATION_DATA_DIR: "/nope" }, () => false)).toEqual({ dir: "/nope", temporary: false });
  });

  it("Vercel is reported as unfit to run the engine even though its pages work", async () => {
    const { storageProblem } = await import("./store");
    vi.stubEnv("VERCEL", "1");
    expect(storageProblem()).toMatch(/Vercel, a serverless host/);
    vi.stubEnv("VERCEL", "");
    expect(storageProblem()).toBeNull();
    vi.unstubAllEnvs();
  });
});
