import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { panePidsOf, PiSubagentStatus, piSubagentTasks, piSubagentsDir, readPiSubagentRecords, type RecordCache } from "./pi-subagents.ts";
import type { ProcessRow } from "./windows-processes.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-15T03:00:00.000Z");
/** The process that runs the pane started an hour before the subagents below. */
const PANE_STARTED = NOW - 3_600_000;

/** A state directory of its own: nothing here reads the real pi agent directory. */
function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-"));
  roots.push(root);
  const dir = join(root, "subagents-state");
  mkdirSync(dir);
  return dir;
}

/** A record as pi-subagents writes it (its AgentStateFile), prompt and paths included. */
function record(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: "implementer",
    description: `task ${id}`,
    prompt: "SECRET PROMPT with the parent context folded in",
    cwd: "C:/work",
    outputFile: "C:/work/out.txt",
    sessionDir: "C:/work/sessions",
    model: "anthropic/claude-haiku-5-5",
    startedAt: NOW - 60_000,
    pid: 100,
    status: "running",
    ...overrides,
  };
}

function write(dir: string, id: string, value: unknown): void {
  writeFileSync(join(dir, `${id}.json`), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function pane(id: string, agent: string | null): HerdrPane {
  return { pane_id: id, workspace_id: "w1", tab_id: "w1:t1", terminal_id: `${id}:term`, revision: 1, focused: false, agent_status: "idle", agent };
}

describe("pi subagents", () => {
  it("counts a pane's own running subagents: other panes', dead and finished ones stay out", () => {
    const dir = stateDir();
    write(dir, "mine", record("mine"));
    write(dir, "other-pane", record("other-pane", { pid: 200 }));
    write(dir, "dead", record("dead", { pid: 300 }));
    write(dir, "done", record("done", { status: "completed", completedAt: NOW - 1000 }));
    write(dir, "stopped", record("stopped", { status: "stopped" }));
    const tasks = piSubagentTasks(readPiSubagentRecords(dir, new Map()), new Map([[100, PANE_STARTED]]));
    expect(tasks.map((task) => task.id)).toEqual(["mine"]);
  });

  it("a pid another process held before this one started is not the pane's", () => {
    const dir = stateDir();
    write(dir, "earlier-holder", record("earlier-holder", { startedAt: PANE_STARTED - 60_000 }));
    write(dir, "tolerated", record("tolerated", { startedAt: PANE_STARTED - 2_000 }));
    write(dir, "own", record("own", { startedAt: PANE_STARTED + 5_000 }));
    const tasks = piSubagentTasks(readPiSubagentRecords(dir, new Map()), new Map([[100, PANE_STARTED]]));
    expect(tasks.map((task) => task.id)).toEqual(["tolerated", "own"]);
  });

  it("skips malformed records and things that are not files, and keeps the others", () => {
    const dir = stateDir();
    write(dir, "torn", "{\"id\": \"torn");
    write(dir, "array", "[]");
    write(dir, "no-start", record("no-start", { startedAt: undefined }));
    write(dir, "string-pid", record("string-pid", { pid: "100" }));
    write(dir, "zero-pid", record("zero-pid", { pid: 0 }));
    write(dir, "ok", record("ok"));
    writeFileSync(join(dir, "notes.txt"), "not a record");
    mkdirSync(join(dir, "folder.json"));
    const tasks = piSubagentTasks(readPiSubagentRecords(dir, new Map()), new Map([[100, PANE_STARTED]]));
    expect(tasks.map((task) => task.id)).toEqual(["ok"]);
  });

  it("never exposes a record's prompt, working directory or output file", () => {
    const dir = stateDir();
    write(dir, "mine", record("mine"));
    const [task] = piSubagentTasks(readPiSubagentRecords(dir, new Map()), new Map([[100, PANE_STARTED]]));
    expect(Object.keys(task!).sort()).toEqual(["category", "ended_at", "id", "model", "started_at", "status", "title", "tokens", "tool_calls", "turns"]);
    expect(task).toEqual({
      id: "mine",
      title: "task mine",
      category: "implementer",
      model: "anthropic/claude-haiku-5-5",
      status: "running",
      started_at: new Date(NOW - 60_000).toISOString(),
      ended_at: null,
      turns: null,
      tool_calls: null,
      tokens: null,
    });
    expect(JSON.stringify(task)).not.toContain("SECRET");
    expect(JSON.stringify(task)).not.toContain("C:/work");
  });

  it("reads nothing where there is no state directory, and reads a record again once it changes", () => {
    const dir = stateDir();
    const cache: RecordCache = new Map();
    expect(readPiSubagentRecords(join(dir, "missing"), cache)).toEqual([]);
    write(dir, "mine", record("mine"));
    expect(readPiSubagentRecords(dir, cache).map((entry) => entry.finished)).toEqual([false]);
    write(dir, "mine", record("mine", { status: "completed", completedAt: NOW }));
    expect(readPiSubagentRecords(dir, cache).map((entry) => entry.finished)).toEqual([true]);
    rmSync(join(dir, "mine.json"));
    expect(readPiSubagentRecords(dir, cache)).toEqual([]);
    expect(cache.size).toBe(0);
  });

  it("keeps pi's state directory under the agent directory it is given", () => {
    expect(piSubagentsDir("/home/x/.pi/agent")).toBe(join("/home/x/.pi/agent", "subagents-state"));
  });

  it("tells a pi pane's count as its subagents start and end, and identifies no other pane", async () => {
    const dir = stateDir();
    const told: [string, number][] = [];
    let lookups = 0;
    let now = NOW;
    const status = new PiSubagentStatus({
      dir,
      now: () => now,
      refreshMs: 5000,
      processes: async (paneId) => {
        lookups += 1;
        return paneId === "p1" ? new Map([[100, PANE_STARTED]]) : null;
      },
      onChange: (paneId, running) => told.push([paneId, running]),
    });
    await status.refresh([pane("p1", "pi"), pane("p2", "claude"), pane("p3", null)]);
    expect(lookups).toBe(1);
    expect(status.countOf("p1")).toBe(0);
    write(dir, "mine", record("mine"));
    status.poll();
    expect(status.countOf("p1")).toBe(1);
    expect(told).toEqual([["p1", 1]]);
    write(dir, "second", record("second", { startedAt: NOW - 30_000 }));
    status.poll();
    expect(told.at(-1)).toEqual(["p1", 2]);
    rmSync(join(dir, "mine.json"));
    status.poll();
    expect(told.at(-1)).toEqual(["p1", 1]);
    const count = told.length;
    status.poll();
    expect(told.length).toBe(count);
    await status.refresh([pane("p2", "claude")]);
    expect(told.at(-1)).toEqual(["p1", 0]);
    expect(status.countOf("p1")).toBe(0);
    now += 1;
    status.stop();
  });

  it("finds a pane's processes again only once they are due, and keeps them when a lookup cannot answer", async () => {
    const dir = stateDir();
    write(dir, "mine", record("mine"));
    let now = NOW;
    let answer: Map<number, number | null> | null = new Map([[100, PANE_STARTED]]);
    let lookups = 0;
    const told: number[] = [];
    const status = new PiSubagentStatus({
      dir,
      now: () => now,
      refreshMs: 1000,
      processes: async () => {
        lookups += 1;
        return answer;
      },
      onChange: (_paneId, running) => told.push(running),
    });
    await status.refresh([pane("p1", "pi")]);
    await status.refresh([pane("p1", "pi")]);
    expect(lookups).toBe(1);
    expect(status.countOf("p1")).toBe(1);
    answer = null;
    now += 1000;
    await status.refresh([pane("p1", "pi")]);
    expect(lookups).toBe(2);
    expect(status.countOf("p1")).toBe(1);
    expect(told).toEqual([1]);
    status.stop();
  });
});

describe("panePidsOf", () => {
  it("takes the foreground processes outside Windows", () => {
    expect(panePidsOf({ foreground_processes: [{ pid: 7 }, { pid: 8 }] }, null).sort((a, b) => a - b)).toEqual([7, 8]);
    expect(panePidsOf(undefined, null)).toEqual([]);
  });

  it("takes a Windows pane's shell and everything below it, and no other process", () => {
    const table: ProcessRow[] = [
      { pid: 10, parent: 1, path: "C:/pwsh.exe", commandLine: "pwsh" },
      { pid: 20, parent: 10, path: "C:/node.exe", commandLine: "node pi-coding-agent/cli.js" },
      { pid: 30, parent: 20, path: "C:/bash.exe", commandLine: "bash" },
      { pid: 40, parent: 1, path: "C:/other.exe", commandLine: "other" },
    ];
    expect(panePidsOf({ shell_pid: 10, foreground_processes: [{ pid: 50 }] }, table).sort((a, b) => a - b)).toEqual([10, 20, 30, 50]);
  });
});
