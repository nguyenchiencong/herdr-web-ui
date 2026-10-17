import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { agentGet, herdrSocketPath, paneGet, paneRead, paneSendKeys, paneSendText, socketAddress, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { shellCommandLine } from "./shell-agent.ts";
import { removeTempDir } from "../scripts/test-herdr.ts";

/**
 * Contract test for a pi session the sleep launcher holds in its pane (pi-launcher-hibernate.mjs),
 * against the real herdr. The launcher and the pi it resumes are node stand-ins: the launcher draws
 * the banner, sets the `zz` title, writes the sleep record atomically, and logs every chunk it reads;
 * the pi stand-in logs every chunk it reads and reports itself to herdr the way pi's extension does at
 * session start (`report_agent_session` with the session's path, then `report_agent`), or stays silent,
 * reports another session, or reports late. What is under test is the server's wake path: which bytes
 * reach the launcher, when the message is typed, and what is refused.
 */

const LAUNCHER = `
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
// the rename the real launcher retries (renameWithRetry in pi-launcher-hibernate.mjs): Windows refuses to replace a file a reader still holds
const renameWithRetry = (from, to) => {
  for (let attempt = 1; ; attempt++) {
    try { renameSync(from, to); return; } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 8) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * attempt);
    }
  }
};
const [socket, agentDir, sessionFile, sessionId, launcherLog, piLog, mode, draft, piBin, prereport, labelled] = process.argv.slice(2);
const paneId = process.env.HERDR_PANE_ID ?? "";
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socket);
    let text = "";
    sock.on("connect", () => sock.write(JSON.stringify({ id: "launcher-" + Date.now(), method, params }) + "\\n"));
    sock.on("data", (chunk) => { text += chunk.toString("utf8"); if (text.includes("\\n")) { sock.destroy(); resolve(text); } });
    sock.on("error", reject);
    sock.on("end", () => resolve(text));
  });
}
const recordPath = join(agentDir, "state", "hibernate", sessionId + ".json");
// the sleep's start, as pi-hibernate stamps it before pi exits: the age bound (SLEEP_TITLE_WAIT_MS) reads it
const sleptAt = new Date().toISOString();
function writeRecord(state, extra = {}) {
  const value = { version: 1, state, sessionId, sessionFile, cwd: "/tmp/app", title: sessionId, nonce: "nonce-" + sessionId, launcherPid: process.pid, childPid: null, nextDueAt: null, draft, sleptAt, reason: "idle", paneId, wake: null, ...extra };
  const tmp = recordPath + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\\n");
  renameWithRetry(tmp, recordPath);
}
const setTitle = (title) => rpc("pane.report_metadata", { pane_id: paneId, source: "pi", title });
const clearTitle = () => rpc("pane.report_metadata", { pane_id: paneId, source: "pi", clear_title: true });
const log = (data) => appendFileSync(launcherLog, JSON.stringify({ at: Date.now(), data }) + "\\n");
mkdirSync(dirname(recordPath), { recursive: true });
// a pi that reported itself before it slept: herdr's agent state then holds its session and an idle status
if (prereport === "1") {
  await rpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:pi", agent: "pi", seq: Date.now(), session_start_source: "startup", agent_session_path: sessionFile });
  await rpc("pane.report_agent", { pane_id: paneId, source: "herdr:pi", agent: "pi", state: "idle", seq: Date.now() + 1, agent_session_path: sessionFile });
}
writeRecord("sleeping");
if (mode !== "untitled") await setTitle("zz " + sessionId);
if (mode !== "nobanner" && mode !== "untitled") process.stdout.write("\\u001b[?2004l\\u001b[0m" + "zz " + sessionId + " \\u00b7 /tmp/app \\u2014 Enter to resume, q to quit" + "\\r\\n");
// output below the banner: the banner is then no longer the pane's last line
if (mode === "stale") process.stdout.write("stale output below the banner\\r\\n");
// the sleep listing pi-hibernate reports (applySleepAgent in pi-launcher-hibernate.mjs): the label, idle, with its state label
const SLEEP_SOURCE = "pi-hibernate";
const SLEEP_LABEL = "zz pi";
let sleepSeq = 0;
// seq for this source: the clock in microseconds, strictly increasing
const nextSleepSeq = () => { sleepSeq = Math.max(Date.now() * 1000, sleepSeq + 1); return sleepSeq; };
const sleepAgent = (asleep) => {
  const identity = { pane_id: paneId, source: SLEEP_SOURCE, agent: SLEEP_LABEL };
  if (!asleep) return rpc("pane.release_agent", { ...identity, seq: nextSleepSeq() });
  return rpc("pane.report_agent", { ...identity, state: "idle", seq: nextSleepSeq() })
    .then(() => rpc("pane.report_metadata", { ...identity, state_labels: { idle: "asleep" }, seq: nextSleepSeq() }));
};
let resendTimers = [];
if (labelled === "1") {
  await sleepAgent(true);
  // herdr ignores a report while the exiting child's agent holds the pane: the listing is sent again after it clears
  resendTimers = [1000, 3000].map((delay) => setTimeout(() => { void sleepAgent(true); }, delay));
}
const releaseSleepAgent = async () => {
  for (const timer of resendTimers) clearTimeout(timer);
  resendTimers = [];
  if (labelled === "1") await sleepAgent(false);
};
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", async (chunk) => {
  const text = chunk.toString("utf8");
  log(text);
  if (text.includes("\\u0003") || text === "q" || text === "Q") {
    await releaseSleepAgent();
    writeRecord("quit", { endReason: "quit-from-pane" });
    await clearTitle();
    process.exit(0);
  }
  if (text === "\\r" || text === "\\n" || text === "\\r\\n") {
    process.stdin.removeAllListeners("data");
    await releaseSleepAgent();
    writeRecord("awake");
    await clearTitle();
    process.stdin.setRawMode(false);
    process.stdin.pause();
    const child = spawn(piBin, [join(dirname(fileURLToPath(import.meta.url)), "child.mjs"), socket, piLog, mode, paneId, sessionFile, recordPath], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
  }
});
`;

const CHILD = `
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
const renameWithRetry = (from, to) => {
  for (let attempt = 1; ; attempt++) {
    try { renameSync(from, to); return; } catch (error) {
      if (["EPERM", "EACCES", "EBUSY"].indexOf(error?.code) < 0 || attempt >= 8) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * attempt);
    }
  }
};
const [socket, piLog, mode, paneId, sessionFile, recordPath] = process.argv.slice(2);
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socket);
    let text = "";
    sock.on("connect", () => sock.write(JSON.stringify({ id: "pi-" + Date.now(), method, params }) + "\\n"));
    sock.on("data", (chunk) => { text += chunk.toString("utf8"); if (text.includes("\\n")) { sock.destroy(); resolve(text); } });
    sock.on("error", reject);
    sock.on("end", () => resolve(text));
  });
}
let seq = Date.now();
function markReady() {
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  if (record.state !== "awake") return;
  const tmp = recordPath + "." + process.pid + ".ready.tmp";
  writeFileSync(tmp, JSON.stringify({ ...record, readyAt: new Date().toISOString() }, null, 2));
  renameWithRetry(tmp, recordPath);
}
async function report(path) {
  await rpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:pi", agent: "pi", seq: ++seq, session_start_source: "resume", agent_session_path: path });
  // pi's extension sends its session with every state report (withSessionRef), which names the agent and the session at once
  await rpc("pane.report_agent", { pane_id: paneId, source: "herdr:pi", agent: "pi", state: "idle", seq: ++seq, agent_session_path: path });
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => appendFileSync(piLog, JSON.stringify({ at: Date.now(), data: chunk.toString("utf8") }) + "\\n"));
// a stand-in pi that sleeps again: its record names a later sleep, and the launcher's zz title and banner show again
const RESLEEP = "resleep-now-please";
async function resleep() {
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const tmp = recordPath + "." + process.pid + ".resleep.tmp";
  writeFileSync(tmp, JSON.stringify({ ...record, state: "sleeping", sleptAt: new Date().toISOString(), readyAt: null, endedAt: null, wake: null }, null, 2));
  renameWithRetry(tmp, recordPath);
  await rpc("pane.report_metadata", { pane_id: paneId, source: "pi", title: "zz " + record.sessionId });
  process.stdout.write("\\u001b[?2004l\\u001b[0m" + "zz " + record.sessionId + " \\u00b7 /tmp/app \\u2014 Enter to resume, q to quit" + "\\r\\n");
}
process.stdin.on("data", (chunk) => { if (chunk.toString("utf8").includes(RESLEEP)) void resleep(); });
if (mode === "ready" || mode === "unmarked") await report(sessionFile);
if (mode === "ready") markReady();
if (mode === "wrong") await report(sessionFile + ".other");
if (mode === "late") setTimeout(() => { void report(sessionFile).then(markReady); }, 4000);
process.stdout.write("pi ready\\r\\n> ");
`;

/**
 * The typed-input stand-in: a plain process that logs each chunk typed into its pane, once it reports ready. It stands for
 * the process a shell restored after a herdr restart runs: it names no agent and sets no title.
 */
const TYPED_LOGGER = `
import { appendFileSync } from "node:fs";
const [logPath] = process.argv.slice(2);
const log = (data) => appendFileSync(logPath, JSON.stringify({ at: Date.now(), data }) + "\\n");
log("ready");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => log(chunk.toString("utf8")));
`;
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-pi-sleep-contract-"));
/** a copy of the runtime named as pi: herdr names an agent by the process it runs, so the resumed child must be called pi */
const piBin = join(root, process.platform === "win32" ? "pi.exe" : "pi");
const agentDir = join(root, "agent");
const sessionsDir = join(agentDir, "sessions");
const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
let server: { port: number; stop: () => void };
/** a server that gives up on a wake after two seconds, so the refusals are reached without the full budget */
let quick: { port: number; stop: () => void };
let base = "";
const workspaces: string[] = [];

const chunks = (path: string): string[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { data: string }).data)
  : [];

/** Polls `read` until it answers, within `ms`: a deadline, never a fixed wait. */
async function until<T>(read: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error(`no ${what} within ${ms}ms`);
}

/**
 * The chunks that carry `text` in a stand-in's input log, once one does: a submit answers before the stand-in logs what it
 * was sent, so the log is read until the text shows, and the count is taken after that.
 */
async function receivedOnce(path: string, text: string): Promise<string[]> {
  await until(async () => (chunks(path).some((data) => data.includes(text)) ? true : undefined), 15_000, `${text} in the stand-in's input`);
  return chunks(path).filter((data) => data.includes(text));
}

type SnapshotPane = { pane_id: string; hibernated?: { agent: string; title: string }; agent?: string | null; agent_status?: string };

async function sessionPane(paneId: string): Promise<SnapshotPane | undefined> {
  const { snapshot } = (await (await fetch(`${base}/api/session`)).json()) as { snapshot: { panes: SnapshotPane[] } };
  return snapshot.panes.find((pane) => pane.pane_id === paneId);
}

/** Every pane of the snapshot with this id: one, once the pane is listed once. */
async function snapshotPanesOf(paneId: string): Promise<SnapshotPane[]> {
  const { snapshot } = (await (await fetch(`${base}/api/session`)).json()) as { snapshot: { panes: SnapshotPane[] } };
  return snapshot.panes.filter((pane) => pane.pane_id === paneId);
}

/**
 * A pane running the launcher stand-in asleep: its record names the session, and the pane carries the zz
 * title. `mode` is the launcher's and the pi stand-in's: ready (its report and its readyAt marker), unmarked (its report, no marker), silent, wrong, late (its report and marker, four seconds on), or nobanner.
 */
async function sleepingPane(label: string, mode: string, draft = "", { named = false, prereport = false, labelled = false, untitled = false } = {}) {
  const created = await workspaceCreate({ cwd: root, label: `herdr-web-ui-test-pi-sleep-${label}` });
  workspaces.push(created.workspace.workspace_id);
  const pane = created.root_pane.pane_id;
  const launcherLog = join(root, `${label}-launcher.jsonl`);
  const piLog = join(root, `${label}-pi.jsonl`);
  const sessionFile = join(sessionsDir, `${label}.jsonl`);
  // the session the sleep record names: a header and one message, which the chat reads while it sleeps
  writeFileSync(sessionFile, [
    { type: "session", version: 3, id: label, timestamp: "2026-10-17T07:00:00.000Z", cwd: "/tmp/app" },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-10-17T07:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "the session before it slept" }], timestamp: 1 } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  // under node, or, for a session herdr keeps naming pi for, as a process named pi: herdr names an agent by its process
  const runtime = named ? piBin : Bun.which("node");
  if (!runtime) throw new Error("node is needed to run the launcher stand-in");
  const line = shellCommandLine(process.platform === "win32" ? "powershell" : "posix", runtime, [
    join(root, "launcher.mjs"), socketAddress(herdrSocketPath()), agentDir, sessionFile, label, launcherLog, piLog, mode, draft, piBin, prereport ? "1" : "0", labelled ? "1" : "0",
  ]);
  await paneSendText(pane, line);
  await paneSendKeys(pane, ["Enter"]);
  if (untitled) await until(async () => ((existsSync(join(agentDir, "state", "hibernate", `${label}.json`)) && recordOf(label).state === "sleeping") ? true : undefined), 30_000, `${label} asleep without a title`);
  else await until(async () => ((await sessionPane(pane))?.hibernated ? true : undefined), 30_000, `${label} asleep`).catch(async (error: unknown) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${await sleepDiagnostics(pane, label)}`);
  });
  // the title is set before the banner is drawn, and herdr's screen shows the banner later still: the card is read only once it shows
  if (mode !== "nobanner" && mode !== "untitled") await until(async () => ((await paneRead({ paneId: pane, source: "detection", format: "text" })).text.replace(/\s+/g, "").includes("Entertoresume,qtoquit") ? true : undefined), 30_000, `${label} banner on the screen`);
  // herdr names pi for a launcher run as pi a moment after its title shows, by the process or the launcher's own report:
  // the named case is tested once that holds, as a chat meets the pane
  if (named) await until(async () => ((await paneGet(pane)).agent === "pi" ? true : undefined), 15_000, `${label} named pi`);
  // the launcher's own label is listed a moment after its title, by its first report and the resends that follow it
  if (labelled) await until(async () => ((await paneGet(pane)).agent === "zz pi" ? true : undefined), 15_000, `${label} listed as the launcher's label`);
  return { pane, label, sessionFile, launcherLog, piLog };
}

/** What a sleep reads from herdr and from disk, for a failure to say why: the pane's fields, its screen's last rows, its record. */
async function sleepDiagnostics(pane: string, label: string): Promise<string> {
  const fields = await paneGet(pane).then((info) => JSON.stringify(info).slice(0, 600), (error: unknown) => `paneGet failed: ${String(error)}`);
  const rows = await paneRead({ paneId: pane, source: "detection", format: "text" }).then(
    (read) => read.text.split(/\r?\n/).filter((row) => row.trim() !== "").slice(-6).join(" | "),
    (error: unknown) => `paneRead failed: ${String(error)}`,
  );
  const file = join(agentDir, "state", "hibernate", `${label}.json`);
  const record = existsSync(file) ? readFileSync(file, "utf8").replace(/\s+/g, " ").slice(0, 400) : "no record file";
  return `pane ${fields}; screen's last rows: ${rows}; record: ${record}`;
}

/** The record the launcher stand-in wrote for a session: its launcher's pid, its state, its draft. */
function recordOf(label: string): { launcherPid: number; state: string } {
  return JSON.parse(readFileSync(join(agentDir, "state", "hibernate", `${label}.json`), "utf8")) as { launcherPid: number; state: string };
}

/** The readyAt marker pi's hibernate extension wrote into the record for this wake, if any. */
function readyAtOf(label: string): string | undefined {
  return (JSON.parse(readFileSync(join(agentDir, "state", "hibernate", `${label}.json`), "utf8")) as { readyAt?: string }).readyAt;
}

/**
 * A pane with no sleep and no launcher title, as a shell restored after a herdr restart looks: its root shell runs the
 * typed-input stand-in. Resolves once the stand-in reports ready.
 */
async function plainPane(label: string): Promise<{ pane: string; typedLog: string }> {
  const created = await workspaceCreate({ cwd: root, label: `herdr-web-ui-test-pi-sleep-${label}` });
  workspaces.push(created.workspace.workspace_id);
  const pane = created.root_pane.pane_id;
  const typedLog = join(root, `${label}-typed.jsonl`);
  const script = join(root, `${label}-typed.mjs`);
  writeFileSync(script, TYPED_LOGGER);
  const runtime = Bun.which("node");
  if (!runtime) throw new Error("node is needed to run the typed-input stand-in");
  await paneSendText(pane, shellCommandLine(process.platform === "win32" ? "powershell" : "posix", runtime, [script, typedLog]));
  await paneSendKeys(pane, ["Enter"]);
  await until(async () => (chunks(typedLog).includes("ready") ? true : undefined), 30_000, `${label} ready for typed input`);
  return { pane, typedLog };
}

/** A sleep record for `pane` that names `launcherPid` as its launcher and `sleptAt` as when its sleep began. */
function writeSleepRecord(label: string, pane: string, sleptAt: string, launcherPid: number): void {
  writeFileSync(join(agentDir, "state", "hibernate", `${label}.json`), JSON.stringify({
    version: 1, state: "sleeping", sessionId: label, sessionFile: join(sessionsDir, `${label}.jsonl`), cwd: "/tmp/app", title: label,
    nonce: `nonce-${label}`, launcherPid, childPid: null, nextDueAt: null, draft: "", sleptAt, reason: "idle", paneId: pane,
    wake: null, readyAt: null, endedAt: null,
  }, null, 2) + "\n");
}

/**
 * A message sent the way the chat or the terminal's line sends it: one submit frame, answered once.
 * `typed` is the terminal line's own flag; a chat message is sent without it.
 */
function submit(paneId: string, text: string, id: number, { port = server.port, typed = false } = {}): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const timer = setTimeout(() => reject(new Error("no submit-result within 60s")), 60_000);
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as { type: string; id?: number; ok?: boolean; code?: string };
      if (message.type === "snapshot") ws.send(JSON.stringify({ type: "submit", id, pane_id: paneId, text, payload: text, delivery: "immediate", ...(typed ? { typed: true } : {}) }));
      if (message.type === "submit-result" && message.id === id) {
        clearTimeout(timer);
        ws.close();
        resolve({ ok: message.ok === true, code: message.code });
      }
    });
    ws.addEventListener("error", () => reject(new Error("websocket failed")));
  });
}

beforeAll(async () => {
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  mkdirSync(join(agentDir, "state", "hibernate"), { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(root, "launcher.mjs"), LAUNCHER);
  writeFileSync(join(root, "child.mjs"), CHILD);
  copyFileSync(process.execPath, piBin);
  server = createServer({ port: 0, stateDir: join(root, "state") });
  quick = createServer({ port: 0, stateDir: join(root, "state-quick"), piWakeReadyMs: 2_000 });
  base = `http://localhost:${server.port}`;
}, 60_000);

afterAll(async () => {
  server.stop();
  quick.stop();
  for (const workspaceId of workspaces) await workspaceClose(workspaceId).catch(() => undefined);
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  await removeTempDir(root);
});

describe("a pi session asleep in its pane", () => {
  it("is woken by Enter alone, and the message reaches pi once", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("wake", "ready");
    expect((await sessionPane(pane))?.hibernated).toMatchObject({ agent: "pi", title: "wake" });
    expect((await sessionPane(pane))?.hibernated).not.toHaveProperty("session_path");
    // the chat reads the sleeping session's transcript from its record, not from herdr's agent
    const transcript = await fetch(`${base}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`);
    expect(transcript.status).toBe(200);
    expect(((await transcript.json()) as { source: string }).source).not.toBe("scrollback");
    expect(await submit(pane, "hello from the chat", 1)).toEqual({ ok: true, code: undefined });
    // the launcher read only the Enter: no text, and nothing that quits it
    const read = chunks(launcherLog);
    expect(read.length).toBeGreaterThan(0);
    expect(read.every((data) => data === "\r")).toBe(true);
    // pi received the message exactly once, after it reported the session it resumed
    expect(await receivedOnce(piLog, "hello from the chat")).toHaveLength(1);
    // pi wrote its readyAt marker for this wake, and the message waited for the marked reading
    expect(readyAtOf("wake")).toEqual(expect.any(String));
    expect((await sessionPane(pane))?.agent).toBe("pi");
  }, 90_000);

  it("is woken on the inferred reading when pi writes no readyAt marker, and the message reaches pi once", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("unmarked", "unmarked");
    expect(await submit(pane, "hello without a marker", 13)).toEqual({ ok: true, code: undefined });
    expect(chunks(launcherLog).every((data) => data === "\r")).toBe(true);
    expect(await receivedOnce(piLog, "hello without a marker")).toHaveLength(1);
    expect(readyAtOf("unmarked")).toBeUndefined();
  }, 90_000);

  it("gives agent_waking, typing nothing, when pi never reports itself, and refuses the next send without another Enter", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("silent", "silent");
    expect(await submit(pane, "never typed into the launcher", 2, { port: quick.port })).toEqual({ ok: false, code: "agent_waking" });
    const afterFirst = chunks(launcherLog);
    expect(afterFirst.length).toBeGreaterThan(0);
    expect(afterFirst.every((data) => data === "\r")).toBe(true);
    // the Enter has gone and pi is still starting: nothing names the pane asleep, so the marker refuses the send
    expect(await submit(pane, "a second message while pi starts", 3, { port: quick.port })).toEqual({ ok: false, code: "agent_waking" });
    expect(chunks(launcherLog)).toEqual(afterFirst);
    expect(chunks(piLog).some((data) => data.includes("never typed") || data.includes("second message"))).toBe(false);
  }, 90_000);

  it("gives agent_waking, typing nothing, while the session pi reports is another one", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("wrong", "wrong");
    expect(await submit(pane, "not for another session", 4, { port: quick.port })).toEqual({ ok: false, code: "agent_waking" });
    expect(chunks(launcherLog).every((data) => data === "\r")).toBe(true);
    expect(chunks(piLog).some((data) => data.includes("not for another session"))).toBe(false);
  }, 90_000);

  it("types the message once pi reports the session, after a late report and a refused send in between", async () => {
    const { pane, piLog } = await sleepingPane("late", "late");
    expect(await submit(pane, "held until pi is ready", 5, { port: quick.port })).toEqual({ ok: false, code: "agent_waking" });
    expect(await submit(pane, "refused while still waking", 6, { port: quick.port })).toEqual({ ok: false, code: "agent_waking" });
    // pi's own report arrives a few seconds after its start; the send goes once herdr names it, idle, on its session
    await until(async () => {
      const current = await sessionPane(pane);
      return current?.agent === "pi" && current.agent_status === "idle" ? true : undefined;
    }, 30_000, "pi named idle");
    let attempt = 7;
    await until(async () => ((await submit(pane, "held until pi is ready", attempt++)).ok ? true : undefined), 30_000, "the message sent once pi is ready");
    expect(await receivedOnce(piLog, "held until pi is ready")).toHaveLength(1);
    expect(chunks(piLog).some((data) => data.includes("refused while still waking"))).toBe(false);
  }, 120_000);

  it("offers no card while the launcher's banner is not on the pane, and refuses a Quit and a chat message then, sending nothing", async () => {
    const { pane, launcherLog } = await sleepingPane("nobanner", "nobanner");
    const card = (await (await fetch(`${base}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { prompt: { id: string; asleep?: boolean } | null };
    expect(card.prompt).toBeNull();
    const quit = await fetch(`${base}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: pane, prompt_id: "a card read earlier", option_index: 1 }),
    });
    expect(quit.status).toBe(409);
    expect(await submit(pane, "no banner, no send", 8)).toEqual({ ok: false, code: "sleep_changed" });
    expect(chunks(launcherLog)).toEqual([]);
  }, 90_000);

  it("is not annotated once its launcher is gone: a crash or a restart leaves a record that holds nothing", async () => {
    const { pane, label } = await sleepingPane("gone", "ready");
    process.kill(recordOf(label).launcherPid);
    await until(async () => ((await sessionPane(pane))?.hibernated === undefined ? true : undefined), 15_000, "annotation dropped");
  }, 90_000);

  it("offers Resume and Quit on its card, and Quit sends the launcher a lone q", async () => {
    const { pane, launcherLog } = await sleepingPane("quit", "ready");
    const card = (await (await fetch(`${base}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { prompt: { id: string; asleep?: boolean; options: { label: string }[] } | null };
    expect(card.prompt).toMatchObject({ asleep: true, options: [{ label: "Resume" }, { label: "Quit" }] });
    const answer = await fetch(`${base}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: pane, prompt_id: card.prompt!.id, option_index: 1 }),
    });
    expect(answer.status).toBe(200);
    await until(async () => (chunks(launcherLog).at(-1) === "q" ? true : undefined), 15_000, "the q");
    expect(chunks(launcherLog).filter((data) => data.includes("q"))).toEqual(["q"]);
  }, 60_000);

  it("refuses, typing nothing, while its record holds a draft pi would restore into its box", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("draft", "ready", "unsent words");
    expect(await submit(pane, "would join the draft", 9)).toEqual({ ok: false, code: "pi_draft_restored" });
    expect(chunks(launcherLog)).toEqual([]);
    expect(chunks(piLog)).toEqual([]);
  }, 60_000);

  it("is woken by an empty line from the terminal with Enter alone, and types nothing else", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("line-enter", "ready");
    expect(await submit(pane, "", 10, { typed: true })).toEqual({ ok: true, code: undefined });
    expect(chunks(launcherLog).length).toBeGreaterThan(0);
    expect(chunks(launcherLog).every((data) => data === "\r")).toBe(true);
    expect(chunks(piLog)).toEqual([]);
  }, 90_000);

  it("takes a lone q from the terminal line as the key the banner names, sent alone, with no Enter after it", async () => {
    const { pane, label, launcherLog } = await sleepingPane("line-quit", "ready");
    expect(await submit(pane, "q", 11, { typed: true })).toEqual({ ok: true, code: undefined });
    await until(async () => (recordOf(label).state === "quit" ? true : undefined), 15_000, "the launcher's quit");
    expect(chunks(launcherLog)).toEqual(["q"]);
  }, 60_000);

  it("types a terminal line of other text once pi is ready, after the Enter that woke it", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("line-text", "ready");
    expect(await submit(pane, "a line from the terminal", 12, { typed: true })).toEqual({ ok: true, code: undefined });
    expect(chunks(launcherLog).every((data) => data === "\r")).toBe(true);
    expect(chunks(piLog).join("").split("a line from the terminal").length - 1).toBe(1);
  }, 90_000);
});

describe("a pi session herdr names pi for while it sleeps", () => {
  it("is annotated once, and woken by Enter alone: the message reaches pi once, after pi's readyAt marker", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("named-ready", "ready", "", { named: true, prereport: true });
    // herdr keeps naming pi for the sleeping pane, from the process the launcher runs as
    expect((await paneGet(pane)).agent).toBe("pi");
    // one pane in the snapshot, annotated asleep, with the agent herdr names for it
    const panes = await snapshotPanesOf(pane);
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({ agent: "pi", hibernated: { agent: "pi", title: "named-ready" } });
    const card = (await (await fetch(`${base}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { prompt: { asleep?: boolean } | null };
    expect(card.prompt).toMatchObject({ asleep: true });
    // the chat reads the sleep record's transcript
    const transcript = await fetch(`${base}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`);
    expect(((await transcript.json()) as { source: string }).source).toBe("pi-transcript");
    expect(await submit(pane, "hello through a named launcher", 14)).toEqual({ ok: true, code: undefined });
    // the launcher read only the Enter, and pi received the message once
    expect(chunks(launcherLog).length).toBeGreaterThan(0);
    expect(chunks(launcherLog).every((data) => data === "\r")).toBe(true);
    expect(await receivedOnce(piLog, "hello through a named launcher")).toHaveLength(1);
    expect(readyAtOf("named-ready")).toEqual(expect.any(String));
  }, 90_000);

  it("takes Quit on its card as a lone q sent to the launcher, though herdr names pi for the pane", async () => {
    const { pane, launcherLog } = await sleepingPane("named-quit", "ready", "", { named: true, prereport: true });
    const card = (await (await fetch(`${base}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { prompt: { id: string; asleep?: boolean; options: { label: string }[] } | null };
    if (card.prompt === null) throw new Error(`no card for a sleep herdr names pi for: ${await sleepDiagnostics(pane, "named-quit")}`);
    expect(card.prompt).toMatchObject({ asleep: true, options: [{ label: "Resume" }, { label: "Quit" }] });
    const answer = await fetch(`${base}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: pane, prompt_id: card.prompt!.id, option_index: 1 }),
    });
    expect(answer.status).toBe(200);
    await until(async () => (chunks(launcherLog).at(-1) === "q" ? true : undefined), 15_000, "the q");
    expect(chunks(launcherLog).filter((data) => data.includes("q"))).toEqual(["q"]);
  }, 60_000);

  it("is woken on the rise of herdr's state counter when pi reported nothing before the sleep and writes no readyAt, and the message reaches pi once", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("named-bare", "unmarked", "", { named: true });
    // no report before the sleep: herdr names pi with no session until the woken pi reports one
    const asleep = await paneGet(pane);
    expect(asleep).toMatchObject({ agent: "pi" });
    expect(asleep.agent_session ?? null).toBeNull();
    expect(await submit(pane, "hello on the counter", 15)).toEqual({ ok: true, code: undefined });
    expect(chunks(launcherLog).every((data) => data === "\r")).toBe(true);
    expect(await receivedOnce(piLog, "hello on the counter")).toHaveLength(1);
    expect(readyAtOf("named-bare")).toBeUndefined();
  }, 90_000);

  it("gives agent_waking, typing nothing, when pi reported itself before the sleep and writes no readyAt, and refuses the next send too", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("named-silent", "unmarked", "", { named: true, prereport: true });
    expect(await submit(pane, "held while pi wakes", 16, { port: quick.port })).toEqual({ ok: false, code: "agent_waking" });
    const afterFirst = chunks(launcherLog);
    expect(afterFirst.length).toBeGreaterThan(0);
    expect(afterFirst.every((data) => data === "\r")).toBe(true);
    // the state held is the one pi reported before the sleep, so nothing shows the wake: the marker refuses the send
    expect(await submit(pane, "a second message while pi wakes", 17, { port: quick.port })).toEqual({ ok: false, code: "agent_waking" });
    expect(chunks(launcherLog)).toEqual(afterFirst);
    expect(chunks(piLog).some((data) => data.includes("held while") || data.includes("second message"))).toBe(false);
  }, 90_000);
});

describe("a pi session the launcher's own label names while it sleeps", () => {
  it("is listed as the label, annotated, and woken by Enter alone: the message reaches pi once, after its readyAt marker", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("labelled-ready", "ready", "", { labelled: true });
    // herdr lists the sleeping pane as the launcher's label, idle, with the state label asleep: the launcher reports the label
    // in a second report after the listing, so the read waits for both
    const listed = await until(async () => {
      const agent = await agentGet(pane);
      return agent.agent === "zz pi" && agent.state_labels?.["idle"] === "asleep" ? agent : undefined;
    }, 15_000, "the launcher's listing with its state label");
    expect(listed).toMatchObject({ agent: "zz pi", agent_status: "idle" });
    expect(listed.state_labels).toEqual({ idle: "asleep" });
    // one pane in the snapshot, annotated asleep: the label is no agent of its own
    const panes = await snapshotPanesOf(pane);
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({ agent: "zz pi", hibernated: { agent: "pi", title: "labelled-ready" } });
    const card = (await (await fetch(`${base}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { prompt: { asleep?: boolean } | null };
    expect(card.prompt).toMatchObject({ asleep: true });
    expect(await submit(pane, "hello through the label", 18)).toEqual({ ok: true, code: undefined });
    // the launcher read only the Enter, and pi received the message once
    expect(chunks(launcherLog).length).toBeGreaterThan(0);
    expect(chunks(launcherLog).every((data) => data === "\r")).toBe(true);
    expect(await receivedOnce(piLog, "hello through the label")).toHaveLength(1);
    expect(readyAtOf("labelled-ready")).toEqual(expect.any(String));
  }, 90_000);

  it("is woken by Enter alone with no readyAt marker, and the message reaches pi once when pi reports itself after the listing is released", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("labelled-bare", "unmarked", "", { labelled: true });
    expect((await paneGet(pane)).agent).toBe("zz pi");
    expect(await submit(pane, "hello without a marker or a rise", 19)).toEqual({ ok: true, code: undefined });
    expect(chunks(launcherLog).every((data) => data === "\r")).toBe(true);
    expect(await receivedOnce(piLog, "hello without a marker or a rise")).toHaveLength(1);
    expect(readyAtOf("labelled-bare")).toBeUndefined();
  }, 90_000);

  it("takes Quit on its card as a lone q, and the launcher releases its listing before it exits", async () => {
    const { pane, launcherLog } = await sleepingPane("labelled-quit", "ready", "", { labelled: true });
    const card = (await (await fetch(`${base}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { prompt: { id: string; asleep?: boolean; options: { label: string }[] } | null };
    expect(card.prompt).toMatchObject({ asleep: true, options: [{ label: "Resume" }, { label: "Quit" }] });
    const answer = await fetch(`${base}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: pane, prompt_id: card.prompt!.id, option_index: 1 }),
    });
    expect(answer.status).toBe(200);
    await until(async () => (chunks(launcherLog).at(-1) === "q" ? true : undefined), 15_000, "the q");
    expect(chunks(launcherLog).filter((data) => data.includes("q"))).toEqual(["q"]);
    await until(async () => ((await paneGet(pane)).agent !== "zz pi" ? true : undefined), 15_000, "the listing released");
  }, 60_000);
});

describe("a sleep or a wake that settles while a message waits", () => {
  it("does not paste a message sent at once after a card's Resume into pi, and types it once pi is ready", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("resume-then", "ready");
    const card = (await (await fetch(`${base}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { prompt: { id: string; asleep?: boolean } | null };
    expect(card.prompt).toMatchObject({ asleep: true });
    const resume = await fetch(`${base}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: pane, prompt_id: card.prompt!.id, option_index: 0 }),
    });
    expect(resume.status).toBe(200);
    // at once: refused while the Resume's wake holds the pane, or sent once pi is ready; the launcher reads only Enter either way
    let attempt = 20;
    const early = await submit(pane, "typed straight after Resume", attempt++);
    expect(early.ok || early.code === "agent_waking").toBe(true);
    if (!early.ok) await until(async () => ((await submit(pane, "typed straight after Resume", attempt++)).ok ? true : undefined), 30_000, "the message sent once pi is ready");
    expect(chunks(launcherLog).every((data) => data === "\r")).toBe(true);
    expect(await receivedOnce(piLog, "typed straight after Resume")).toHaveLength(1);
  }, 90_000);

  it("offers no card and types nothing while the launcher has set no title for its sleep, and refuses the message as agent_waking", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("untitled", "untitled", "", { untitled: true });
    const card = (await (await fetch(`${base}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { prompt: unknown };
    expect(card.prompt).toBeNull();
    expect(await submit(pane, "typed while the sleep settles", 22)).toEqual({ ok: false, code: "agent_waking" });
    expect(chunks(launcherLog)).toEqual([]);
    expect(chunks(piLog)).toEqual([]);
  }, 90_000);

  it("offers no card once output shows below the banner, and refuses a message with sleep_changed, nothing sent", async () => {
    const { pane, launcherLog, piLog } = await sleepingPane("stale", "stale");
    const card = (await (await fetch(`${base}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { prompt: unknown };
    expect(card.prompt).toBeNull();
    // an answer to the card read before the output came: that card is gone, so the answer is refused
    const answer = await fetch(`${base}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: pane, prompt_id: "a card read earlier", option_index: 1 }),
    });
    expect(answer.status).toBe(409);
    expect(await submit(pane, "output shows below the banner", 23)).toEqual({ ok: false, code: "sleep_changed" });
    expect(chunks(launcherLog)).toEqual([]);
    expect(chunks(piLog)).toEqual([]);
  }, 90_000);

  it("drops the wake a refused send began once the pane sleeps again, so the next send wakes the new sleep", async () => {
    const { pane, piLog } = await sleepingPane("resleep", "silent");
    expect(await submit(pane, "held by the first wake", 24, { port: quick.port })).toEqual({ ok: false, code: "agent_waking" });
    const enters = chunks(piLog).filter((data) => data === "\r").length;
    // the stand-in pi sleeps again: a later sleep record, and the launcher's zz title and banner show again
    await paneSendText(pane, "resleep-now-please");
    await until(async () => ((await sessionPane(pane))?.hibernated ? true : undefined), 30_000, "the second sleep");
    expect(await submit(pane, "after the second sleep", 25, { port: quick.port })).toEqual({ ok: false, code: "agent_waking" });
    // the second wake's Enter reached the pane, so the first wake's marker did not refuse the send before it
    expect(chunks(piLog).filter((data) => data === "\r").length).toBe(enters + 1);
    expect(chunks(piLog).some((data) => data.includes("after the second sleep") || data.includes("held by the first wake"))).toBe(false);
  }, 120_000);
});

describe("a sleep record with no launcher title, by how long ago its sleep began", () => {
  it("does not hold a pane whose sleep began an hour ago, though its pid is alive, and the pane takes a typed line", async () => {
    const { pane, typedLog } = await plainPane("reused");
    // the record names this test's own process as its launcher: alive, and no launcher, as a reused pid is
    writeSleepRecord("reused", pane, new Date(Date.now() - 3_600_000).toISOString(), process.pid);
    expect(await submit(pane, "typed after a reused pid", 40, { typed: true })).toEqual({ ok: true, code: undefined });
    await until(async () => (chunks(typedLog).some((data) => data.includes("typed after a reused pid")) ? true : undefined), 15_000, "the typed line in the pane");
  }, 90_000);

  it("refuses a typed line in a pane whose sleep began within the wait, and types nothing", async () => {
    const { pane, typedLog } = await plainPane("recent");
    writeSleepRecord("recent", pane, new Date().toISOString(), process.pid);
    expect(await submit(pane, "typed while the sleep starts", 41, { typed: true })).toEqual({ ok: false, code: "agent_waking" });
    expect(chunks(typedLog).some((data) => data.includes("typed while the sleep starts"))).toBe(false);
  }, 90_000);

  it("holds a pane for a wake the server began at any age of the sleep, and refuses the next send without another Enter", async () => {
    const { pane, label, launcherLog } = await sleepingPane("old-wake", "silent");
    // the sleep began an hour ago: the age bound reaches no wake this server began
    // rewritten by a rename, as the launcher writes its record: an in-place write can be served from the scan cache for up to
    // RECORD_CACHE_MS, while a rename moves the directory's time, so the server's next scan reads the backdated sleep at once
    const file = join(agentDir, "state", "hibernate", `${label}.json`);
    const backdated = { ...(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>), sleptAt: new Date(Date.now() - 3_600_000).toISOString() };
    writeFileSync(`${file}.backdated.tmp`, JSON.stringify(backdated, null, 2) + "\n");
    renameSync(`${file}.backdated.tmp`, file);
    expect(await submit(pane, "held at any age", 42, { port: quick.port })).toEqual({ ok: false, code: "agent_waking" });
    const afterFirst = chunks(launcherLog);
    expect(afterFirst.every((data) => data === "\r")).toBe(true);
    // the launcher has resumed and written the record awake, so no sleep holds the pane: only the wake does
    expect(recordOf("old-wake").state).toBe("awake");
    expect(await submit(pane, "held at any age, again", 43, { port: quick.port })).toEqual({ ok: false, code: "agent_waking" });
    expect(chunks(launcherLog)).toEqual(afterFirst);
  }, 90_000);
});
