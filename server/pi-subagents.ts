import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrPane, OmoTask } from "../shared/protocol.ts";
import { recentProcessTable } from "./gjc-runtime.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { piAgentDir } from "./pi-models.ts";
import { processStartedAt } from "./process-start.ts";
import { descendantProcesses, type ProcessRow } from "./windows-processes.ts";

/**
 * The subagents a pi pane runs. pi-subagents keeps one record per live subagent in
 * `<pi agent dir>/subagents-state/<id>.json`: written at spawn with the pid of the pi process that
 * runs it, and deleted when it finishes; its status is written only then, so a running record may
 * still read `queued`. A record carries the subagent's prompt, which never leaves the server. A pane's subagents are the records of the pi
 * processes it runs: herdr's foreground processes, and on Windows what runs below its shell
 * (windows-processes.ts). A record written before its pid's process started was written by an
 * earlier process that held that pid, so it is not the pane's.
 */

/** As OmO's holder check (server/omo.ts) allows: a start time is floored to the second where `ps` reports it. */
const START_TOLERANCE_MS = 3000;
/** A record is read whole, prompt included, so only one past this bound is passed over. */
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
/** The statuses pi-subagents acknowledges as the end of a run (its agent-manager.ts). */
const FINISHED = new Set(["completed", "steered", "error", "aborted", "stopped"]);

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
