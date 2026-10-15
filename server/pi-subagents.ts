import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { BackgroundOutput, HerdrPane, OmoTask } from "../shared/protocol.ts";
import { recentProcessTable } from "./gjc-runtime.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { piAgentDir } from "./pi-models.ts";
import { processStartedAt } from "./process-start.ts";
import { piCustomMessage } from "./transcript-records.ts";
import { descendantProcesses, type ProcessRow } from "./windows-processes.ts";

/**
 * The subagents a pi pane runs. pi-subagents keeps one record per live subagent in
 * `<pi agent dir>/subagents-state/<id>.json`: written at spawn with the pid of the pi process that
 * runs it, and deleted when it finishes; its status is written only then, so a running record may
 * still read `queued`. A record carries the subagent's prompt, which never leaves the server. A pane's subagents are the records of the pi
 * processes it runs: herdr's foreground processes, and on Windows what runs below its shell
 * (windows-processes.ts). A record written before its pid's process started was written by an
 * earlier process that held that pid, so it is not the pane's.
 *
 * A pane's ended subagents and background commands (`bg_run`) are read from its transcript instead:
 * pi writes a `subagents:record` when a subagent ends and a background-task notice when a command does,
 * and the state directory holds neither. The transcript is read from where the last read stopped, and a
 * background command's log is served only from pi's background-job folder (piBackgroundOutput).
 */

/** As OmO's holder check (server/omo.ts) allows: a start time is floored to the second where `ps` reports it. */
const START_TOLERANCE_MS = 3000;
/** A record is read whole, prompt included, so only one past this bound is passed over. */
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
/** The statuses pi-subagents acknowledges as the end of a run (its agent-manager.ts). */
const FINISHED = new Set(["completed", "steered", "error", "aborted", "stopped"]);
/** The ended tasks the list keeps: the newest ten that ended in the last day, as Claude's list keeps them (claude-subagents.ts). */
const RECENT_LIMIT = 10;
const RECENT_MS = 24 * 60 * 60 * 1000;
/** The end of a background command's log the output endpoint reads, in bytes. */
export const BACKGROUND_OUTPUT_BYTES = 64 * 1024;
/** A transcript is read in pieces this big, so a long session is never held whole in memory. */
const READ_CHUNK_BYTES = 1024 * 1024;
/**
 * How far back from its end a transcript's first read starts. The list keeps ten ends of the last day, which a
 * session writes far inside this; a 100 MB session is not read whole, and blocking, on the first ask.
 */
export const FIRST_SCAN_BYTES = 4 * 1024 * 1024;
/** The first bytes of a transcript, which name it: a file that no longer starts with them was rewritten, and is read again. */
const HEAD_BYTES = 512;
/** How many transcripts keep their reads at once. */
const MAX_SCANS = 16;
/** pi-subagents' finished statuses as the list reads them: an error failed, a stop or an abort was cancelled. */
const SUBAGENT_ENDS = new Map<string, OmoTask["status"]>([["completed", "completed"], ["error", "failed"], ["aborted", "cancelled"], ["stopped", "cancelled"], ["steered", "cancelled"]]);

export interface PiSubagentRecord {
  id: string;
  type: string | null;
  description: string | null;
  model: string | null;
  pid: number;
  startedAt: number;
  finished: boolean;
}

/** Records already read, by path: a file is read again only when its size or time changed. */
export type RecordCache = Map<string, { key: string; record: PiSubagentRecord | null }>;

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;

/** `<pi agent dir>/subagents-state`, where pi-subagents keeps its records. */
export const piSubagentsDir = (agentDir: string = piAgentDir()): string => join(agentDir, "subagents-state");

function parseRecord(value: unknown): PiSubagentRecord | null {
  const record = row(value);
  if (record === null) return null;
  const id = text(record["id"]);
  const pid = record["pid"];
  const startedAt = record["startedAt"];
  if (id === null || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "number" || Number.isNaN(new Date(startedAt).getTime())) return null;
  const status = text(record["status"]);
  return {
    id,
    type: text(record["type"]),
    description: text(record["description"]),
    model: text(record["model"]),
    pid,
    startedAt,
    finished: typeof record["completedAt"] === "number" || (status !== null && FINISHED.has(status)),
  };
}

/**
 * Every record in `dir` that parses. A file is read again only where its size or time changed; one
 * that cannot be read now keeps the record it had, and one that is not a record is not read again
 * until it changes. Only plain files are read (not a link, not a folder).
 */
export function readPiSubagentRecords(dir: string, cache: RecordCache): PiSubagentRecord[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { cache.clear(); return []; }
  const records: PiSubagentRecord[] = [];
  const present = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let key: string;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) continue;
      key = `${stat.mtimeMs}:${stat.size}`;
    } catch { continue; }
    present.add(path);
    let cached = cache.get(path);
    if (cached?.key !== key) {
      let raw: string | null = null;
      try { raw = readFileSync(path, "utf8"); } catch { /* being written: the record it had stands */ }
      if (raw !== null) {
        let value: unknown;
        try { value = JSON.parse(raw); } catch { value = undefined; }
        cached = { key, record: parseRecord(value) };
        cache.set(path, cached);
      }
    }
    if (cached !== undefined && cached.record !== null) records.push(cached.record);
  }
  for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);
  return records;
}

/** Written by a process that started at `started` (or of unknown start): not before it, within the tolerance. */
const writtenBy = (record: PiSubagentRecord, started: number | null): boolean =>
  started === null || record.startedAt >= started - START_TOLERANCE_MS;

/**
 * The running subagents of a pane, oldest first, as the list shows them: `processes` are the pane's
 * processes by pid, with when each started (null where unknown). A finished record is not running,
 * and the prompt is left out: a task has the subagent's description, type and model only.
 */
export function piSubagentTasks(records: readonly PiSubagentRecord[], processes: ReadonlyMap<number, number | null>): OmoTask[] {
  return records
    .filter((record) => !record.finished && processes.has(record.pid) && writtenBy(record, processes.get(record.pid) ?? null))
    .sort((left, right) => left.startedAt - right.startedAt)
    .map((record): OmoTask => ({
      id: record.id,
      title: record.description ?? record.type ?? record.id,
      category: record.type,
      model: record.model,
      status: "running",
      started_at: new Date(record.startedAt).toISOString(),
      ended_at: null,
      turns: null,
      tool_calls: null,
      tokens: null,
    }));
}

/**
 * The pids of a pane's processes: herdr's foreground processes, and on Windows (the process table
 * given) its shell and everything below it, since herdr names only the shell there.
 */
export function panePidsOf(info: { shell_pid?: number | null; foreground_processes?: readonly { pid: number }[] } | null | undefined, table: readonly ProcessRow[] | null): number[] {
  const pids = new Set<number>();
  for (const process of info?.foreground_processes ?? []) pids.add(process.pid);
  const shell = info?.shell_pid;
  if (table !== null && typeof shell === "number") {
    pids.add(shell);
    for (const { pid } of descendantProcesses(table, shell)) pids.add(pid);
  }
  return [...pids];
}

const startsOf = (pids: readonly number[], startOf: (pid: number) => number | null): Map<number, number | null> =>
  new Map(pids.map((pid) => [pid, startOf(pid)] as const));

/**
 * The processes a pane runs, by pid, with when each started (null where the PC does not say). Null
 * when herdr, or on Windows the process table, could not answer: that says nothing about the pane.
 */
export async function panePiProcesses(paneId: string): Promise<Map<number, number | null> | null> {
  const info = await paneProcessInfo(paneId).catch(() => null);
  if (info === null) return null;
  if (process.platform !== "win32") return startsOf(panePidsOf(info, null), processStartedAt);
  const table = await recentProcessTable();
  if (table.length === 0) return null;
  const started = new Map(table.map((entry) => [entry.pid, entry.started ?? null] as const));
  return startsOf(panePidsOf(info, table), (pid) => started.get(pid) ?? null);
}

/** A pi pane's running subagents now, read from the state directory `dir`. */
export async function piSubagentsOf(paneId: string, dir: string, cache: RecordCache): Promise<OmoTask[]> {
  const processes = await panePiProcesses(paneId);
  return processes === null ? [] : piSubagentTasks(readPiSubagentRecords(dir, cache), processes);
}

export interface PiSubagentDeps {
  /** pi's state directory (`piSubagentsDir()`) */
  dir: string;
  /** a pane's processes now (`panePiProcesses`) */
  processes: (paneId: string) => Promise<Map<number, number | null> | null>;
  /** a pane's running subagents changed: told with the new count */
  onChange: (paneId: string, running: number) => void;
  pollMs?: number;
  refreshMs?: number;
  now?: () => number;
}

interface TrackedPane { processes: Map<number, number | null> | null; at: number; running: number }

/**
 * The running subagents of every pi pane. Each snapshot names the panes (`refresh`): a pane's
 * processes are found again once `refreshMs` old, and a pane that is no longer pi is dropped. While
 * a pi pane is tracked, the state directory is read every `pollMs`, and a count that changed is told.
 * With no pi pane, nothing is read.
 */
export class PiSubagentStatus {
  private readonly panes = new Map<string, TrackedPane>();
  private readonly cache: RecordCache = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly refreshMs: number;

  constructor(private readonly deps: PiSubagentDeps) {
    this.now = deps.now ?? Date.now;
    this.refreshMs = deps.refreshMs ?? 5000;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.panes.clear();
    this.cache.clear();
  }

  countOf(paneId: string): number {
    return this.panes.get(paneId)?.running ?? 0;
  }

  /** The snapshot's panes: the pi ones are tracked, and a pane that is no longer pi is dropped (its count goes to 0 once). */
  async refresh(panes: readonly HerdrPane[]): Promise<void> {
    const pi = new Set(panes.filter((pane) => pane.agent === "pi").map((pane) => pane.pane_id));
    for (const [paneId, tracked] of this.panes) {
      if (pi.has(paneId)) continue;
      this.panes.delete(paneId);
      if (tracked.running > 0) this.deps.onChange(paneId, 0);
    }
    await Promise.all([...pi].map((paneId) => this.identify(paneId)));
    this.poll();
  }

  private async identify(paneId: string): Promise<void> {
    let tracked = this.panes.get(paneId);
    if (tracked === undefined) this.panes.set(paneId, tracked = { processes: null, at: -Infinity, running: 0 });
    if (this.now() - tracked.at < this.refreshMs) return;
    tracked.at = this.now();
    const processes = await this.deps.processes(paneId).catch(() => null);
    // unknown this time: the processes the pane had stand
    if (processes !== null) tracked.processes = processes;
  }

  poll(): void {
    let records: PiSubagentRecord[] | null = null;
    for (const [paneId, tracked] of this.panes) {
      records ??= readPiSubagentRecords(this.deps.dir, this.cache);
      const running = tracked.processes === null ? 0 : piSubagentTasks(records, tracked.processes).length;
      if (running === tracked.running) continue;
      tracked.running = running;
      this.deps.onChange(paneId, running);
    }
  }
}

/** A subagent's or background command's end, as the transcript keeps it. */
interface EndedEntry {
  task: OmoTask;
  endedAt: number;
  /** a background command's log, when pi names one inside its log folder */
  log: string | null;
}

/** A transcript as read so far: how far the read reached, the head that names the file, and what it ended, by key. */
interface TranscriptScan {
  offset: number;
  head: Buffer;
  entries: Map<string, EndedEntry>;
}

const scans = new Map<string, TranscriptScan>();
/** The words a line that ends a task holds, matched in its bytes before it is decoded. */
const SUBAGENT_RECORD = Buffer.from("subagents:record");
const COMMAND_NOTICE = Buffer.from("background-task-notification");

const at = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const pathOf = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/** pi-background-jobs' folder for each background command's log and metadata, under the pi agent directory. */
export const piBackgroundLogDir = (agentDir: string = piAgentDir()): string => join(agentDir, "logs", "bg-tasks");

/**
 * The real path of `file` when it is a regular file inside `root`, else null. A path elsewhere, a traversal out of
 * the folder and a link whose target lies outside it are refused: both paths are resolved before they are compared.
 */
export function insideLogRoot(file: string, root: string): string | null {
  if (!isAbsolute(file)) return null;
  let base: string;
  let target: string;
  try {
    base = realpathSync(root);
    target = realpathSync(file);
  } catch { return null; }
  const inside = relative(base, target);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  try { return statSync(target).isFile() ? target : null; } catch { return null; }
}

/** The subagents and background commands a pi transcript records as ended in the last day: the newest ten, newest first. */
export function piEndedTasksOf(file: string, root: string, now = Date.now()): OmoTask[] {
  return [...scanEntries(file, root).values()]
    .filter((entry) => now - entry.endedAt <= RECENT_MS)
    .sort((left, right) => right.endedAt - left.endedAt)
    .slice(0, RECENT_LIMIT)
    .map((entry) => entry.task);
}

/**
 * The end of a background command's log, for GET /api/pane/background-output: null unless the transcript ended that
 * task with its log inside the log folder. The log is checked again now, as a link may have been made since the read.
 */
export function piBackgroundOutput(file: string, taskId: string, root: string): BackgroundOutput | null {
  const log = scanEntries(file, root).get(`command:${taskId}`)?.log ?? null;
  const inside = log === null ? null : insideLogRoot(log, root);
  if (inside === null) return null;
  try { return readLogTail(inside, root); } catch { return null; }
}

/** The ended tasks a transcript holds, by key; none when it cannot be read. */
function scanEntries(file: string, root: string): Map<string, EndedEntry> {
  try { return scanOf(file, root).entries; } catch { return new Map(); }
}

/**
 * A transcript's scan, brought up to its end: the first read takes the last FIRST_SCAN_BYTES only, then only what
 * was appended since the last read is read, and a file that shrank or whose head changed was rewritten, so it is
 * read again as a first read.
 */
function scanOf(file: string, root: string): TranscriptScan {
  const key = `${root}\n${file}`;
  const size = statSync(file).size;
  const head = headOf(file);
  let scan = scans.get(key);
  if (scan === undefined || size < scan.offset || !head.subarray(0, scan.head.length).equals(scan.head)) {
    if (scans.size >= MAX_SCANS) scans.delete(scans.keys().next().value!);
    // the first read takes the end only, from the first line that starts inside it
    scans.set(key, scan = { offset: size > FIRST_SCAN_BYTES ? lineStartFrom(file, size - FIRST_SCAN_BYTES, size) : 0, head, entries: new Map() });
  }
  if (scan.head.length < head.length) scan.head = head;
  if (size > scan.offset) {
    const { entries } = scan;
    scan.offset = eachLine(file, scan.offset, size, (line) => {
      // most lines are tool calls and answers: only one that names an end is decoded and parsed
      if (!line.includes(SUBAGENT_RECORD) && !line.includes(COMMAND_NOTICE)) return;
      const found = endedOf(line.toString("utf8"), root);
      if (found !== null) entries.set(found.key, found.entry);
    });
  }
  return scan;
}

/** The first bytes of a file. */
function headOf(file: string): Buffer {
  const fd = openSync(file, "r");
  try {
    const bytes = Buffer.alloc(HEAD_BYTES);
    return bytes.subarray(0, readSync(fd, bytes, 0, HEAD_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

/** The offset of the first line that starts at or after byte `from` (a line starts after a newline); `to` when none does before it. */
function lineStartFrom(file: string, from: number, to: number): number {
  if (from <= 0) return 0;
  const fd = openSync(file, "r");
  try {
    const chunk = Buffer.alloc(64 * 1024);
    // the byte before `from` says whether a line starts right at it
    for (let read = from - 1; read < to;) {
      const size = readSync(fd, chunk, 0, Math.min(chunk.length, to - read), read);
      if (size === 0) break;
      const newline = chunk.subarray(0, size).indexOf(0x0a);
      if (newline !== -1) return read + newline + 1;
      read += size;
    }
    return to;
  } finally {
    closeSync(fd);
  }
}

/**
 * Each complete line of `file` from byte `from` to byte `to`, in order; returns the offset after the last one, so a
 * line still being written is read again once it ends.
 */
function eachLine(file: string, from: number, to: number, each: (line: Buffer) => void): number {
  const fd = openSync(file, "r");
  try {
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let read = from;
    let done = from;
    while (read < to) {
      const size = readSync(fd, chunk, 0, Math.min(chunk.length, to - read), read);
      if (size === 0) break;
      read += size;
      pending = Buffer.concat([pending, chunk.subarray(0, size)]);
      let start = 0;
      for (let end = pending.indexOf(0x0a, start); end !== -1; end = pending.indexOf(0x0a, start)) {
        each(pending.subarray(start, end));
        start = end + 1;
      }
      pending = pending.subarray(start);
      done += start;
    }
    return done;
  } finally {
    closeSync(fd);
  }
}

/** The ended task one transcript line records: a subagent's end record, or a background command's notice. Null for any other line. */
function endedOf(line: string, root: string): { key: string; entry: EndedEntry } | null {
  if (!line.includes("subagents:record") && !line.includes("background-task-notification")) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  const entry = row(value);
  if (entry === null) return null;
  if (entry["type"] === "custom" && entry["customType"] === "subagents:record") return subagentEnded(row(entry["data"]), at(entry["timestamp"]));
  if (entry["type"] === "custom_message" && entry["customType"] === "background-task-notification") return commandEnded(entry, root);
  return null;
}

/** A subagent's end record: its numbers and when it ended. The prompt and the result are left out. */
function subagentEnded(data: Row | null, timestamp: number | null): { key: string; entry: EndedEntry } | null {
  if (data === null) return null;
  const id = text(data["id"]);
  const state = data["status"];
  const status = typeof state === "string" ? SUBAGENT_ENDS.get(state) : undefined;
  const ended = at(data["completedAt"]) ?? timestamp;
  if (id === null || status === undefined || ended === null) return null;
  const duration = count(data["durationMs"]);
  const started = at(data["startedAt"]) ?? (duration === null ? null : ended - duration);
  return {
    key: `subagent:${id}`,
    entry: {
      task: {
        id,
        title: text(data["description"]) ?? text(data["type"]) ?? id,
        category: text(data["type"]),
        model: null,
        status,
        started_at: iso(started),
        ended_at: iso(ended),
        turns: null,
        tool_calls: count(data["toolUses"]),
        tokens: count(data["tokens"]),
      },
      endedAt: ended,
      log: null,
    },
  };
}

/** A background command's completion, classified by pi's own card (piCustomMessage), with its exit code and the log its details name. */
function commandEnded(entry: Row, root: string): { key: string; entry: EndedEntry } | null {
  const card = piCustomMessage(entry, { afterPrompt: false, agentType: () => null });
  const found = card?.kind === "task_result" ? card.tasks[0] : undefined;
  const details: Row = row(entry["details"]) ?? {};
  const ended = at(details["endTime"]) ?? at(entry["timestamp"]);
  if (found === undefined || ended === null) return null;
  const started = at(details["startTime"]) ?? (found.duration_ms === null ? null : ended - found.duration_ms);
  const exit = details["exitCode"];
  const log = logOf(details, root);
  return {
    key: `command:${found.id}`,
    entry: {
      task: {
        id: found.id,
        title: found.title,
        category: "command",
        model: null,
        status: found.status,
        started_at: iso(started),
        ended_at: iso(ended),
        turns: null,
        tool_calls: null,
        tokens: null,
        exit_code: typeof exit === "number" ? exit : null,
        output: log !== null,
      },
      endedAt: ended,
      log,
    },
  };
}

/** The log a background command's notice names: its absolute `logFile` (else `outputPath`), when it lies inside the log folder. */
function logOf(details: Row, root: string): string | null {
  const named = pathOf(details["logFile"]) ?? pathOf(details["outputPath"]);
  return named === null ? null : insideLogRoot(named, root);
}

/**
 * The last BACKGROUND_OUTPUT_BYTES of a log, from the start of a line once the file is longer. It is read through a
 * descriptor that refuses a link as its last part, and only when the file it opened is still the one inside `root`:
 * Windows has no O_NOFOLLOW, so a folder swapped for a junction between the check and the open is caught here.
 */
function readLogTail(log: string, root: string): BackgroundOutput | null {
  const fd = openSync(log, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const inside = insideLogRoot(log, root);
    const checked = inside === null ? null : statSync(inside);
    if (checked === null || checked.ino !== stat.ino || checked.dev !== stat.dev) return null;
    const start = Math.max(0, stat.size - BACKGROUND_OUTPUT_BYTES);
    const bytes = Buffer.alloc(stat.size - start);
    let filled = 0;
    while (filled < bytes.length) {
      const got = readSync(fd, bytes, filled, bytes.length - filled, start + filled);
      if (got === 0) break;
      filled += got;
    }
    const kept = bytes.subarray(0, filled);
    const cut = start > 0;
    return { output: kept.toString("utf8", cut ? kept.indexOf(0x0a) + 1 : 0), cut, size: stat.size };
  } finally {
    closeSync(fd);
  }
}
