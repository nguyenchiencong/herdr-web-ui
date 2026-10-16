import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import { readJsonEntries, readJsonState, writeFileAtomic } from "./state-file.ts";

const dirs: string[] = [];
afterEach(() => {
  mock.restore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "state-file-"));
  dirs.push(dir);
  return dir;
}
/** The names a damaged file was moved to. */
const kept = (dir: string, name: string): string[] => readdirSync(dir).filter((entry) => entry.startsWith(`${name}.corrupt-`));
const anything = (value: unknown) => value;

describe("readJsonState", () => {
  it("reads a missing file as nothing and creates nothing", () => {
    const dir = directory();
    expect(readJsonState(join(dir, "state.json"), anything)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("reads a valid file, with or without a byte-order mark", () => {
    const dir = directory();
    const path = join(dir, "state.json");
    writeFileSync(path, "{\"ok\":true}");
    expect(readJsonState(path, (value) => value as { ok: boolean })).toEqual({ ok: true });
    writeFileSync(path, "\uFEFF{\"ok\":true}");
    expect(readJsonState(path, (value) => value as { ok: boolean })).toEqual({ ok: true });
    expect(kept(dir, "state.json")).toEqual([]);
  });

  it("moves a zero-filled file aside with its bytes, and warns once naming it", () => {
    const dir = directory();
    const path = join(dir, "state.json");
    writeFileSync(path, Buffer.alloc(6605));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(readJsonState(path, anything)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    const [copy] = kept(dir, "state.json");
    expect(copy).toBeDefined();
    expect(readFileSync(join(dir, copy!)).equals(Buffer.alloc(6605))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(path);
    expect(String(warn.mock.calls[0]?.[0])).toContain("is not valid JSON");
  });

  it("moves a truncated file aside", () => {
    const dir = directory();
    const path = join(dir, "state.json");
    writeFileSync(path, "{\"install_id\":\"0b5f");
    spyOn(console, "warn").mockImplementation(() => {});
    expect(readJsonState(path, anything)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(kept(dir, "state.json")).toHaveLength(1);
  });

  it("moves a file of the wrong shape aside, including one the parser throws on", () => {
    const dir = directory();
    const path = join(dir, "state.json");
    spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(path, "[1,2]");
    expect(readJsonState(path, (value) => Array.isArray(value) && value.length === 0 ? [] : undefined)).toBeUndefined();
    writeFileSync(path, "{}");
    expect(readJsonState(path, () => { throw new Error("no such shape"); })).toBeUndefined();
    expect(readdirSync(dir).filter((entry) => entry.startsWith("state.json.corrupt-"))).toHaveLength(2);
    expect(existsSync(path)).toBe(false);
  });

  it("a read that fails for a reason other than a missing file throws, and the file stays where it is", () => {
    const dir = directory();
    const path = join(dir, "state.json");
    mkdirSync(path);
    spyOn(console, "warn").mockImplementation(() => {});
    expect(() => readJsonState(path, anything)).toThrow();
    expect(statSync(path).isDirectory()).toBe(true);
    expect(kept(dir, "state.json")).toEqual([]);
  });

  it("retries a read that another process briefly blocks, then reads the file", () => {
    const dir = directory();
    const path = join(dir, "state.json");
    writeFileSync(path, "{\"ok\":true}");
    const read = fs.readFileSync;
    let refused = 0;
    spyOn(fs, "readFileSync").mockImplementation(((file: unknown, options?: unknown) => {
      if (file === path && refused < 2) { refused++; throw Object.assign(new Error("busy"), { code: "EBUSY" }); }
      return read(file as string, options as "utf8");
    }) as typeof fs.readFileSync);
    expect(readJsonState(path, (value) => value as { ok: boolean })).toEqual({ ok: true });
    expect(refused).toBe(2);
  });

  it("gives up on a read that stays blocked, and leaves the file as it was", () => {
    const dir = directory();
    const path = join(dir, "state.json");
    writeFileSync(path, "{\"ok\":true}");
    const read = fs.readFileSync;
    spyOn(fs, "readFileSync").mockImplementation(((file: unknown, options?: unknown) => {
      if (file === path) throw Object.assign(new Error("locked"), { code: "EPERM" });
      return read(file as string, options as "utf8");
    }) as typeof fs.readFileSync);
    expect(() => readJsonState(path, anything)).toThrow("locked");
    mock.restore();
    expect(readFileSync(path, "utf8")).toBe("{\"ok\":true}");
    expect(kept(dir, "state.json")).toEqual([]);
  });

  it("keeps every damaged copy under a name of its own", () => {
    const dir = directory();
    const path = join(dir, "state.json");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    for (const damage of ["{a", "{b", "{c"]) {
      writeFileSync(path, damage);
      expect(readJsonState(path, anything)).toBeUndefined();
    }
    expect(kept(dir, "state.json").map((name) => readFileSync(join(dir, name), "utf8")).sort()).toEqual(["{a", "{b", "{c"]);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe("readJsonEntries", () => {
  type Plain = { id: string };
  const plain = (value: unknown, kept: readonly Plain[]): Plain | undefined => {
    const entry = value as { id: string; bad?: boolean; throws?: boolean };
    if (entry.throws) throw new Error("refused");
    return entry.bad || kept.some((other) => other.id === entry.id) ? undefined : { id: entry.id };
  };

  it("keeps the entries that check out, drops the others by id, and copies the file rather than moving it", () => {
    const dir = directory();
    const path = join(dir, "list.json");
    const original = JSON.stringify([{ id: "a" }, { id: "b", bad: true }, { id: "a" }, { id: "c", throws: true }]);
    writeFileSync(path, original);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(readJsonEntries(path, plain, "id")).toEqual({ entries: [{ id: "a" }], dropped: ["b", "a", "c"] });
    expect(readFileSync(path, "utf8")).toBe(original);
    const [copy] = kept(dir, "list.json");
    expect(copy).toBeDefined();
    expect(readFileSync(join(dir, copy!), "utf8")).toBe(original);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0])).toContain("entry b ");
  });

  it("returns undefined for a missing file, and moves aside a file that is not a list", () => {
    const dir = directory();
    const path = join(dir, "list.json");
    expect(readJsonEntries(path, plain, "id")).toBeUndefined();
    writeFileSync(path, "{}");
    spyOn(console, "warn").mockImplementation(() => {});
    expect(readJsonEntries(path, plain, "id")).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(kept(dir, "list.json")).toHaveLength(1);
  });

  it("keeps a list whose entries all check out, without a copy", () => {
    const dir = directory();
    const path = join(dir, "list.json");
    writeFileSync(path, JSON.stringify([{ id: "a" }]));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(readJsonEntries(path, plain, "id")).toEqual({ entries: [{ id: "a" }], dropped: [] });
    expect(kept(dir, "list.json")).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("writeFileAtomic", () => {
  it("replaces a file in one step and leaves no temporary file behind", () => {
    const dir = directory();
    const path = join(dir, "state.json");
    writeFileAtomic(path, "one");
    writeFileAtomic(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("creates the directories it writes into", () => {
    const dir = directory();
    const path = join(dir, "nested", "deeper", "state.json");
    writeFileAtomic(path, "x");
    expect(readFileSync(path, "utf8")).toBe("x");
  });

  it("writes bytes as they are", () => {
    const dir = directory();
    const path = join(dir, "bytes.bin");
    writeFileAtomic(path, new Uint8Array([0, 255, 10, 13]));
    expect(readFileSync(path).equals(Buffer.from([0, 255, 10, 13]))).toBe(true);
  });

  it("gives the file owner-only mode", () => {
    if (process.platform === "win32") return;
    const dir = directory();
    const path = join(dir, "state.json");
    writeFileAtomic(path, "new");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("a write whose rename fails throws, leaves the old file as it was, and removes its own temporary file", () => {
    const dir = directory();
    const path = join(dir, "state.json");
    writeFileSync(path, "old");
    spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("locked"), { code: "EPERM" }); });
    expect(() => writeFileAtomic(path, "new")).toThrow("locked");
    mock.restore();
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("gives each write a temporary name of its own, leaving a temporary file of the old fixed name alone", () => {
    const dir = directory();
    const path = join(dir, "state.json");
    writeFileSync(`${path}.${process.pid}.tmp`, "stale");
    const rename = spyOn(fs, "renameSync");
    writeFileAtomic(path, "one");
    writeFileAtomic(path, "two");
    const sources = rename.mock.calls.map(([from]) => String(from));
    expect(sources).toHaveLength(2);
    expect(new Set(sources).size).toBe(2);
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(readFileSync(`${path}.${process.pid}.tmp`, "utf8")).toBe("stale");
  });

  it("a rename that fails throws and removes its temporary file", () => {
    const dir = directory();
    const target = join(dir, "state.json");
    mkdirSync(target);
    expect(() => writeFileAtomic(target, "new")).toThrow();
    expect(readdirSync(dir)).toEqual(["state.json"]);
    expect(statSync(target).isDirectory()).toBe(true);
  });
});
