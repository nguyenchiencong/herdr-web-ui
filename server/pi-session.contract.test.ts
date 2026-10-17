import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import type { InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import { herdrSocketPath, paneRead, paneSendKeys, paneSendText, sessionSnapshot, socketAddress, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { shellCommandLine } from "./shell-agent.ts";
import { removeTempDir } from "../scripts/test-herdr.ts";

/**
 * Contract test for pi's `/resume` session picker (SessionSelectorComponent, pi 1.3.0) against the real herdr.
 * A stand-in pi (FAKE_SOURCE below, run by a copy of node named pi, as the sleep test runs its launcher) draws
 * the picker over 23 synthetic sessions, in the layout of server/fixtures/pi-session-picker, and answers each key
 * as pi does. The card is read with GET /api/pane/prompt and answered with POST /api/pane/prompt/answer, through a
 * createServer on port 0. What is under test: the keys each answer sends, the landing each one waits for, the
 * refusals, and the keys a picker is never sent (delete, rename, sort).
 */

/**
 * The stand-in pi, written beside the test and run as a copy of node named pi (the sleep test's technique). It draws
 * pi 1.3.0's /resume picker as server/fixtures/pi-session-picker lays it out, over the sessions in its config file, and
 * it reports itself to herdr as pi's extension does at session start. Up and Down move the cursor, and the ten-row
 * window follows it: start = max(0, min(cursor - 5, total - 10)). Tab toggles Current folder and All; typed text filters
 * the rows; Ctrl+K and Ctrl+U clear the search line; Enter opens the cursor's session and Escape closes the picker, each
 * drawing the editor. Every raw input chunk is logged before it is handled; any other key does nothing.
 */
const FAKE_SOURCE = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
import net from "node:net";

const [socket, configPath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const PAGE = 10;
// the fixture's 120 columns, or the pane's own: node reports one column less than a Windows pane has
const WIDTH = Math.min(120, process.stdout.columns || 120);
const state = {
  mode: "picker",
  scope: config.scope,
  search: config.search,
  caret: config.search.length,
  cursor: config.cursor,
  info: "",
};

const rule = () => "─".repeat(WIDTH);
const NAMED = new Map([
  ["\x1b[A", "up"], ["\x1bOA", "up"], ["\x1b[B", "down"], ["\x1bOB", "down"],
  ["\r", "enter"], ["\t", "tab"], ["\x1b", "esc"], ["\x0b", "ctrl+k"], ["\x15", "ctrl+u"], ["\x7f", "backspace"],
]);

/** the sessions the picker lists: those of the scope, filtered by the search text */
function listed() {
  const needle = state.search.toLowerCase();
  return config.sessions.filter((session) => (state.scope === "all" || session.folder === config.cwd)
    && session.label.toLowerCase().includes(needle));
}

function rowLine(session, selected) {
  const left = (selected ? "› " : "  ") + session.label;
  const right = (state.scope === "all" ? session.folder + " " : "") + session.count + " " + session.age;
  return left + " ".repeat(Math.max(1, WIDTH - left.length - right.length)) + right;
}

function pickerLines() {
  const list = listed();
  const total = list.length;
  state.cursor = Math.min(state.cursor, Math.max(0, total - 1));
  const first = Math.max(0, Math.min(state.cursor - 5, total - PAGE));
  const title = state.scope === "all" ? "Resume Session (All)" : "Resume Session (Current Folder)";
  const marks = state.scope === "all" ? "○ Current Folder | ◉ All" : "◉ Current Folder | ○ All";
  const right = marks + "  Name: All  Sort: Threaded";
  const lines = [
    "",
    rule(),
    "",
    title + " ".repeat(Math.max(1, WIDTH - title.length - right.length)) + right,
    'tab scope · re:<pattern> regex · "phrase" exact',
    "ctrl+s sort · ctrl+n named · ctrl+d delete · ctrl+p path (off) · ctrl+r rename",
    "",
    state.search === "" ? ">" : "> " + state.search,
    "",
  ];
  if (total === 0) lines.push(state.scope === "all" ? "  No sessions." : "  No sessions in current folder. Press Tab to view all.");
  list.slice(first, first + PAGE).forEach((session, offset) => lines.push(rowLine(session, first + offset === state.cursor)));
  if (total > PAGE) lines.push("  (" + (state.cursor + 1) + "/" + total + ")");
  return lines.concat(["", rule(), "~/Dev/app", "0.0%/215k (auto)  some-model"]);
}

function editorLines() {
  return ["", rule(), state.info, "", ">", "", rule(), "~/Dev/app", "0.0%/215k (auto)  some-model"];
}

function render() {
  const lines = state.mode === "picker" ? pickerLines() : editorLines();
  // one write per frame, drawn over the last one. A line is erased before it is drawn, not after: a line that fills the
  // last column leaves the cursor waiting in that column, and an erase there takes the line's last character.
  process.stdout.write("\x1b[H" + lines.map((line) => "\x1b[2K" + line).join("\r\n") + "\r\n\x1b[J");
}

/** a chunk as keys: each escape sequence whole, every other character by itself */
function tokensOf(text) {
  const tokens = [];
  for (let at = 0; at < text.length;) {
    const sequence = /^\x1b(?:\[[0-?]*[ -\/]*[@-~]|O[@-~])/.exec(text.slice(at))?.[0];
    const token = sequence ?? text[at];
    tokens.push(token);
    at += token.length;
  }
  return tokens;
}

function setSearch(value, caret) {
  if (value !== state.search) state.cursor = 0;
  state.search = value;
  state.caret = caret;
}

function press(token) {
  if (state.mode !== "picker") return;
  const key = NAMED.get(token);
  const total = listed().length;
  if (key === "up") state.cursor = Math.max(0, state.cursor - 1);
  else if (key === "down") state.cursor = Math.min(Math.max(0, total - 1), state.cursor + 1);
  else if (key === "tab") {
    state.scope = state.scope === "all" ? "current" : "all";
    state.cursor = 0;
  } else if (key === "enter") {
    const session = listed()[state.cursor];
    if (session !== undefined) {
      appendFileSync(config.openedLog, JSON.stringify({ label: session.label, path: session.path }) + "\n");
      state.mode = "editor";
      state.info = "resumed " + session.label;
    }
  } else if (key === "esc") {
    state.mode = "editor";
    state.info = "";
  } else if (key === "ctrl+k") setSearch(state.search.slice(0, state.caret), state.caret);
  else if (key === "ctrl+u") setSearch(state.search.slice(state.caret), 0);
  else if (key === "backspace") {
    if (state.caret > 0) setSearch(state.search.slice(0, state.caret - 1) + state.search.slice(state.caret), state.caret - 1);
  } else if (token.length === 1 && token >= " " && token <= "~") {
    setSearch(state.search.slice(0, state.caret) + token + state.search.slice(state.caret), state.caret + 1);
  }
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  appendFileSync(config.inputLog, JSON.stringify({ at: Date.now(), hex: chunk.toString("hex") }) + "\n");
  for (const token of tokensOf(chunk.toString("utf8"))) press(token);
  render();
});

const paneId = process.env.HERDR_PANE_ID ?? "";
let seq = Date.now();
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socket);
    let text = "";
    sock.on("connect", () => sock.write(JSON.stringify({ id: "pi-" + seq, method, params }) + "\n"));
    sock.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (text.includes("\n")) { sock.destroy(); resolve(text); }
    });
    sock.on("error", reject);
    sock.on("end", () => resolve(text));
  });
}

async function report() {
  const path = config.currentSession;
  for (const [method, extra] of [
    ["pane.report_agent_session", { session_start_source: "new", agent_session_path: path }],
    ["pane.report_agent", { state: "idle", agent_session_path: path }],
  ]) {
    const reply = await rpc(method, { pane_id: paneId, source: "herdr:pi", agent: "pi", seq: ++seq, ...extra });
    if (reply.includes('"error"')) appendFileSync(config.errorLog, reply);
  }
}

render();
report().catch((error) => appendFileSync(config.errorLog, String(error.stack ?? error) + "\n"));
`;const CWD = "C:/Users/x/Dev/app";
const MESSAGES = ["wire the sleep card", "hello", "review the picker", "fix the composer scroll on iPhone when the keyboard opens"];
const AGES = ["now", "5m", "2h", "1d", "2d", "3d", "1w", "2w", "1mo"];
/** the synthetic list: 23 sessions numbered from 1, all in the current folder, with fictional paths */
const SESSIONS = Array.from({ length: 23 }, (_, index) => ({
  label: `session ${index + 1}: ${MESSAGES[index % MESSAGES.length]!}`,
  path: `C:/Users/x/.pi/agent/sessions/app/session-${index + 1}.jsonl`,
  folder: CWD,
  count: 2 * index + 5,
  age: AGES[index % AGES.length]!,
}));

/** the bytes herdr sends for its key names, as the pane's program reads them (probed on herdr 0.9.4) */
const NAMES = new Map([
  ["\x1b[A", "up"], ["\x1bOA", "up"], ["\x1b[B", "down"], ["\x1bOB", "down"],
  ["\r", "enter"], ["\t", "tab"], ["\x1b", "esc"], ["\x0b", "ctrl+k"], ["\x15", "ctrl+u"], ["\x7f", "backspace"],
]);
/** the keys the picker's answers may send: any other key belongs to pi's own picker, and no answer here sends one */
const ALLOWED = new Set(["up", "down", "enter", "esc", "tab", "ctrl+k", "ctrl+u"]);
/** the bytes of Ctrl+N (named), Ctrl+P (path), Ctrl+D (delete), Ctrl+R (rename) and Ctrl+S (sort), as the footer names them */
const RAW_NEVER = ["\x0e", "\x10", "\x04", "\x12", "\x13"];

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-pi-session-contract-"));
/** a copy of node named as pi: herdr names an agent after its process, so the stand-in runs under the name pi */
const piBin = join(root, process.platform === "win32" ? "pi.exe" : "pi");
const FAKE = join(root, "pi-session-fake.mjs");
let server: { port: number; stop: () => void } | undefined;
let base = "";
const workspaces: string[] = [];
/** every picker's input log: the checks on the keys sent are made over all of them */
const logs: string[] = [];

/** Polls `read` until it answers, within `ms`: a deadline, never a fixed wait. */
async function until<T>(read: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error(`no ${what} within ${ms}ms`);
}

/** The raw input a picker's stand-in logged, joined in order: each chunk's bytes as herdr wrote them. */
function inputOf(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line) => Buffer.from((JSON.parse(line) as { hex: string }).hex, "hex").toString("utf8"))
    .join("");
}

/**
 * The keys in an input string, in order: a named key by its name, a run of typed characters as one `text:` entry,
 * and any other byte as `raw:`, so that it can never pass for a key.
 */
function keysIn(input: string): string[] {
  const keys: string[] = [];
  let typed = "";
  for (let at = 0; at < input.length;) {
    const sequence = /^\x1b(?:\[[0-?]*[ -\/]*[@-~]|O[@-~])/.exec(input.slice(at))?.[0];
    const token = sequence ?? input[at]!;
    at += token.length;
    if (token >= " " && token <= "~") {
      typed += token;
      continue;
    }
    if (typed !== "") keys.push(`text:${typed}`);
    typed = "";
    keys.push(NAMES.get(token) ?? `raw:${JSON.stringify(token)}`);
  }
  if (typed !== "") keys.push(`text:${typed}`);
  return keys;
}

const keysOf = (path: string): string[] => keysIn(inputOf(path));

/** The sessions a picker's stand-in opened, in order: the label and the path of each. */
function openedOf(path: string): { label: string; path: string }[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { label: string; path: string });
}

async function cardOf(paneId: string): Promise<InteractivePrompt | null> {
  const response = await fetch(`${base}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { prompt: InteractivePrompt | null }).prompt;
}

/** The card once `holds` is true of it: the screen takes the keys after an answer returns, so this is a deadline, not a wait. */
async function cardWhere(paneId: string, holds: (prompt: InteractivePrompt) => boolean): Promise<InteractivePrompt> {
  return until(async () => {
    const next = await cardOf(paneId);
    return next && holds(next) ? next : undefined;
  }, 10_000, "the card");
}

async function answer(paneId: string, promptId: string, body: Omit<PromptAnswer, "pane_id" | "prompt_id">): Promise<Response> {
  return fetch(`${base}/api/pane/prompt/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane_id: paneId, prompt_id: promptId, ...body }),
  });
}

/** An answer to a card, as the chat sends it: the route must take it. */
async function answered(paneId: string, prompt: InteractivePrompt, body: Omit<PromptAnswer, "pane_id" | "prompt_id">): Promise<void> {
  const response = await answer(paneId, prompt.id, body);
  if (response.status !== 200) throw new Error(`the answer was refused: ${response.status} ${await response.text()}`);
}

async function screenOf(paneId: string): Promise<string> {
  return (await paneRead({ paneId, source: "detection", format: "text" })).text;
}

/** The session number on the cursor's row, read off the screen (`› session N: …`), or null when no picker shows. */
async function cursorOn(paneId: string): Promise<number | null> {
  const row = /^› session (\d+):/m.exec(await screenOf(paneId));
  return row ? Number(row[1]) : null;
}

const arrows = (key: "up" | "down", count: number): string[] => Array.from({ length: count }, () => key);
const actionIds = (prompt: InteractivePrompt): string[] | undefined => prompt.actions?.map((action) => action.id);

interface Picker { pane: string; input: string; opened: string; prompt: InteractivePrompt }

/**
 * A pane running the stand-in pi with its picker on the screen. The card is read once the picker shows, and the
 * pane is checked to be named pi by herdr, which the stand-in reports at its start.
 */
async function openPicker(name: string, state: { cursor?: number; scope?: "current" | "all"; search?: string } = {}): Promise<Picker> {
  const created = await workspaceCreate({ cwd: root, label: `herdr-web-ui-test-pi-session-${name}` });
  workspaces.push(created.workspace.workspace_id);
  const pane = created.root_pane.pane_id;
  const config = join(root, `${name}.config.json`);
  const input = join(root, `${name}.input.jsonl`);
  const opened = join(root, `${name}.opened.jsonl`);
  writeFileSync(config, JSON.stringify({
    sessions: SESSIONS,
    cwd: CWD,
    cursor: state.cursor ?? 0,
    scope: state.scope ?? "current",
    search: state.search ?? "",
    currentSession: SESSIONS[0]!.path,
    inputLog: input,
    openedLog: opened,
    errorLog: join(root, `${name}.error.log`),
  }));
  logs.push(input);
  const shell = process.platform === "win32" ? "powershell" : "posix";
  await paneSendText(pane, shellCommandLine(shell, piBin, [FAKE, socketAddress(herdrSocketPath()), config]));
  await paneSendKeys(pane, ["enter"]);
  const prompt = await until(async () => (await cardOf(pane)) ?? undefined, 30_000, `the ${name} picker`).catch(async (error: Error) => {
    throw new Error(`${error.message}; the pane shows:\n${await screenOf(pane)}`);
  });
  expect((await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane)?.agent).toBe("pi");
  return { pane, input, opened, prompt };
}

beforeAll(async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("node is needed to run the pi stand-in");
  copyFileSync(node, piBin);
  writeFileSync(FAKE, FAKE_SOURCE);
  server = createServer({ port: 0, stateDir: join(root, "state"), piAgentDir: join(root, "agent") });
  base = `http://localhost:${server.port}`;
}, 60_000);

afterAll(async () => {
  server?.stop();
  for (const workspaceId of workspaces) await workspaceClose(workspaceId).catch(() => undefined);
  await removeTempDir(root);
});

describe("pi's /resume session picker, answered through the prompt route in a herdr pane", () => {
  it("reads the current folder's sessions as pi windows them: the first ten, the cursor on the first, Later offered", async () => {
    const { prompt } = await openPicker("list");
    expect(prompt).toMatchObject({
      agent: "pi",
      kind: "question",
      question: "Resume a session in this folder",
      multi_select: false,
      window: { first: 0, total: 23 },
      search: { value: "" },
    });
    expect(prompt.options.map((option) => option.label)).toEqual(SESSIONS.slice(0, 10).map((session) => session.label));
    expect(actionIds(prompt)).toEqual(["scope", "later", "cancel"]);
  }, 90_000);

  it("taps a row below the cursor across the window's scroll: eight arrows down, one Enter, and that session opens", async () => {
    const { pane, input, opened, prompt } = await openPicker("below");
    // option 8 is session 9: the window's first row moves from the sixth arrow on
    await answered(pane, prompt, { option_index: 8 });
    await until(async () => (openedOf(opened).length > 0 ? true : undefined), 10_000, "the session opened");
    expect(keysOf(input)).toEqual([...arrows("down", 8), "enter"]);
    expect(openedOf(opened)).toEqual([{ label: SESSIONS[8]!.label, path: SESSIONS[8]!.path }]);
    await until(async () => ((await cardOf(pane)) === null ? true : undefined), 10_000, "the editor after Enter");
  }, 90_000);

  it("taps a row above the cursor across the window's scroll: five arrows up, one Enter, and that session opens", async () => {
    // the cursor starts on session 15 (index 14): the window starts at session 10, which is option 0
    const { pane, input, opened, prompt } = await openPicker("above", { cursor: 14 });
    expect(prompt.window).toEqual({ first: 9, total: 23 });
    await answered(pane, prompt, { option_index: 0 });
    await until(async () => (openedOf(opened).length > 0 ? true : undefined), 10_000, "the session opened");
    expect(keysOf(input)).toEqual([...arrows("up", 5), "enter"]);
    expect(openedOf(opened)).toEqual([{ label: SESSIONS[9]!.label, path: SESSIONS[9]!.path }]);
  }, 90_000);

  it("pages with Later and Earlier, and the cursor lands on the row the card's window says", async () => {
    const { pane, input, prompt } = await openPicker("pages");
    // a page moves the cursor ten rows, or to the end or the start of the list; the card says where its window starts
    const steps: { action: "later" | "earlier"; cursor: number; first: number; ids: string[]; arrow: "up" | "down" }[] = [
      { action: "later", cursor: 10, first: 5, ids: ["scope", "earlier", "later", "cancel"], arrow: "down" },
      { action: "later", cursor: 20, first: 13, ids: ["scope", "earlier", "cancel"], arrow: "down" },
      { action: "earlier", cursor: 10, first: 5, ids: ["scope", "earlier", "later", "cancel"], arrow: "up" },
      { action: "earlier", cursor: 0, first: 0, ids: ["scope", "later", "cancel"], arrow: "up" },
    ];
    let card = prompt;
    let sent: string[] = [];
    for (const step of steps) {
      await answered(pane, card, { action: step.action });
      sent = [...sent, ...arrows(step.arrow, 10)];
      card = await until(async () => {
        const next = await cardOf(pane);
        return next && next.window?.first === step.first && (await cursorOn(pane)) === step.cursor + 1 ? next : undefined;
      }, 10_000, `the cursor on session ${step.cursor + 1}`);
      expect(actionIds(card)).toEqual(step.ids);
      expect(keysOf(input)).toEqual(sent);
    }
  }, 90_000);

  it("sends Tab for scope: the next card shows All with each row's folder, and a second Tab shows Current folder again", async () => {
    const { pane, input, prompt } = await openPicker("scope");
    await answered(pane, prompt, { action: "scope" });
    const all = await cardWhere(pane, (next) => next.question === "Resume a session from any folder");
    expect(all.actions?.[0]).toEqual({ id: "scope", label: "Current folder", to: "current" });
    expect(all.options[0]?.description).toBe(`${CWD} · ${SESSIONS[0]!.count} messages`);
    expect(all.window).toEqual({ first: 0, total: 23 });
    await answered(pane, all, { action: "scope" });
    const current = await cardWhere(pane, (next) => next.question === "Resume a session in this folder");
    expect(current.actions?.[0]).toEqual({ id: "scope", label: "All", to: "all" });
    expect(current.options[0]?.description).toBe(`${SESSIONS[0]!.count} messages`);
    expect(keysOf(input)).toEqual(["tab", "tab"]);
  }, 90_000);

  it("sends Escape for Cancel, and the picker closes into the editor", async () => {
    const { pane, input, prompt } = await openPicker("cancel");
    await answered(pane, prompt, { action: "cancel" });
    await until(async () => ((await cardOf(pane)) === null ? true : undefined), 10_000, "the editor");
    expect(keysOf(input)).toEqual(["esc"]);
    expect(await screenOf(pane)).toContain("some-model");
  }, 90_000);

  it("clears the search line with Ctrl+K and Ctrl+U, types the text with no Enter, and the next card shows the filtered rows", async () => {
    const { pane, input, prompt } = await openPicker("search");
    await answered(pane, prompt, { search_text: "session 1" });
    const filtered = await cardWhere(pane, (next) => next.search?.value === "session 1");
    expect(keysOf(input)).toEqual(["ctrl+k", "ctrl+u", "text:session 1"]);
    expect(filtered.window).toEqual({ first: 0, total: 11 });
    expect(filtered.options.map((option) => option.label)).toEqual(
      SESSIONS.filter((session) => session.label.includes("session 1")).slice(0, 10).map((session) => session.label),
    );
    expect(actionIds(filtered)).toEqual(["scope", "later", "cancel"]);
  }, 90_000);

  it("an empty search sends Ctrl+K and Ctrl+U alone, and the card lists every session again", async () => {
    const { pane, input, prompt } = await openPicker("clear", { search: "session 1" });
    expect(prompt.search).toEqual({ value: "session 1" });
    await answered(pane, prompt, { search_text: "" });
    const cleared = await cardWhere(pane, (next) => next.search?.value === "");
    expect(keysOf(input)).toEqual(["ctrl+k", "ctrl+u"]);
    expect(cleared.window).toEqual({ first: 0, total: 23 });
  }, 90_000);

  it("refuses an answer whose prompt id is stale after the screen changed: 409 prompt_changed, and no key sent", async () => {
    const { pane, input, prompt } = await openPicker("stale");
    // the screen changes under the card: this key comes from the pane, not from an answer
    await paneSendKeys(pane, ["tab"]);
    await cardWhere(pane, (next) => next.id !== prompt.id);
    const before = keysOf(input);
    expect(before).toEqual(["tab"]);
    const response = await answer(pane, prompt.id, { option_index: 0 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "prompt_changed" } });
    // fixed wait: a refused answer has no event to wait for, so this gives a key it might have sent time to arrive
    await Bun.sleep(500);
    expect(keysOf(input)).toEqual(before);
  }, 90_000);

  it("never sends Ctrl+D, Ctrl+R or Ctrl+S, nor any key outside its answers, whatever it is asked", async () => {
    const { pane, input, opened, prompt } = await openPicker("keys");
    const answers: Omit<PromptAnswer, "pane_id" | "prompt_id">[] = [
      { action: "scope" },
      { action: "scope" },
      { action: "later" },
      { action: "earlier" },
      { search_text: "session 2" },
      { search_text: "" },
    ];
    let card = prompt;
    for (const body of answers) {
      const previous = card.id;
      await answered(pane, card, body);
      card = await cardWhere(pane, (next) => next.id !== previous);
    }
    await answered(pane, card, { option_index: 1 });
    await until(async () => (openedOf(opened).length > 0 ? true : undefined), 10_000, "the session opened");
    expect(keysOf(input)).toEqual([
      "tab", "tab", ...arrows("down", 10), ...arrows("up", 10), "ctrl+k", "ctrl+u", "text:session 2", "ctrl+k", "ctrl+u", "down", "enter",
    ]);
    expect(openedOf(opened)).toEqual([{ label: SESSIONS[1]!.label, path: SESSIONS[1]!.path }]);
    // every picker opened in this run: only keys its answers send, and none of the keys its footer names for delete, rename or sort
    for (const path of logs) {
      const text = inputOf(path);
      expect(keysIn(text).filter((key) => !key.startsWith("text:") && !ALLOWED.has(key))).toEqual([]);
      expect(RAW_NEVER.filter((byte) => text.includes(byte))).toEqual([]);
    }
  }, 90_000);
});
