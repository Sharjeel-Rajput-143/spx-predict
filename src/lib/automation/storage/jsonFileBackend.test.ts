import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFileBackend, nodeFileOps, type FileOps } from "./jsonFileBackend";
import { COLLECTIONS, SCHEMA_VERSION, StorageError } from "./repository";

// The JSON-file implementation of the storage interface: versioned files, atomic writes, and a clear error - never
// a silent empty start - for a damaged or missing file. Each test uses its own folder; nothing here touches app data.

interface Row {
  id: string;
  n?: number;
  secret?: string;
}

let dir: string;
let backends: JsonFileBackend[];

const make = (ops?: FileOps) => {
  const b = new JsonFileBackend(dir, ops);
  backends.push(b);
  return b;
};
const file = (name: string) => path.join(dir, `${name}.json`);
const read = (name: string) => JSON.parse(fs.readFileSync(file(name), "utf8"));
/** What a restart does: the memory is gone and the next read comes from the files. */
const restart = () => {
  backends.forEach((b) => b.dropCaches());
  return make();
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "spx-storage-test-"));
  backends = [];
});
afterEach(() => {
  backends.forEach((b) => b.dropCaches());
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a fresh folder", () => {
  it("is set up on first use: a meta file and one versioned file per collection", () => {
    make().repository<Row>("bots").all();
    expect(read("meta")).toMatchObject({ schemaVersion: SCHEMA_VERSION });
    for (const name of COLLECTIONS) expect(read(name)).toEqual({ schemaVersion: SCHEMA_VERSION, collection: name, items: [] });
  });

  it("keeps what is written, with a schema version in the file", () => {
    const bots = make().repository<Row>("bots");
    bots.insert({ id: "a", n: 1 });
    bots.insert({ id: "b", n: 2 });
    bots.update("a", { n: 10 });
    bots.remove("b");
    expect(read("bots")).toEqual({ schemaVersion: SCHEMA_VERSION, collection: "bots", items: [{ id: "a", n: 10 }] });
  });
});

describe("persistence across a restart", () => {
  it("everything written is read back from the files after the memory is gone", () => {
    const first = make();
    first.repository<Row>("webhooks").insert({ id: "w1", secret: "token-1" });
    first.repository<Row>("positions").insert({ id: "p1", n: 3 });
    first.repository<Row>("positions").update("p1", { n: 4 });

    const second = restart();
    expect(second.repository<Row>("webhooks").get("w1")).toEqual({ id: "w1", secret: "token-1" });
    expect(second.repository<Row>("positions").all()).toEqual([{ id: "p1", n: 4 }]);
  });

  it("a restart does not set the folder up again or wipe it", () => {
    make().repository<Row>("runs").insert({ id: "r1" });
    const created = read("meta").createdAt;
    restart().repository<Row>("runs").all();
    expect(read("meta").createdAt).toBe(created);
    expect(read("runs").items).toHaveLength(1);
  });
});

describe("a folder from before schema versions", () => {
  it("is upgraded in place: bare arrays are kept and wrapped, missing files are added", () => {
    fs.writeFileSync(file("bots"), JSON.stringify([{ id: "old-bot", n: 7 }]));
    fs.writeFileSync(file("positions"), JSON.stringify([{ id: "old-pos" }]));
    const b = make();
    expect(b.repository<Row>("bots").all()).toEqual([{ id: "old-bot", n: 7 }]);
    expect(read("bots")).toEqual({ schemaVersion: SCHEMA_VERSION, collection: "bots", items: [{ id: "old-bot", n: 7 }] });
    expect(read("positions").items).toEqual([{ id: "old-pos" }]);
    expect(read("webhooks").items).toEqual([]);
    expect(read("meta").schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("a damaged old file stops the upgrade and is left exactly as it was", () => {
    fs.writeFileSync(file("bots"), "[{\"id\":\"x\"");
    expect(() => make().repository<Row>("bots").all()).toThrow(StorageError);
    expect(fs.readFileSync(file("bots"), "utf8")).toBe("[{\"id\":\"x\"");
    expect(fs.existsSync(path.join(dir, "meta.json"))).toBe(false);
  });
});

describe("a damaged file is an error, never an empty start", () => {
  const setUp = () => {
    const b = make();
    b.repository<Row>("positions").insert({ id: "p1", n: 1 });
    return restart();
  };

  it("not valid JSON: the error names the file, and the file is left alone", () => {
    setUp();
    fs.writeFileSync(file("positions"), '{"schemaVersion":1,"items":[{"id":"p1"');
    const b = restart();
    let error: unknown;
    try {
      b.repository<Row>("positions").all();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe("corrupt");
    expect((error as StorageError).message).toContain(file("positions"));
    expect((error as StorageError).message).toMatch(/not valid JSON/);
    expect(fs.readFileSync(file("positions"), "utf8")).toBe('{"schemaVersion":1,"items":[{"id":"p1"'); // never overwritten with empty
  });

  it("a write after a failed read is refused too: it can't replace the damaged file with new content", () => {
    setUp();
    fs.writeFileSync(file("positions"), "garbage");
    const positions = restart().repository<Row>("positions");
    expect(() => positions.insert({ id: "p2" })).toThrow(/damaged/);
    expect(fs.readFileSync(file("positions"), "utf8")).toBe("garbage");
  });

  it("the wrong shape, no schema version, the wrong collection, or an item without an id", () => {
    setUp();
    const cases: [string, string][] = [
      [JSON.stringify({ schemaVersion: 1, collection: "positions", items: "nope" }), "expected shape"],
      [JSON.stringify({ collection: "positions", items: [] }), "no schema version"],
      [JSON.stringify({ schemaVersion: 1, collection: "orders", items: [] }), 'should hold "positions"'],
      [JSON.stringify({ schemaVersion: 1, collection: "positions", items: [{ n: 1 }] }), "no id"],
    ];
    for (const [content, why] of cases) {
      fs.writeFileSync(file("positions"), content);
      expect(() => restart().repository<Row>("positions").all(), why).toThrow(why);
    }
  });

  it("check() reports it in words, for the status page and the webhook (a 503, not a crash)", () => {
    setUp();
    expect(restart().check()).toBeNull();
    fs.writeFileSync(file("bots"), "{");
    const message = restart().check();
    expect(message).toContain(file("bots"));
    expect(message).toMatch(/damaged/);
  });

  it("a file that is MISSING from a folder that was set up is an error, not an empty collection", () => {
    setUp();
    fs.rmSync(file("positions"));
    const b = restart();
    expect(() => b.repository<Row>("positions").all()).toThrow(StorageError);
    try {
      b.repository<Row>("positions").all();
    } catch (err) {
      expect((err as StorageError).code).toBe("missing");
      expect((err as StorageError).message).toContain(file("positions"));
    }
    expect(fs.existsSync(file("positions"))).toBe(false); // and it was not recreated behind anyone's back
  });

  it("a folder written by a newer version of the app is refused", () => {
    setUp();
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }));
    expect(() => restart().repository<Row>("bots").all()).toThrow(/newer version/);
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ schemaVersion: SCHEMA_VERSION }));
    fs.writeFileSync(file("bots"), JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, collection: "bots", items: [] }));
    expect(() => restart().repository<Row>("bots").all()).toThrow(/newer version/);
  });

  it("a damaged meta file is refused too", () => {
    setUp();
    fs.writeFileSync(path.join(dir, "meta.json"), "{}");
    expect(() => restart().repository<Row>("bots").all()).toThrow(/no schema version/);
  });
});

describe("atomic writes", () => {
  /** Real file operations, recorded - and one of them can be made to fail at a chosen moment. */
  function recording(failAt?: "write" | "rename" | "half-write") {
    const calls: string[] = [];
    const ops: FileOps = {
      ...nodeFileOps,
      writeFileSyncDurable: (f, content) => {
        calls.push(`write ${path.basename(f)}`);
        if (failAt === "write") throw new Error("disk full");
        if (failAt === "half-write") {
          fs.writeFileSync(f, content.slice(0, Math.floor(content.length / 2)));
          throw new Error("power cut");
        }
        nodeFileOps.writeFileSyncDurable(f, content);
      },
      renameSync: (from, to) => {
        calls.push(`rename ${path.basename(from)} -> ${path.basename(to)}`);
        if (failAt === "rename") throw new Error("rename failed");
        nodeFileOps.renameSync(from, to);
      },
    };
    return { ops, calls };
  }

  it("writes a temp file first, then renames it over the real one - never the real file directly", () => {
    const { ops, calls } = recording();
    const bots = make(ops).repository<Row>("bots");
    bots.all(); // the folder is set up on first use; only the write after that is under test
    calls.length = 0;
    bots.insert({ id: "a" });
    expect(calls).toEqual(["write bots.json.tmp", "rename bots.json.tmp -> bots.json"]);
    expect(fs.existsSync(`${file("bots")}.tmp`)).toBe(false);
  });

  it.each(["write", "half-write", "rename"] as const)("a failure at '%s' leaves the previous file intact, no stray temp file, and the memory unchanged", (failAt) => {
    const first = make().repository<Row>("positions");
    first.insert({ id: "p1", n: 1 });
    const before = fs.readFileSync(file("positions"), "utf8");

    backends.forEach((b) => b.dropCaches());
    const { ops } = recording(failAt);
    const positions = make(ops).repository<Row>("positions");
    expect(positions.all()).toHaveLength(1);
    expect(() => positions.insert({ id: "p2" })).toThrow(/Couldn't write/);

    expect(fs.readFileSync(file("positions"), "utf8")).toBe(before); // the old content, whole
    expect(fs.existsSync(`${file("positions")}.tmp`)).toBe(false);
    expect(positions.all().map((r) => r.id)).toEqual(["p1"]); // what the engine sees matches what is on disk
    expect(restart().repository<Row>("positions").all().map((r) => r.id)).toEqual(["p1"]);
  });

  it("an update, a remove and a bulk remove each go through the same temp-then-rename path", () => {
    const { ops, calls } = recording();
    const rows = make(ops).repository<Row>("orders");
    rows.all();
    rows.insert({ id: "a" });
    rows.insert({ id: "b" });
    calls.length = 0;
    rows.update("a", { n: 1 });
    rows.remove("b");
    rows.removeWhere(() => true);
    expect(calls).toEqual(Array(3).fill(["write orders.json.tmp", "rename orders.json.tmp -> orders.json"]).flat());
  });
});
