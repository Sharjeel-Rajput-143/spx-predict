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
