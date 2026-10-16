import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The JSON files the app keeps in its state directory. Loading one never stops the server.
 *
 * Damage is a file that does not parse or does not have the shape its loader takes. It is kept for
 * recovery: a file is moved to `<name>.corrupt-<time>` and its loader starts empty; in a list only
 * the entries that do not check out are dropped, and the file is copied there whole. Any other read
 * error (a lock held by another program, a directory in the file's place) says nothing about what
 * the file holds: readJsonState throws and the file stays where it is, so its loader must not write
 * it until a read succeeds. Writing one replaces it in a single durable step. A file that holds a
 * trust decision (devices.json, the Portal state, the push key) is not loaded through here: starting
 * it empty would open access or hide a live tunnel, so its own loader fails closed (server/AGENTS.md).
 */

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const READ_RETRIES = 4;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

/** Reads a file, retrying briefly when another process's rename or lock makes it busy (Windows). */
function readText(path: string): string {
  for (let retry = 0; ; retry++) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (retry === READ_RETRIES || !["EBUSY", "EPERM"].includes(errorCode(error) ?? "")) throw error;
      Atomics.wait(SLEEP, 0, 0, 10 * 2 ** retry);
    }
  }
}

/**
 * Reads a JSON state file. `parse` takes the decoded value and returns the state it holds, or
 * undefined for a shape it does not take (throwing counts the same). A missing file reads as
 * undefined. A file that does not parse or is not that shape is moved aside to `<name>.corrupt-<time>`
 * with one warning, and undefined leaves the caller on its empty state; the next save writes a fresh
 * file. Any other read error is thrown, with the file left in place.
 */
export function readJsonState<T>(path: string, parse: (value: unknown) => T | undefined): T | undefined {
  let text: string;
  try {
    text = readText(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return setAside(path, "is not valid JSON");
  }
  let state: T | undefined;
  try {
    state = parse(value);
  } catch {
    state = undefined;
  }
  return state ?? setAside(path, "does not have the expected shape");
}

/** What a list file held: the entries kept, and the id of each entry dropped. */
export interface JsonEntries<T> { entries: T[]; dropped: string[] }

/**
 * Reads a JSON array, keeping each entry `parseEntry` takes. `kept` holds the entries taken so far, so
 * a repeat can be refused. An entry it refuses (undefined, or a throw) is dropped with a warning
 * naming its `idField`, and the file is copied, not moved, to `<name>.corrupt-<time>` so the dropped
 * entry survives for recovery. Undefined for a missing file, and for one that is not an array: that
 * is moved aside whole, as readJsonState does.
 */
export function readJsonEntries<T>(path: string, parseEntry: (entry: unknown, kept: readonly T[]) => T | undefined, idField: string): JsonEntries<T> | undefined {
  const list = readJsonState(path, (value) => Array.isArray(value) ? value : undefined);
  if (list === undefined) return undefined;
  const entries: T[] = [];
  const dropped: string[] = [];
  for (const item of list) {
    let entry: T | undefined;
    try {
      entry = parseEntry(item, entries);
    } catch {
      entry = undefined;
    }
    if (entry === undefined) dropped.push(idOf(item, idField));
    else entries.push(entry);
  }
  if (dropped.length > 0) {
    const copy = keptName(path);
    let copied = true;
    try { copyFileSync(path, copy); } catch { copied = false; }
    for (const id of dropped) console.warn(`state: ${path} entry ${id} is not valid and was dropped; the other entries were kept${copied ? `, and the file was copied to ${copy}` : " (the file could not be copied)"}`);
  }
  return { entries, dropped };
}

function idOf(item: unknown, field: string): string {
  const id = typeof item === "object" && item !== null ? (item as Record<string, unknown>)[field] : undefined;
  return typeof id === "string" ? id.slice(0, 100) : "without an id";
}

/**
 * Replaces `path` with `data` in one step. The bytes go to a temporary file of this write's own name
 * (`<path>.<pid>.<random>.tmp`, opened exclusively), which is fsynced and given `mode` before it is
 * renamed over `path`; the directory is then fsynced where the platform allows it. A crash leaves the
 * old file or the new one, never a zero-filled or half-written one: NTFS and ext4 can persist a rename
 * before the data it names. A failed write removes its own temporary file, throws, and leaves `path`
 * as it was.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, { mode = 0o600 }: { mode?: number } = {}): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let created = false;
  try {
    const fd = openSync(temporary, "wx", mode);
    created = true;
    try {
      for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    // only a file this call created is removed: an exclusive open that failed took nobody's file
    if (created) try { unlinkSync(temporary); } catch { /* already gone */ }
    throw error;
  }
  syncDirectory(dirname(path));
}

/** Makes the rename itself durable. Windows cannot open a directory to fsync it: there NTFS decides. */
function syncDirectory(directory: string): void {
  try {
    const fd = openSync(directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* not openable or syncable on this platform */ }
}

/** Moves a damaged file to a name no earlier copy holds, copying it when it cannot be moved, and warns. */
function setAside(path: string, problem: string): undefined {
  const target = keptName(path);
  try {
    try {
      renameSync(path, target);
      console.warn(`state: ${path} ${problem}; moved it to ${target} and starting empty`);
    } catch {
      copyFileSync(path, target);
      console.warn(`state: ${path} ${problem}; copied it to ${target} and starting empty`);
    }
  } catch (error) {
    console.warn(`state: ${path} ${problem} and could not be moved aside (${error instanceof Error ? error.message : String(error)}); starting empty`);
  }
  return undefined;
}

function keptName(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let name = `${path}.corrupt-${stamp}`;
  for (let n = 2; existsSync(name); n++) name = `${path}.corrupt-${stamp}-${n}`;
  return name;
}
