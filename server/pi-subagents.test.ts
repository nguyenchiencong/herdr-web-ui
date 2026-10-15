import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { FIRST_SCAN_BYTES, insideLogRoot, panePidsOf, PiSubagentStatus, piBackgroundLogDir, piBackgroundOutput, piEndedTasksOf, piSubagentTasks, piSubagentsDir, readPiSubagentRecords, type RecordCache } from "./pi-subagents.ts";
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

/** Whether this platform lets a test make a link: Windows needs developer mode or a privilege for one. */
const CAN_LINK = ((): boolean => {
  const root = mkdtempSync(join(tmpdir(), "pi-link-probe-"));
  try {
    writeFileSync(join(root, "target"), "");
    symlinkSync(join(root, "target"), join(root, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();

/** A pi session file and the background-job folder beside it, under a root of the test's own. */
function session(): { file: string; root: string; logs: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-ended-"));
  roots.push(root);
  const logs = join(root, "agent", "logs", "bg-tasks");
  mkdirSync(logs, { recursive: true });
  return { file: join(root, "session.jsonl"), root, logs };
}

const stamp = (ms: number): string => new Date(ms).toISOString();

/** A subagent's end record as pi writes it: its prompt and its result are in it, and the list leaves both out. */
function endRecord(id: string, ended: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "custom", customType: "subagents:record", id: `e-${id}`, parentId: null, timestamp: stamp(ended),
    data: { id, type: "reviewer", description: `review ${id}`, status: "completed", result: "SECRET RESULT", startedAt: ended - 61_000, completedAt: ended, toolUses: 6, durationMs: 61_000, tokens: 18_420, ...overrides },
  });
}

/** A background command's completion notice as pi-background-jobs writes it; its command is left out of the list. */
function commandNotice(logs: string, id: string, ended: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "custom_message", customType: "background-task-notification", id: `n-${id}`, parentId: null, timestamp: stamp(ended), display: true,
    content: "<background-task-notification>\nBackground command \"unit tests\" finished with exit code 0.\n</background-task-notification>",
    details: { id, name: "unit tests", command: "SECRET COMMAND", status: "completed", exitCode: 0, error: null, startTime: ended - 34_000, endTime: ended, outputPath: `.pi\\logs\\bg-tasks\\${id}.output`, logFile: join(logs, `${id}.output`), ...overrides },
  });
}

describe("a pi transcript's ended subagents and background commands", () => {
  it("lists the newest ten subagents and commands that ended in the last day, newest first, whichever kind", () => {
    const { file, logs } = session();
    const lines = Array.from({ length: 12 }, (_, index) => index % 2 === 0 ? endRecord(`sa_${index}`, NOW - index * 60_000) : commandNotice(logs, `bg_${index}`, NOW - index * 60_000));
    writeFileSync(file, lines.reverse().join("\n") + "\n");
    expect(piEndedTasksOf(file, logs, NOW).map((task) => task.id)).toEqual(["sa_0", "bg_1", "sa_2", "bg_3", "sa_4", "bg_5", "sa_6", "bg_7", "sa_8", "bg_9"]);
  });

  it("leaves out what ended more than a day before now", () => {
    const { file, logs } = session();
    writeFileSync(file, [endRecord("old", NOW - 25 * 3_600_000), endRecord("recent", NOW - 23 * 3_600_000)].join("\n") + "\n");
    expect(piEndedTasksOf(file, logs, NOW).map((task) => task.id)).toEqual(["recent"]);
  });

  it("maps a subagent's end record and a background command's notice to tasks of their own kinds", () => {
    const { file, logs } = session();
    const log = join(logs, "bg_2a9.output");
    writeFileSync(log, "1 failing\n");
    writeFileSync(file, [
      endRecord("sa_7f3c", NOW - 60_000, { status: "error", type: "reviewer", description: "Read retry code", toolUses: 6, tokens: 18_420 }),
      commandNotice(logs, "bg_2a9", NOW - 5_000, { status: "completed", exitCode: 1, startTime: NOW - 39_000, endTime: NOW - 5_000, logFile: log }),
    ].join("\n") + "\n");
    expect(piEndedTasksOf(file, logs, NOW)).toEqual([
      { id: "bg_2a9", title: "unit tests", category: "command", model: null, status: "failed", started_at: stamp(NOW - 39_000), ended_at: stamp(NOW - 5_000), turns: null, tool_calls: null, tokens: null, exit_code: 1, output: true },
      { id: "sa_7f3c", title: "Read retry code", category: "reviewer", model: null, status: "failed", started_at: stamp(NOW - 60_000 - 61_000), ended_at: stamp(NOW - 60_000), turns: null, tool_calls: 6, tokens: 18_420 },
    ]);
  });

  it("reads a stopped, aborted or steered subagent as cancelled, and an error as failed", () => {
    const { file, logs } = session();
    writeFileSync(file, ["stopped", "aborted", "steered", "error", "completed"].map((status, index) => endRecord(`sa_${status}`, NOW - index * 1000, { status })).join("\n") + "\n");
    expect(piEndedTasksOf(file, logs, NOW).map((task) => [task.id, task.status])).toEqual([
      ["sa_stopped", "cancelled"], ["sa_aborted", "cancelled"], ["sa_steered", "cancelled"], ["sa_error", "failed"], ["sa_completed", "completed"],
    ]);
  });

  it("keeps a subagent's result and a command's command out of the list", () => {
    const { file, logs } = session();
    writeFileSync(file, endRecord("sa_1", NOW) + "\n" + commandNotice(logs, "bg_1", NOW) + "\n");
    const json = JSON.stringify(piEndedTasksOf(file, logs, NOW));
    expect(json).not.toContain("SECRET RESULT");
    expect(json).not.toContain("SECRET COMMAND");
  });

  it("reads a transcript from where the last read stopped, leaves a line still being written for its end, and reads a rewritten file from its start", () => {
    const { file, logs } = session();
    const ids = () => piEndedTasksOf(file, logs, NOW).map((task) => task.id);
    writeFileSync(file, endRecord("sa_1", NOW - 60_000) + "\n");
    expect(ids()).toEqual(["sa_1"]);
    appendFileSync(file, endRecord("sa_2", NOW - 30_000) + "\n");
    expect(ids()).toEqual(["sa_2", "sa_1"]);
    const partial = endRecord("sa_3", NOW);
    appendFileSync(file, partial.slice(0, 40));
    expect(ids()).toEqual(["sa_2", "sa_1"]);
    appendFileSync(file, partial.slice(40) + "\n");
    expect(ids()).toEqual(["sa_3", "sa_2", "sa_1"]);
    writeFileSync(file, endRecord("sa_9", NOW) + "\n");
    expect(ids()).toEqual(["sa_9"]);
  });

  it("reads only a long transcript's end first, from a line's start, then what is appended", () => {
    const { file, logs } = session();
    const ids = () => piEndedTasksOf(file, logs, NOW).map((task) => task.id);
    // 1001-byte lines: the window's first byte falls inside one, which is skipped, not parsed from its middle
    const filler = JSON.stringify({ type: "message", text: "x".repeat(972) });
    const lines = (count: number) => Array.from({ length: count }, () => filler).join("\n");
    const pastWindow = Math.ceil(FIRST_SCAN_BYTES / (filler.length + 1)) + 10;
    writeFileSync(file, `${endRecord("sa_early", NOW - 60_000)}\n${lines(pastWindow)}\n${endRecord("sa_tail", NOW - 40_000)}\n${lines(10)}\n`);
    // the early end is in the last day, yet before the window: the first read never reaches it
    expect(ids()).toEqual(["sa_tail"]);
    appendFileSync(file, endRecord("sa_new", NOW - 1000) + "\n");
    expect(ids()).toEqual(["sa_new", "sa_tail"]);
  });

  it("names a log only inside pi's background-job folder: a path elsewhere, a traversal out of it and a relative path are refused", () => {
    const { file, root, logs } = session();
    const outside = join(root, "outside.output");
    writeFileSync(outside, "SECRET OUTSIDE\n");
    const inside = join(logs, "inside.output");
    writeFileSync(inside, "inside\n");
    const traversal = `${logs}${sep}..${sep}..${sep}..${sep}outside.output`;
    writeFileSync(file, [
      commandNotice(logs, "elsewhere", NOW, { logFile: outside }),
      commandNotice(logs, "traversal", NOW - 1000, { logFile: traversal }),
      commandNotice(logs, "absolute", NOW - 2000, { logFile: undefined, outputPath: outside }),
      commandNotice(logs, "relative", NOW - 3000, { logFile: undefined, outputPath: ".pi\\logs\\bg-tasks\\relative.output" }),
      commandNotice(logs, "inside", NOW - 4000, { logFile: inside }),
    ].join("\n") + "\n");
    const tasks = piEndedTasksOf(file, logs, NOW);
    expect(Object.fromEntries(tasks.map((task) => [task.id, task.output]))).toEqual({ elsewhere: false, traversal: false, absolute: false, relative: false, inside: true });
    for (const id of ["elsewhere", "traversal", "absolute", "relative"]) expect(piBackgroundOutput(file, id, logs)).toBeNull();
    expect(piBackgroundOutput(file, "inside", logs)).toEqual({ output: "inside\n", cut: false, size: 7 });
    expect(JSON.stringify(tasks)).not.toContain("SECRET OUTSIDE");
  });

  it("refuses a sibling folder that only shares the folder's name as a prefix", () => {
    const { logs } = session();
    const sibling = `${logs}-evil`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "x.output"), "SECRET\n");
    expect(insideLogRoot(join(sibling, "x.output"), logs)).toBeNull();
    expect(insideLogRoot(join(logs, "..", `${basename(logs)}-evil`, "x.output"), logs)).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("reads a log inside the folder whatever the case of its path on Windows, and refuses a junction out of it", () => {
    const { root, logs } = session();
    writeFileSync(join(logs, "ok.output"), "ok\n");
    expect(insideLogRoot(join(logs.toUpperCase(), "OK.OUTPUT"), logs)).not.toBeNull();
    const outside = join(root, "junction-target");
    mkdirSync(outside);
    writeFileSync(join(outside, "s.output"), "SECRET\n");
    symlinkSync(outside, join(logs, "junction"), "junction");
    expect(insideLogRoot(join(logs, "junction", "s.output"), logs)).toBeNull();
  });

  it("refuses the log folder itself and a folder inside it", () => {
    const { logs } = session();
    mkdirSync(join(logs, "sub"));
    expect(insideLogRoot(logs, logs)).toBeNull();
    expect(insideLogRoot(join(logs, "sub"), logs)).toBeNull();
  });

  it.skipIf(!CAN_LINK)("refuses a link inside the folder whose target lies outside it, even one made after the transcript was read", () => {
    const { file, root, logs } = session();
    const outside = join(root, "outside.output");
    writeFileSync(outside, "SECRET OUTSIDE\n");
    symlinkSync(outside, join(logs, "link.output"));
    writeFileSync(file, commandNotice(logs, "linked", NOW, { logFile: join(logs, "link.output") }) + "\n");
    expect(piEndedTasksOf(file, logs, NOW)[0]?.output).toBe(false);
    expect(piBackgroundOutput(file, "linked", logs)).toBeNull();
    const inner = join(logs, "inner.output");
    writeFileSync(inner, "inner\n");
    writeFileSync(file, commandNotice(logs, "later", NOW, { logFile: inner }) + "\n");
    expect(piBackgroundOutput(file, "later", logs)).toEqual({ output: "inner\n", cut: false, size: 6 });
    rmSync(inner);
    symlinkSync(outside, inner);
    expect(piBackgroundOutput(file, "later", logs)).toBeNull();
  });

  it("serves a short log whole, and a longer one's last 64 KB from a line's start, saying it was cut", () => {
    const { file, logs } = session();
    const short = join(logs, "short.output");
    writeFileSync(short, "first\nsecond\n");
    const long = join(logs, "long.output");
    const lines = Array.from({ length: 30_000 }, (_, index) => `line ${index}`);
    writeFileSync(long, lines.join("\n") + "\n");
    writeFileSync(file, [commandNotice(logs, "short", NOW, { logFile: short }), commandNotice(logs, "long", NOW - 1000, { logFile: long })].join("\n") + "\n");
    expect(piBackgroundOutput(file, "short", logs)).toEqual({ output: "first\nsecond\n", cut: false, size: 13 });
    const tail = piBackgroundOutput(file, "long", logs);
    expect(tail?.cut).toBe(true);
    expect(tail?.size).toBe(Buffer.byteLength(lines.join("\n") + "\n"));
    expect(Buffer.byteLength(tail?.output ?? "")).toBeLessThanOrEqual(64 * 1024);
    expect(tail?.output.startsWith("line ")).toBe(true);
    expect(tail?.output.endsWith("line 29999\n")).toBe(true);
  });

  it("names pi's background-job folder under the agent directory it is given", () => {
    expect(piBackgroundLogDir("/home/x/.pi/agent")).toBe(join("/home/x/.pi/agent", "logs", "bg-tasks"));
  });
});
