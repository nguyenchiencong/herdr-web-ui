import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { piBackgroundLogDir } from "./pi-subagents.ts";
import type { BackgroundOutput, OmoActivity } from "../shared/protocol.ts";
import { removeTempDir } from "../scripts/test-herdr.ts";

// A pi pane's background command is listed, and its output read, only through the log its own transcript
// names, and only when that log lies in pi's background-job folder. A path a request names is never read.
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-pi-background-"));
const agentDir = join(root, ".pi", "agent");
const sessionDir = join(agentDir, "sessions");
const logs = piBackgroundLogDir(agentDir);
const outside = join(root, "outside.output");
const slug = join(sessionDir, `--${root.replaceAll("/", "-")}--`);
const transcript = join(slug, "session.jsonl");
const fakePi = join(root, "bin", "pi");
// the pi pane needs a POSIX shell to stand in for pi; the endpoint's parameter checks run everywhere
const POSIX = process.platform !== "win32";
const workspaces: string[] = [];
let paneId: string;
let server: ReturnType<typeof createServer>;
// herdr keeps one session report per pane and refuses one older than the last.
let seq = Date.now() * 1000;
const nextSeq = () => ++seq;
const base = (): string => `http://127.0.0.1:${server.port}`;

const reportSession = (path: string, target = paneId) =>
  herdrRpc("pane.report_agent_session", { pane_id: target, source: "herdr:pi", agent: "pi", seq: nextSeq(), agent_session_path: path, session_start_source: "startup" });

// a session header of its own each write, so a rewritten transcript is never mistaken for the one read before
const page = (entries: unknown[]) => [
  { type: "session", version: 3, id: `session-${nextSeq()}`, timestamp: new Date().toISOString(), cwd: root },
  ...entries,
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";

/** A background command's completion notice as pi-background-jobs writes it: its details carry the log and the exit code. */
const notice = (id: string, ended: number, details: Record<string, unknown>) => ({
  type: "custom_message", customType: "background-task-notification", id: `n-${id}`, parentId: null, timestamp: new Date(ended).toISOString(), display: true,
  content: "<background-task-notification>\nBackground command \"unit tests\" finished with exit code 1.\n</background-task-notification>",
  details: { id, name: "unit tests", command: "SECRET COMMAND", status: "completed", exitCode: 1, error: null, startTime: ended - 34_000, endTime: ended, outputPath: `.pi\\logs\\bg-tasks\\${id}.output`, ...details },
});

async function createPiPane(): Promise<string> {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-pi-background" });
  workspaces.push(created.workspace.workspace_id);
  const target = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: target, text: `${fakePi}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === target);
    if (pane?.agent === "pi") break;
    if (Date.now() > deadline) throw new Error("test pi did not start");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: target, source: "herdr:pi", agent: "pi", state: "idle", seq: nextSeq() });
  return target;
}

beforeAll(() => {
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push"), piAgentDir: agentDir });
});

afterAll(async () => {
  server?.stop();
  for (const workspaceId of workspaces) await workspaceClose(workspaceId);
  delete process.env["PI_CODING_AGENT_SESSION_DIR"];
  await removeTempDir(root);
});

describe("the background-output endpoint's own checks", () => {
  it("refuses a request without its parameters, or with another method, as a bad request", async () => {
    const missing = await fetch(`${base()}/api/pane/background-output?pane_id=p1`);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "missing_parameter" } });
    const posted = await fetch(`${base()}/api/pane/background-output?pane_id=p1&task_id=bg_1`, { method: "POST" });
    expect(posted.status).toBe(400);
  });

  it("answers output_not_found for a pane that names no pi transcript", async () => {
    const response = await fetch(`${base()}/api/pane/background-output?pane_id=no-such-pane&task_id=bg_1`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "output_not_found" } });
  });
});

describe.skipIf(!POSIX)("a pi pane's background commands", () => {
  beforeAll(async () => {
    process.env["PI_CODING_AGENT_SESSION_DIR"] = sessionDir;
    mkdirSync(slug, { recursive: true });
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(fakePi, "#!/bin/sh\nsleep 600\n");
    chmodSync(fakePi, 0o755);
    paneId = await createPiPane();
    await reportSession(transcript);
  });

  it("lists a command its transcript ended, and serves its log's end only when the log lies in pi's background-job folder", async () => {
    const now = Date.now();
    mkdirSync(join(logs, "run-1"), { recursive: true });
    const ok = join(logs, "run-1", "bg_ok.output");
    writeFileSync(ok, "start\n" + Array.from({ length: 20_000 }, (_, index) => `line ${index}`).join("\n") + "\nTAIL MARK\n");
    writeFileSync(outside, "OUTSIDE MARK\n");
    const traversal = `${logs}${sep}..${sep}..${sep}..${sep}outside.output`;
    writeFileSync(transcript, page([
      notice("bg_ok", now - 60_000, { logFile: ok }),
      notice("bg_outside", now - 120_000, { logFile: outside }),
      notice("bg_traversal", now - 180_000, { logFile: traversal }),
      notice("bg_absolute", now - 240_000, { logFile: undefined, outputPath: outside }),
      notice("bg_relative", now - 300_000, { logFile: undefined, outputPath: ".pi\\logs\\bg-tasks\\bg_relative.output" }),
    ]));
    const activity = await (await fetch(`${base()}/api/pane/omo-tasks?pane_id=${encodeURIComponent(paneId)}`)).json() as OmoActivity;
    expect(Object.fromEntries(activity.tasks.map((task) => [task.id, task.output]))).toEqual({ bg_ok: true, bg_outside: false, bg_traversal: false, bg_absolute: false, bg_relative: false });
    expect(activity.tasks.find((task) => task.id === "bg_ok")).toMatchObject({ category: "command", status: "failed", exit_code: 1 });
    expect(JSON.stringify(activity)).not.toContain("SECRET COMMAND");

    const served = await fetch(`${base()}/api/pane/background-output?pane_id=${encodeURIComponent(paneId)}&task_id=bg_ok`);
    expect(served.status).toBe(200);
    const body = await served.json() as BackgroundOutput;
    expect(body.cut).toBe(true);
    expect(body.output.endsWith("TAIL MARK\n")).toBe(true);
    expect(body.output.includes("start\n")).toBe(false);
    expect(body.size).toBeGreaterThan(64 * 1024);

    for (const id of ["bg_outside", "bg_traversal", "bg_absolute", "bg_relative", "bg_missing"]) {
      const refused = await fetch(`${base()}/api/pane/background-output?pane_id=${encodeURIComponent(paneId)}&task_id=${id}`);
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ error: { code: "output_not_found" } });
    }
  });

  it("refuses a link inside the folder whose target lies outside it", async () => {
    const link = join(logs, "link.output");
    symlinkSync(outside, link);
    writeFileSync(transcript, page([notice("bg_link", Date.now() - 1_000, { logFile: link })]));
    const refused = await fetch(`${base()}/api/pane/background-output?pane_id=${encodeURIComponent(paneId)}&task_id=bg_link`);
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain("OUTSIDE MARK");
  });
});
