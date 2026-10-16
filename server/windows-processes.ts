/**
 * What runs under a pane's shell on Windows. herdr's pane.process_info names only the shell
 * there, even while a program runs in it (live-verified, herdr 0.9.3: gjc.exe was a child of
 * the pane's powershell.exe and not in foreground_processes), because Windows has no
 * foreground process group to ask. It does give `shell_pid`, and the bridge runs on that
 * PC, so the process table answers instead.
 */
export interface ProcessRow {
  pid: number; parent: number; path: string | null; commandLine: string | null;
  /** when the process started, in ms since 1970: Windows hands a finished process's number to the next one */
  started?: number;
}

/** A Windows command line as argv: double quotes group, nothing else is special here. */
export function windowsArgv(commandLine: string): string[] {
  const words: string[] = [];
  for (const match of commandLine.matchAll(/"([^"]*)"|(\S+)/g)) words.push(match[1] ?? match[2]!);
  return words;
}

/** Every process below `pid`, nearest first, by its number and its argv; the executable's full path stands for argv[0]. */
export function descendantProcesses(rows: readonly ProcessRow[], pid: number): { pid: number; argv: string[] }[] {
  const found: { pid: number; argv: string[] }[] = [];
  const seen = new Set<number>([pid]);
  let level = [pid];
  while (level.length > 0) {
    const next: number[] = [];
    for (const row of rows) {
      if (!level.includes(row.parent) || seen.has(row.pid)) continue;
      seen.add(row.pid);
      next.push(row.pid);
      const argv = windowsArgv(row.commandLine ?? "");
      found.push({ pid: row.pid, argv: row.path ? [row.path, ...argv.slice(1)] : argv });
    }
    level = next;
  }
  return found;
}

/** argv of every process below `pid`, nearest first. */
export function descendantArgv(rows: readonly ProcessRow[], pid: number): string[][] {
  return descendantProcesses(rows, pid).map((entry) => entry.argv);
}

export function parseProcessTable(json: string): ProcessRow[] {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return []; }
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const pid = row["ProcessId"], parent = row["ParentProcessId"];
    if (typeof pid !== "number" || typeof parent !== "number") return [];
    const started = row["Started"];
    return [{
      pid, parent, path: typeof row["ExecutablePath"] === "string" ? row["ExecutablePath"] : null, commandLine: typeof row["CommandLine"] === "string" ? row["CommandLine"] : null,
      ...(typeof started === "number" ? { started } : {}),
    }];
  });
}

/** The table as compact JSON: one PowerShell start per query, as windowsProcessTable's one-shot form runs it. */
const TABLE_QUERY = "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine, @{n='Started';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress";
const CONSOLE_UTF8 = "[Console]::OutputEncoding = [Text.Encoding]::UTF8";
const TABLE_SCRIPT = `${CONSOLE_UTF8}; ${TABLE_QUERY}`;
/** The worker's answer ends with this line, after the table's own JSON line. */
const TABLE_END_HEAD = "<<herdr-web-ui:";
const TABLE_END_TAIL = "table-end>>";
const TABLE_END = `${TABLE_END_HEAD}${TABLE_END_TAIL}`;
/**
 * The end line as a line of its own. The table can name the marker inside a row (the worker's own command
 * line is a row), so only a whole line ends an answer.
 */
const TABLE_END_LINE = new RegExp(`\\n${TABLE_END}\\r?\\n`);
/**
 * Answers one `table` line on stdin per query, and exits when stdin closes, so no worker outlives the server.
 * The end line is joined at run time: the worker's command line is a row of the table it answers, and a
 * whole marker in that command line would end the answer early.
 */
const WORKER_SCRIPT = `${CONSOLE_UTF8}; $end = '${TABLE_END_HEAD}' + '${TABLE_END_TAIL}'; while ($true) { $line = [Console]::In.ReadLine(); if ($line -eq $null) { break }; if ($line -ne 'table') { continue }; $json = ${TABLE_QUERY}; [Console]::Out.WriteLine($json); [Console]::Out.WriteLine($end); [Console]::Out.Flush() }`;
/** The command that starts the worker, as spawned. */
export const TABLE_WORKER_COMMAND = ["powershell", "-NoProfile", "-NonInteractive", "-Command", WORKER_SCRIPT];

/** The process table from a one-shot PowerShell query, or nothing when it cannot be read. A query that stalls is killed at `timeoutMs`. */
async function oneShotProcessTable(timeoutMs: number, command: string[] = ["powershell", "-NoProfile", "-NonInteractive", "-Command", TABLE_SCRIPT]): Promise<ProcessRow[]> {
  try {
    const probe = Bun.spawn(command, { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
    const [code, out] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
    return code === 0 ? parseProcessTable(out) : [];
  } catch { return []; }
}

/** A PowerShell child as the worker uses it: requests on stdin, answers on stdout. */
export interface TableWorkerProcess {
  stdin: { write(data: string): unknown; flush(): unknown };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<unknown>;
  kill(): void;
}

function spawnTableWorker(): TableWorkerProcess {
  const child = Bun.spawn(TABLE_WORKER_COMMAND, { windowsHide: true, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  // only the bridge's polls keep it: it must not hold the server's event loop open
  child.unref();
  return { stdin: child.stdin, stdout: child.stdout, exited: child.exited, kill: () => child.kill() };
}

/** A request the worker leaves unanswered this long, once it has answered before, has hung, and the worker is killed. A warm worker answers in about 0.1 s. */
const WORKER_ANSWER_MS = 4_000;
/** The first answer of a new worker: a cold PowerShell start takes about 1.5 s, and longer on a busy PC. */
const WORKER_START_MS = 15_000;
/** After the worker fails, no new one starts for this long; the one-shot query answers meanwhile. */
const WORKER_RETRY_MS = 30_000;

/**
 * One long-lived PowerShell that answers table reads. A one-shot query costs about 2.4 s of CPU
 * on a cold PowerShell and about 0.1 s in a warm one, so the periodic polls read through the worker.
 * Requests run one at a time; a worker that does not answer in time, or exits, is killed and not
 * started again for WORKER_RETRY_MS, so a broken PowerShell cannot be restarted on every poll.
 * dispose() ends it for good: no worker starts after it.
 */
export class ProcessTableWorker {
  private child: TableWorkerProcess | null = null;
  private output = "";
  private answer: ((text: string | null) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private retryAt = 0;
  /** the current worker has answered at least once; until then it is starting, and its first answer may take startMs */
  private answered = false;
  private disposed = false;

  constructor(
    private readonly spawn: () => TableWorkerProcess = spawnTableWorker,
    private readonly now: () => number = Date.now,
    private readonly answerMs: number = WORKER_ANSWER_MS,
    private readonly startMs: number = WORKER_START_MS,
  ) {}

  /**
   * The table from the worker, or null when no answer comes within `timeoutMs`. The budget only ends
   * the caller's wait: a request still in flight is answered, and the worker is killed only when it
   * stays silent for its answer limit, so a short budget never kills a cold start.
   */
  read(timeoutMs: number): Promise<ProcessRow[] | null> {
    let abandoned = false;
    const turn = this.queue.then(() => (abandoned ? null : this.ask()));
    this.queue = turn.catch(() => undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        abandoned = true;
        resolve(null);
      }, timeoutMs);
      turn.then(
        (rows) => {
          clearTimeout(timer);
          resolve(rows);
        },
        () => {
          clearTimeout(timer);
          resolve(null);
        },
      );
    });
  }

  /** Kills the worker now and starts none again; a request waiting on it gets null. */
  dispose(): void {
    this.disposed = true;
    const child = this.child;
    if (child) this.drop(child);
  }

  private async ask(): Promise<ProcessRow[] | null> {
    if (this.disposed || this.now() < this.retryAt) return null;
    const child = this.child ?? this.start();
    if (!child) return null;
    const body = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => this.drop(child), this.answered ? this.answerMs : this.startMs);
      this.answer = (text) => {
        clearTimeout(timer);
        resolve(text);
      };
      try {
        child.stdin.write("table\n");
        child.stdin.flush();
      } catch {
        this.drop(child);
      }
    });
    if (body === null) return null;
    const rows = parseProcessTable(body);
    if (rows.length === 0) {
      this.drop(child);
      return null;
    }
    return rows;
  }

  private start(): TableWorkerProcess | null {
    let child: TableWorkerProcess;
    try {
      child = this.spawn();
    } catch {
      this.retryAt = this.now() + WORKER_RETRY_MS;
      return null;
    }
    this.child = child;
    this.output = "";
    this.answered = false;
    void this.collect(child);
    void child.exited.then(() => this.lost(child), () => this.lost(child));
    return child;
  }

  /** Reads the worker's stdout: each answer ends at its end line, and goes to the request waiting for it. */
  private async collect(child: TableWorkerProcess): Promise<void> {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.child !== child) return;
        this.output += decoder.decode(value, { stream: true });
        for (let end = TABLE_END_LINE.exec(this.output); end; end = TABLE_END_LINE.exec(this.output)) {
          const body = this.output.slice(0, end.index);
          this.output = this.output.slice(end.index + end[0].length);
          this.answered = true;
          const answer = this.answer;
          this.answer = null;
          answer?.(body);
        }
      }
    } catch {
      /* a broken stdout ends the worker, as an exit does */
    }
    this.lost(child);
  }

  private lost(child: TableWorkerProcess): void {
    if (this.child === child) this.drop(child);
  }

  private drop(child: TableWorkerProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.output = "";
    this.retryAt = this.now() + WORKER_RETRY_MS;
    const answer = this.answer;
    this.answer = null;
    answer?.(null);
    try {
      child.kill();
    } catch {
      /* it has already exited */
    }
  }
}

const processTableWorker = new ProcessTableWorker();

/** Ends the PowerShell worker that answers table reads (called when the server stops). */
export function stopProcessTableWorker(): void {
  processTableWorker.dispose();
}

/**
 * The process table: from the worker when it answers within the wait the caller gives it (at most
 * WORKER_ANSWER_MS, so a one-shot query keeps the rest of `timeoutMs`), otherwise from a one-shot
 * query. Empty when neither can read it.
 */
export async function processTable(
  timeoutMs: number,
  { worker = processTableWorker, oneShot = (ms: number) => oneShotProcessTable(ms), workerMs = WORKER_ANSWER_MS }: { worker?: ProcessTableWorker; oneShot?: (timeoutMs: number) => Promise<ProcessRow[]>; workerMs?: number } = {},
): Promise<ProcessRow[]> {
  const deadline = Date.now() + timeoutMs;
  const rows = await worker.read(Math.min(timeoutMs, workerMs));
  if (rows !== null) return rows;
  const left = deadline - Date.now();
  return left > 0 ? oneShot(left) : [];
}

/**
 * The process table of this PC, or nothing when it cannot be read: one PowerShell query per call, cut off at
 * `timeoutMs`, so a caller with a deadline keeps it. A custom `command` runs in its place. One-off callers take
 * this, which leaves no PowerShell running; the periodic polls take polledProcessTable.
 */
export function windowsProcessTable(timeoutMs = 10_000, command?: string[]): Promise<ProcessRow[]> {
  return oneShotProcessTable(timeoutMs, command);
}

/**
 * The process table for a periodic poll: the long-lived worker answers it, and the one-shot query answers
 * when the worker does not answer in time.
 */
export function polledProcessTable(timeoutMs = 10_000): Promise<ProcessRow[]> {
  return processTable(timeoutMs);
}
