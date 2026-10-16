import { describe, expect, it } from "bun:test";
import { ProcessTableWorker, processTable, TABLE_WORKER_COMMAND, type ProcessRow, type TableWorkerProcess } from "./windows-processes.ts";

const END = "<<herdr-web-ui:table-end>>";

/** The worker's answer to one request: the table as one JSON line, then the end marker. */
const answer = (pids: number[]): string =>
  `${JSON.stringify(pids.map((pid) => ({ ProcessId: pid, ParentProcessId: 1, ExecutablePath: null, CommandLine: `tool ${pid}`, Started: pid })))}\r\n${END}\r\n`;

/** A PowerShell child whose stdout is fed by `respond`, called once per request line on stdin. */
class FakeChild implements TableWorkerProcess {
  readonly requests: string[] = [];
  killed = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private ended = false;
  private finish!: (code: number) => void;
  readonly exited = new Promise<number>((resolve) => {
    this.finish = resolve;
  });
  readonly stdout = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.controller = controller;
    },
  });
  readonly stdin = {
    write: (data: string): number => {
      this.requests.push(data);
      this.respond(this);
      return data.length;
    },
    flush: (): void => undefined,
  };

  constructor(private readonly respond: (child: FakeChild) => void = () => undefined) {}

  send(text: string): void {
    if (!this.ended) this.controller.enqueue(new TextEncoder().encode(text));
  }

  /** Ends as a crashed PowerShell does: its stdout closes and it exits. */
  crash(): void {
    if (this.ended) return;
    this.ended = true;
    this.controller.close();
    this.finish(1);
  }

  kill(): void {
    this.killed = true;
    this.crash();
  }
}

const pids = (rows: ProcessRow[] | null): number[] | null => rows?.map((row) => row.pid) ?? null;

/** Polls until `condition` holds, failing at a deadline rather than waiting a set time. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
}

describe("process table worker", () => {
  it("answers repeated reads from one PowerShell", async () => {
    const children: FakeChild[] = [];
    const worker = new ProcessTableWorker(() => {
      const child = new FakeChild((c) => c.send(answer([7, 8])));
      children.push(child);
      return child;
    });
    for (let read = 0; read < 3; read++) expect(pids(await worker.read(1000))).toEqual([7, 8]);
    expect(children).toHaveLength(1);
    expect(children[0]!.requests).toEqual(["table\n", "table\n", "table\n"]);
  });

  it("finds the end marker and the table when the answer arrives in pieces", async () => {
    const text = answer([3]);
    const worker = new ProcessTableWorker(() => new FakeChild((c) => {
      c.send(text.slice(0, 7));
      c.send(text.slice(7, 30));
      c.send(text.slice(30));
    }));
    expect(pids(await worker.read(1000))).toEqual([3]);
  });

  it("kills a worker that stays silent, and starts a new one only after the retry window", async () => {
    let clock = 0;
    const children: FakeChild[] = [];
    const worker = new ProcessTableWorker(() => {
      const child = new FakeChild(children.length === 0 ? () => undefined : (c) => c.send(answer([5])));
      children.push(child);
      return child;
    }, () => clock, 20, 20);
    expect(await worker.read(1000)).toBeNull();
    expect(children[0]!.killed).toBe(true);
    expect(await worker.read(1000)).toBeNull();
    expect(children).toHaveLength(1);
    clock = 30_000;
    expect(pids(await worker.read(1000))).toEqual([5]);
    expect(children).toHaveLength(2);
  });

  it("gives a caller's budget only its own wait: a cold start that answers late is not killed", async () => {
    const children: FakeChild[] = [];
    const worker = new ProcessTableWorker(() => {
      const child = new FakeChild((c) => {
        if (c.requests.length >= 2) c.send(answer([4]));
      });
      children.push(child);
      return child;
    }, Date.now, 5_000);
    expect(await worker.read(10)).toBeNull();
    expect(children[0]!.requests).toHaveLength(1);
    // the first request is answered after its caller has gone on without it
    children[0]!.send(answer([3]));
    expect(pids(await worker.read(1000))).toEqual([4]);
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(false);
  });

  it("kills the worker on dispose, and the request waiting on it gets null", async () => {
    const child = new FakeChild();
    const worker = new ProcessTableWorker(() => child);
    const pending = worker.read(1000);
    await until(() => child.requests.length === 1);
    worker.dispose();
    expect(await pending).toBeNull();
    expect(child.killed).toBe(true);
  });

  it("drops a worker whose answer holds no table", async () => {
    const child = new FakeChild((c) => c.send(`not a table\r\n${END}\r\n`));
    const worker = new ProcessTableWorker(() => child);
    expect(await worker.read(1000)).toBeNull();
    expect(child.killed).toBe(true);
  });

  it("drops a worker that exits while a request is waiting on it, and starts a new one after the retry window", async () => {
    let clock = 0;
    const children: FakeChild[] = [];
    const worker = new ProcessTableWorker(() => {
      const child = new FakeChild(children.length === 0 ? undefined : (c) => c.send(answer([6])));
      children.push(child);
      return child;
    }, () => clock);
    const pending = worker.read(1000);
    await until(() => children[0]?.requests.length === 1);
    children[0]!.crash();
    expect(await pending).toBeNull();
    expect(await worker.read(1000)).toBeNull();
    expect(children).toHaveLength(1);
    clock = 30_000;
    expect(pids(await worker.read(1000))).toEqual([6]);
    expect(children).toHaveLength(2);
  });

  it("does not retry a worker that cannot start until the retry window passes", async () => {
    let clock = 0;
    let spawns = 0;
    const worker = new ProcessTableWorker(() => {
      spawns++;
      if (spawns === 1) throw new Error("powershell is not installed");
      return new FakeChild((c) => c.send(answer([9])));
    }, () => clock);
    expect(await worker.read(1000)).toBeNull();
    expect(await worker.read(1000)).toBeNull();
    expect(spawns).toBe(1);
    clock = 30_000;
    expect(pids(await worker.read(1000))).toEqual([9]);
    expect(spawns).toBe(2);
  });

  it("answers from the worker without a one-shot query when it can", async () => {
    const worker = new ProcessTableWorker(() => new FakeChild((c) => c.send(answer([11]))));
    let oneShots = 0;
    const rows = await processTable(1000, {
      worker,
      oneShot: async () => {
        oneShots++;
        return [];
      },
    });
    expect(pids(rows)).toEqual([11]);
    expect(oneShots).toBe(0);
  });

  it("gives a new worker the start's time for its first answer, not the warm limit", async () => {
    const children: FakeChild[] = [];
    const worker = new ProcessTableWorker(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }, Date.now, 20, 5_000);
    const pending = worker.read(1000);
    await until(() => children[0]?.requests.length === 1);
    // silence past the warm limit: a cold start is still within its own
    const asked = Date.now();
    await until(() => Date.now() - asked >= 60);
    children[0]!.send(answer([13]));
    expect(pids(await pending)).toEqual([13]);
    expect(children[0]!.killed).toBe(false);
  });

  it("kills a warm worker that stays silent at its answer limit, not at the start's", async () => {
    const children: FakeChild[] = [];
    const worker = new ProcessTableWorker(() => {
      const child = new FakeChild((c) => {
        if (c.requests.length === 1) c.send(answer([14]));
      });
      children.push(child);
      return child;
    }, Date.now, 20, 5_000);
    expect(pids(await worker.read(1000))).toEqual([14]);
    expect(await worker.read(1000)).toBeNull();
    expect(children[0]!.killed).toBe(true);
  });

  it("starts no worker once disposed", async () => {
    let spawns = 0;
    const worker = new ProcessTableWorker(() => {
      spawns++;
      return new FakeChild((c) => c.send(answer([12])));
    }, () => 0);
    expect(pids(await worker.read(1000))).toEqual([12]);
    worker.dispose();
    expect(await worker.read(1000)).toBeNull();
    expect(spawns).toBe(1);
  });

  it("ends an answer only at the end marker's own line, not where a row names it", async () => {
    const row = { ProcessId: 21, ParentProcessId: 1, ExecutablePath: null, CommandLine: `powershell -Command "${END}"`, Started: 21 };
    const child = new FakeChild((c) => c.send(`${JSON.stringify([row])}\r\n${END}\r\n`));
    const worker = new ProcessTableWorker(() => child);
    expect(pids(await worker.read(1000))).toEqual([21]);
    expect(child.killed).toBe(false);
  });

  it("starts its worker with a command that names no whole end marker", () => {
    expect(TABLE_WORKER_COMMAND.join("\n")).not.toContain(END);
  });

  it("falls back to the one-shot query with the time left when the worker is slow", async () => {
    const worker = new ProcessTableWorker(() => new FakeChild(), () => 0, 10_000);
    const budgets: number[] = [];
    const rows = await processTable(60, {
      worker,
      workerMs: 20,
      oneShot: async (timeoutMs) => {
        budgets.push(timeoutMs);
        return [{ pid: 42, parent: 1, path: null, commandLine: "fallback", started: undefined }];
      },
    });
    expect(pids(rows)).toEqual([42]);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]!).toBeGreaterThan(0);
    expect(budgets[0]!).toBeLessThanOrEqual(60);
    worker.dispose();
  });
});
